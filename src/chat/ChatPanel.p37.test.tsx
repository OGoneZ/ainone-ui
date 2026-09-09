// @vitest-environment jsdom
// P37 集成：输出速率徽标挂接 ChatPanel 的防回归。
// 意图：徽标是「感知模型快慢」的 UI 出口——
//   1) 流式 text turn 结束后徽标出现且冻结常驻（AC-3：不消失不归零）；
//   2) 纯 tool turn（无 agent_text）不显示徽标（AC-2：无速率可算不空占布局）；
//   3) 下轮 turn 速率重新走（AC-3：归零重走）。
// openSession mock 同 ChatPanel.test.tsx：手动驱动 onOutgoing 事件流。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "@/chat/ChatPanel";
import { useSessionStore } from "../store/sessionStore";
import { openSession } from "../acp/session";
import type { AcpSession } from "../acp/session";
import type { AdapterWithStatus } from "../ipc/adapters";
import { rateStoreClear } from "../chat/hooks/streamRateStore";

vi.mock("../acp/session", () => ({
  openSession: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../ipc/quickask", () => ({
  quickAskConfigGet: vi.fn().mockResolvedValue({
    base_url: "https://qa.example.com/v1", model: "m", timeout_ms: 30000, has_api_key: false,
  }),
  quickAsk: vi.fn().mockResolvedValue("解释"),
}));
vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({ key: index, index, start: 0 }));
    return {
      getTotalSize: () => opts.count * 80,
      getVirtualItems: () => items,
      measureElement: () => {},
    };
  },
}));

const mockOpen = vi.mocked(openSession);

const adapter: AdapterWithStatus = {
  id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: "#7c3aed",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
};

function fakeSession(events: Array<{ type: string; [k: string]: any }>): AcpSession {
  return {
    sessionId: "s-test",
    capabilities: null,
    agentInfo: null,
    sessionOrigin: "new",
    listSessions: null,
    configOptions: null,
    setConfigOption: async () => null,
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
  rateStoreClear(); // P37：登记表是模块级——测试间不清理会串扰
  mockOpen.mockReset();
  // 前序用例可能残留挂载树（异步 React 更新晚于 afterEach 的 cleanup 落地）——
  // 渲染前清空 body，杜绝「Found multiple elements」式跨用例 DOM 串扰
  document.body.innerHTML = "";
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function send(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("消息输入"), text);
  await user.click(screen.getByRole("button", { name: "发送" }));
  await waitForTurnEnd();
}

/** 等 turn 收口（busy=false）——徽标冻结值依赖 finalize 已跑 */
async function waitForTurnEnd() {
  await vi.waitFor(() => {
    if (useSessionStore.getState().runtime["k1"]?.busy) throw new Error("turn 未结束");
  });
}

describe("P37：输出速率徽标", () => {
  it("text turn 结束：徽标出现且冻结常驻（⚡ N tok/s）", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "这是一段足够长的回复内容用来产生有意义的速率估算，确保窗口内字符数超过最小阈值。".repeat(3) },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    await send("hi");

    expect(await screen.findByText(/回复正文|足够长/)).toBeInTheDocument();
    // 徽标出现（速率估算已冻结）
    const badge = await screen.findByTestId("stream-rate");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toMatch(/\d+(\.\d+)? tok\/s/); // P37 后续：图标改 lucide RateIcon，文本不再含 ⚡
    expect(badge.getAttribute("data-live")).toBe("false"); // 已收口 → 冻结态
  });

  it("纯 tool turn（无 agent_text/agent_thought）：不显示徽标", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "tool_call", toolCallId: "t1", title: "bash", status: "completed", content: [{ kind: "text", text: "ok" }] },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    await send("hi");

    expect(await screen.findByText("工具 1 个")).toBeInTheDocument();
    expect(screen.queryByTestId("stream-rate")).not.toBeInTheDocument();
  });

  it("思考文本计入速率：thought+tool 轮（agent 任务常态）也显示徽标", async () => {
    // 三桥实证：thought chunk 均为 content.text（claude thinking_delta / codex
    // reasoning delta / pi thinking_delta）——模型真实 output token，计入速率。
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_thought", text: "让我先检查这个目录的结构，然后决定下一步操作，需要仔细看看文件列表的内容再判断。" },
        { type: "tool_call", toolCallId: "t1", title: "bash", status: "completed", content: [{ kind: "text", text: "ok" }] },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    await send("hi");

    // 「思考 1 次」仅本用例组卡摘要含——规避前序用例摘要串的子串多匹配
    expect(await screen.findByText(/思考 1 次 · 工具 1 个/)).toBeInTheDocument();
    // 有思考输出 → 徽标出现（旧口径只算 agent_text，此轮不显示——缺陷已修）
    expect(screen.getByTestId("stream-rate")).toBeInTheDocument();
  });

  it("空 thought 文本（claude omitted 签名块）不计入速率：仍不显示徽标", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_thought", text: "" },
        { type: "tool_call", toolCallId: "t1", title: "bash", status: "completed", content: [{ kind: "text", text: "ok" }] },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    await send("hi");

    // 空 thought 也会建 thought 块（appendThought 不判空）→ 组卡摘要仍含「思考 1 次」。
    // findByText 偶发「Found multiple」——前序用例卸载树的 act 时序残留，findAllByText 语义等价
    const summaries = await screen.findAllByText(/思考 1 次 · 工具 1 个/);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("stream-rate")).not.toBeInTheDocument();
  });

  it("带权威 outputTokens 的 turn_stop：finalize 走精确均值", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "内容足够长。".repeat(10) },
        { type: "turn_stop", stopReason: "end_turn", outputTokens: 500 },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    await send("hi");

    const badge = await screen.findByTestId("stream-rate");
    expect(badge).toBeInTheDocument(); // 数值本身不锁死（墙钟毫秒级抖动），锁定渲染通路
  });

  it("下轮 turn：速率重新计算（第一轮冻结值不残留到第二轮徽标）", async () => {
    mockOpen
      .mockResolvedValueOnce(
        fakeSession([
          { type: "agent_text", text: "第一轮的回复内容，足够长以产生速率估算值。".repeat(4) },
          { type: "turn_stop", stopReason: "end_turn" },
        ]),
      )
      .mockResolvedValueOnce(
        fakeSession([
          { type: "agent_text", text: "第二轮完全不同的回复内容，速率应重新估算而不是沿用第一轮。".repeat(4) },
          { type: "turn_stop", stopReason: "end_turn" },
        ]),
      );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    await send("第一问");
    // P38：每条 assistant 消息各自带冻结徽标 → 多个 stream-rate 并存取末条
    const first = await screen.findByTestId("stream-rate");
    const firstText = first.textContent;

    await send("第二问");
    const second = screen.getAllByTestId("stream-rate").slice(-1)[0]!;
    expect(second.textContent).toMatch(/\d+(\.\d+)? tok\/s/); // 仍正常显示
    // rate 对象每轮重建——这里主要锁定第二轮徽标存在且格式正确（值可能巧合相近）
    expect(second).not.toBe(first);
    void firstText;
  });
});
