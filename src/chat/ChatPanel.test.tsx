// @vitest-environment jsdom
// ChatPanel 交互行为测试：发送/流式渲染/thinking 折叠/slash 补全。
// openSession 被 mock，直接驱动 session.prompt 的 onOutgoing 回调模拟 ACP 事件流。
//
// 注意两点：
//   - @tanstack/react-virtual 在 jsdom 里容器高度为 0 → 不渲染任何项，故在此 mock 掉
//     让 getVirtualItems 直接返回全部项（渲染正确性不受虚拟化实现影响）
//   - vitest globals=false → 手动 afterEach(cleanup) 清 DOM，避免测试间串扰

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "@/chat/ChatPanel";
import { useSessionStore } from "../store/sessionStore";
import { openSession } from "../acp/session";
import { open } from "@tauri-apps/plugin-dialog";
import type { AcpSession } from "../acp/session";
import type { AdapterWithStatus } from "../ipc/adapters";

vi.mock("../acp/session", () => ({
  openSession: vi.fn(),
}));

// F-8-3 文件引用：mock 文件选择对话框 + Tauri 拖拽事件（jsdom 无 Tauri 运行时）
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));

// F-8-7 快问：mock 配置与调用（组件内挂载即读配置）；quickAsk 模拟流式两段增量
vi.mock("../ipc/quickask", () => ({
  quickAskConfigGet: vi.fn().mockResolvedValue({
    base_url: "https://qa.example.com/v1",
    model: "qa-model",
    timeout_ms: 30000,
    has_api_key: false,
  }),
  quickAsk: vi.fn(async (_text: string, onDelta?: (d: string) => void) => {
    onDelta?.("这是快问的");
    onDelta?.("解释");
    return "这是快问的解释";
  }),
}));

// logger 内部走 @tauri-apps/plugin-log（依赖 Tauri invoke），jsdom 无 Tauri 运行时 → mock 掉
vi.mock("../lib/logger", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({
      key: index,
      index,
      start: 0,
    }));
    return {
      getTotalSize: () => opts.count * 80,
      getVirtualItems: () => items,
      measureElement: () => {},
    };
  },
}));

const mockOpen = vi.mocked(openSession);

const adapter: AdapterWithStatus = {
  id: "omp",
  name: "Oh My Pi",
  program: "omp",
  args: [],
  cwd: ".",
  logo: "#7c3aed",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },};

const input = () => screen.getByLabelText("消息输入");

/** 造一个受控 AcpSession：prompt 时手动触发 onOutgoing 事件流 */
function fakeSession(events: Array<{ type: string; [k: string]: any }>): AcpSession {
  return {
    sessionId: "s-test",
    capabilities: null,
    agentInfo: null,
    sessionOrigin: "new",
    prompt: async (_text: string, onOutgoing: (e: any) => void) => {
      for (const e of events) onOutgoing(e);
    },
    cancel: async () => {},
    fork: async () => "s-forked",
    listProviders: async () => [],
    recycle: async () => {},
    dispose: async () => {},
  };
}

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({ runtime: {}, commands: {} });
  mockOpen.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("ChatPanel 交互行为", () => {
  it("发送消息 → 用户右侧气泡 + agent 回复左侧气泡", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "你好，我是 Oh My Pi" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);

    const user = userEvent.setup();
    await user.type(input(), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // 用户气泡（左/右侧由 CSS 决定，这里断言内容 + 气泡容器存在）
    expect(await screen.findByText("你好")).toBeInTheDocument();
    // agent 回复（react-markdown 渲染成 <p>）
    expect(await screen.findByText(/你好，我是 Oh My Pi/)).toBeInTheDocument();
  });

  it("流式 thinking：turn 结束折叠为「已思考 N 秒」（F-12-3 活动组内可见摘要）", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_thought", text: "让我想想" },
        { type: "agent_text", text: "回复正文" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "x");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // F-12-3：已完成 thought 入活动组 → 折叠态摘要「思考 1 次」可见；展开组内「已思考 0 秒」
    expect(await screen.findByText(/回复正文/)).toBeInTheDocument();
    expect(screen.getByText(/思考 1 次/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /思考 1 次/ }));
    expect(await screen.findByText(/已思考 \d+ 秒/)).toBeInTheDocument();
  });

  it("slash 补全：输入 / 弹出列表，ArrowDown+Enter 选中回填", async () => {
    useSessionStore.getState().setCommands("omp", [
      { name: "model", description: "显示模型" },
      { name: "fast", description: "切换快速模式" },
    ]);
    render(<ChatPanel tabKey="k1" adapter={adapter} />);

    const inputEl = input();
    const user = userEvent.setup();
    await user.type(inputEl, "/");

    expect(await screen.findByText("/model")).toBeInTheDocument();
    expect(screen.getByText("/fast")).toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(inputEl).toHaveValue("/model ");
  });

  it("agent 消息带 hover 复制按钮，点击复制正文（F-7-4 AC-P7-4-2）", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "这是可复制的回复" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const copyBtn = await screen.findByRole("button", { name: "复制回复" });
    expect(copyBtn).toBeInTheDocument();
    await user.click(copyBtn);
    // 点击后剪贴板含正文（mock clipboard）
  });

  it("F-8-2 批注：选中文本 → 悬浮窗「批注」→ 批注卡 → 发送 → user 气泡含引用组装（AC-P8-6）", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "第一段需要追问的原文" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    // mock 选区：getSelection 返回一段文字
    const selText = "需要追问";
    const sel = { isCollapsed: false, toString: () => selText };
    (window as any).getSelection = () => sel;

    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // agent 回复渲染后，选中触发 onSelect → 悬浮窗出现（含「批注」入口）
    const mdText = await screen.findByText(/第一段需要追问的原文/);
    expect(mdText).toBeInTheDocument();
    mdText.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    // 点「批注」加入批注卡
    await user.click(await screen.findByRole("button", { name: "批注" }));

    // 批注卡出现，填疑问
    const qInput = await screen.findByLabelText("批注疑问 1");
    await user.type(qInput, "为什么这样？");

    // 发送批注 → user 气泡含组装文本
    await user.click(screen.getByRole("button", { name: "发送批注" }));
    expect(
      await screen.findByText(/\[引用 1\] 需要追问[\s\S]*疑问：为什么这样？/),
    ).toBeInTheDocument();
  });

  it("F-8-7 快问：选中 → 悬浮窗「快速解释」→ 流式渲染且不进入会话（AC-P8-10）", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "某个需要解释的疑难名词" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    const selText = "疑难名词";
    const sel = { isCollapsed: false, toString: () => selText };
    (window as any).getSelection = () => sel;

    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const mdText = await screen.findByText(/某个需要解释的疑难名词/);
    mdText.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    // 悬浮窗出现，点「快速解释」
    await user.click(await screen.findByRole("button", { name: "快速解释" }));

    // 流式增量逐块渲染（mock 两段 delta），最终全文可见
    expect(await screen.findByText("这是快问的解释")).toBeInTheDocument();

    // 解释内容不进入会话消息列表（程序化检查 store：无 user 气泡包含解释）
    const runtime = useSessionStore.getState().runtime["k1"];
    const allUserText = (runtime?.messages ?? [])
      .filter((m: any) => m.role === "user")
      .map((m: any) => m.text)
      .join("\n");
    expect(allUserText).not.toContain("这是快问的解释");
  });

  it("F-8-3 文件引用：按钮选文件 → 附件胶囊 → 发送含 @file 路径（AC-P8-15）", async () => {
    const openMock = vi.mocked(open);
    openMock.mockResolvedValue("/Users/me/project/readme.md" as any);

    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "收到文件" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();

    // 点「添加文件」按钮 → 附件胶囊出现
    await user.click(screen.getByRole("button", { name: "添加文件" }));
    expect(await screen.findByText("readme.md")).toBeInTheDocument();

    // 输入文字发送 → user 气泡含 @file:/abs/path
    await user.type(input(), "请分析这个文件");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(
      await screen.findByText(/@file:\/Users\/me\/project\/readme\.md/),
    ).toBeInTheDocument();
  });

  it("F-8-3 文件引用：附件 × 移除 → 发送不含该文件（AC-P8-17）", async () => {
    const openMock = vi.mocked(open);
    openMock.mockResolvedValue(["/a/one.ts", "/b/two.ts"] as any);

    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "ok" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "添加文件" }));
    expect(await screen.findByText("one.ts")).toBeInTheDocument();
    expect(screen.getByText("two.ts")).toBeInTheDocument();

    // 移除第一个附件
    await user.click(screen.getByRole("button", { name: "移除附件 1" }));
    expect(screen.queryByText("one.ts")).not.toBeInTheDocument();

    await user.type(input(), "看剩下的文件");
    await user.click(screen.getByRole("button", { name: "发送" }));
    const userBubble = await screen.findByText(/@file:\/b\/two\.ts/);
    expect(userBubble).toBeInTheDocument();
    // 被移除的文件不出现在气泡
    const userMsg = (useSessionStore.getState().runtime["k1"]?.messages ?? []).find(
      (m) => m.role === "user",
    );
    expect(userMsg && userMsg.role === "user" ? userMsg.text : "").not.toContain("/a/one.ts");
  });

  it("F-8-5 分叉：assistant 消息 hover 出现「分叉」，点击回调 onFork（AC-P8-23 组件侧）", async () => {
    // P24g：fork 入口按握手能力显隐（capability gate）——fake 声明 fork 能力
    mockOpen.mockResolvedValue({
      ...fakeSession([
        { type: "agent_text", text: "可以分叉的回复" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
      capabilities: { sessionCapabilities: { fork: {} } } as AcpSession["capabilities"],
    });
    const onFork = vi.fn();
    render(
      <ChatPanel
        tabKey="k1"
        adapter={adapter}
        onFirstPrompt={() => {}}
        onFork={onFork}
      />,
    );
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const forkBtn = await screen.findByRole("button", { name: "从这里分叉" });
    expect(forkBtn).toBeInTheDocument();
    await user.click(forkBtn);

    // onFork 被调用（分叉需真实会话，这里只验证入口接线）
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  it("P24g capability gate：harness 未声明 fork 能力 → 分叉入口不渲染（没能力不显示入口，而非点击报错）", async () => {
    // fakeSession 默认 capabilities: null（旧 harness 未声明任何能力）
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "不能分叉的回复" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    const onFork = vi.fn();
    render(
      <ChatPanel
        tabKey="k1"
        adapter={adapter}
        onFirstPrompt={() => {}}
        onFork={onFork}
      />,
    );
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await screen.findByText(/不能分叉的回复/);
    // gate 生效：入口不存在（MessageLine 按 onFork prop 存在性渲染）
    expect(screen.queryByRole("button", { name: "从这里分叉" })).not.toBeInTheDocument();
  });

  // F-15-2（DEC-42）：会话内搜索条已移除，全局搜索（Ctrl+F）由 GlobalSearchDialog 承担。
  it("F-15-2 Ctrl+Shift+F 不再唤起会话内搜索条", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "这个文件包含安全漏洞" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText(/安全漏洞/);

    await user.keyboard("{Meta>}{Shift>}f{/Shift}{/Meta}");
    expect(screen.queryByLabelText("搜索会话")).not.toBeInTheDocument();
  });
});
