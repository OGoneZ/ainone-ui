// @vitest-environment jsdom
// App 编排测试：侧栏工作区分组、新建会话弹层、历史去重、工作区状态。
// 用 mockTauriIpc 假后端驱动，不依赖 Tauri 运行时。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { mockTauriIpc } from "@/test/mockIpc";
import { useSessionStore } from "@/store/sessionStore";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({ key: index, index, start: 0 }));
    return { getTotalSize: () => opts.count * 80, getVirtualItems: () => items, measureElement: () => {} };
  },
}));

// flexlayout 的 Layout 组件在 jsdom 高度为 0 时不渲染 tab content（同理 react-virtual）。
// 组件测试关心的是「tab 增删/去重/factory 渲染 ChatPanel」编排逻辑，不关心其 DOM 布局测量，
// 故 mock 掉 Layout：保留真实 Model/Actions/DockLocation（addTabToModel 逻辑被测），
// 只把 model 里所有 tab 平铺渲染出来。
vi.mock("flexlayout-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("flexlayout-react")>();
  const React = await import("react");
  return {
    ...actual,
    Layout: ({ model, factory }: { model: any; factory: (n: any) => React.ReactNode }) => {
      const [, force] = React.useReducer((x: number) => x + 1, 0);
      React.useEffect(() => {
        model?.addChangeListener(() => force());
      }, [model]);
      const tabs: any[] = [];
      model?.visitNodes((n: any) => {
        if (n.getType() === "tab") tabs.push(n);
      });
      return React.createElement(
        "div",
        { "data-testid": "flexlayout" },
        tabs.map((n) => React.createElement("div", { key: n.getId() }, factory(n))),
      );
    },
  };
});

const WS = [
  { id: "ws-dev", name: "dev", cwd: "/Users/me/dev", created_ms: 1 },
  { id: "ws-asr", name: "asr-server", cwd: "/Users/me/dev/asr-server", created_ms: 2 },
];
const SESSIONS = [
  { session_id: "s-1", adapter_id: "omp", title: "你好", cwd: "/Users/me/dev", workspace_id: "ws-dev", mtime_ms: 10 },
  { session_id: "s-2", adapter_id: "omp", title: "总结目录", cwd: "/Users/me/dev/asr-server", workspace_id: "ws-asr", mtime_ms: 20 },
];

function defaultHandlers() {
  return {
    adapters_list: () => [
      { id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: "#7c3aed" },
      { id: "claude-code", name: "Claude Code", program: "claude-agent-acp", args: [], cwd: ".", logo: "#d97706" },
    ],
    adapter_status: () => ({ available: true, resolved_path: "/usr/local/bin/omp", source: "ProcessPath" }),
    sessions_list: () => SESSIONS,
    workspaces_list: () => WS,
    log_read: () => "",
    default_cwd: () => "/",
    // F-9-4 文件树（App 有 cwd 的 Tab 会调）：返回空数组
    workspace_list_dir: () => [],
  };
}

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({ runtime: {}, commands: {} });
});
afterEach(cleanup);

describe("App 编排（工作区分组）", () => {
  it("侧栏按工作区分组渲染会话", async () => {
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<App />);

    // 两个工作区父级标题
    expect(await screen.findByText("dev")).toBeInTheDocument();
    expect(await screen.findByText("asr-server")).toBeInTheDocument();
    // 会话标题出现
    expect(await screen.findByText("你好")).toBeInTheDocument();
    expect(await screen.findByText("总结目录")).toBeInTheDocument();
  });

  it("点「＋ 新建会话」弹出弹层，选 harness + 工作区 → 开始对话生成 Tab", async () => {
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<App />);

    const user = userEvent.setup();
    // P26 R1 删 toolbar 后入口 = 侧栏头部「＋」按钮（aria-label 新建工作区）
    const newBtn = await screen.findByRole("button", { name: "新建工作区" });
    await user.click(newBtn);

    // 弹层出现
    const modal = await screen.findByRole("heading", { name: "新建会话" });
    expect(modal).toBeInTheDocument();

    // 默认 harness = 第一个（Oh My Pi），直接点开始对话（工作区默认第一个 dev）
    await user.click(screen.getByRole("button", { name: "开始对话" }));

    // 生成 Tab（Tab 标题「新会话」）+ 聊天面板的 harness 徽标
    expect(await screen.findByText(/正在和 Oh My Pi 对话/)).toBeInTheDocument();
  });

  it("历史去重：点同一会话两次不产生第二个面板", async () => {
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<App />);

    const user = userEvent.setup();
    const btn = await screen.findByRole("button", { name: "你好" });
    await user.click(btn);
    await user.click(btn);

    // 只应有一个聊天面板（harness 徽标唯一）
    const badges = await screen.findAllByText(/正在和 Oh My Pi 对话/);
    expect(badges).toHaveLength(1);
  });
});

// —— P25 App 级全局四键（Ctrl+B/M/N/T）——
describe("P25 App 全局快捷键", () => {
  it("Ctrl+B 切换左侧栏显隐（持久化同步翻转）", async () => {
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<App />);
    await screen.findByText("dev");
    expect(screen.getByRole("button", { name: "收起侧栏" })).toBeInTheDocument();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", { name: "收起侧栏" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeInTheDocument();
    // 再按一次恢复
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB", ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByRole("button", { name: "收起侧栏" })).toBeInTheDocument();
  });

  it("Ctrl+K 切换右侧栏显隐", async () => {
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<App />);
    // 打开一个会话让 RightRail 挂载
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "你好" }));
    await screen.findByTestId("right-rail");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("right-rail")).not.toBeInTheDocument();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId("right-rail")).toBeInTheDocument();
  });

  it("Ctrl+N 打开新建会话弹层", async () => {
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<App />);
    await screen.findByText("dev");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(await screen.findByRole("heading", { name: "新建会话" })).toBeInTheDocument();
  });

  it("Ctrl+T 新建终端 tab", async () => {
    const calls = mockTauriIpc({ handlers: defaultHandlers() });
    // TerminalPanel 依赖 xterm DOM 测量，jsdom 下挂载链路不完整——
    // mock 掉面板本体，只验证 App 编排（tab 入模型 + 索引落盘 + 面板分派）
    vi.mock("@/terminal/TerminalPanel", () => ({
      TerminalPanel: () => <div data-testid="terminal-panel">终端</div>,
    }));
    render(<App />);
    await screen.findByText("dev");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    // 终端 tab 已入索引（sessions_upsert 携带 kind=terminal / title=终端）
    const upsert = calls.find((c) => c.cmd === "sessions_upsert");
    expect(upsert).toBeTruthy();
    expect(upsert!.args.entry.kind).toBe("terminal");
    expect(upsert!.args.entry.title).toBe("终端");
    // 终端面板被 factory 分派渲染
    expect(await screen.findByTestId("terminal-panel")).toBeInTheDocument();
  });
});
