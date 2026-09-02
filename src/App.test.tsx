// @vitest-environment jsdom
// App 编排测试：侧栏工作区分组、新建会话弹层、历史去重、工作区状态。
// 用 mockTauriIpc 假后端驱动，不依赖 Tauri 运行时。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { mockTauriIpc } from "./test/mockIpc";
import { useSessionStore } from "./store/sessionStore";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({ key: index, index, start: 0 }));
    return { getTotalSize: () => opts.count * 80, getVirtualItems: () => items, measureElement: () => {} };
  },
}));

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
    adapter_available: () => true,
    sessions_list: () => SESSIONS,
    workspaces_list: () => WS,
    log_read: () => "",
    default_cwd: () => "/",
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
    await user.click(await screen.findByRole("button", { name: "＋ 新建会话" }));

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
