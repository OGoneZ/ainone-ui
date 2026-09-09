// @vitest-environment jsdom
// P38 集成：持久化 + 悬浮层 + fork 常显的防回归。
// 意图：
//   1) turn 收口后消息带 turnMs/rateTokPerS（随 persistNew 落 JSONL——历史会话重开可见）；
//   2) 建链期间悬浮层出现且文案区分场景（恢复/新会话），完成后消失；
//   3) fork 按钮常显：无能力声明的历史会话也能点击（点击时建链+判定）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "@/chat/ChatPanel";
import { useSessionStore } from "../store/sessionStore";
import { openSession } from "../acp/session";
import type { AcpSession } from "../acp/session";
import type { AdapterWithStatus } from "../ipc/adapters";
import { rateStoreClear } from "../chat/hooks/streamRateStore";

vi.mock("../acp/session", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../acp/session")>();
  return { ...mod, openSession: vi.fn() };
});
// 恢复会话场景：logRead 回填历史（真实 invoke 在 jsdom 无 Tauri 运行时必然 reject）
vi.mock("../ipc/sessions", () => ({
  logRead: vi.fn().mockResolvedValue(
    JSON.stringify({ role: "user", text: "历史提问" }) + "\n" +
    JSON.stringify({ role: "assistant", blocks: [{ kind: "text", text: "历史回复" }] }),
  ),
  logAppend: vi.fn().mockResolvedValue(undefined),
  logTruncate: vi.fn().mockResolvedValue(undefined),
  logCopy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/logger", () => ({ logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({ key: index, index, start: 0 }));
    return { getTotalSize: () => opts.count * 80, getVirtualItems: () => items, measureElement: () => {} };
  },
}));

const mockOpen = vi.mocked(openSession);

const adapter: AdapterWithStatus = {
  id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: "#7c3aed",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
};

function fakeSession(events: Array<{ type: string; [k: string]: any }>, caps: AcpSession["capabilities"] = null): AcpSession {
  return {
    sessionId: "s-test", capabilities: caps, agentInfo: null, sessionOrigin: "new",
    listSessions: null, configOptions: null, setConfigOption: async () => null,
    prompt: async (_t: string, onOutgoing: (e: any) => void) => { for (const e of events) onOutgoing(e); },
    cancel: async () => {}, fork: async () => "s-forked", listProviders: async () => [],
    recycle: async () => {}, dispose: async () => {},
  } as unknown as AcpSession;
}

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({ runtime: {}, commands: {} });
  rateStoreClear();
  mockOpen.mockReset();
});
afterEach(() => cleanup());

function input(): HTMLTextAreaElement {
  return screen.getByLabelText("消息输入") as HTMLTextAreaElement;
}

describe("P38：turn 元数据持久化", () => {
  it("text turn 收口：末条 assistant 消息带 turnMs 与 rateTokPerS（>0），历史轮可显示", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "足够长的回复内容用来产生有意义的速率估算值，窗口内字符超过最小阈值。".repeat(3) },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText(/足够长/)).toBeInTheDocument();
    await vi.waitFor(() => {
      const msgs = useSessionStore.getState().runtime["k1"]?.messages ?? [];
      const last = msgs[msgs.length - 1];
      expect(last.role === "assistant" && last.turnMs !== undefined && last.turnMs >= 0).toBe(true);
      expect(last.role === "assistant" && last.rateTokPerS !== undefined && last.rateTokPerS > 0).toBe(true);
    });
    // 消息级冻结行渲染（testid 沿用 turn-elapsed-ended）
    expect(screen.getAllByTestId("turn-elapsed-ended").length).toBeGreaterThan(0);
  });

  it("纯 tool turn（无文本）：turnMs 写入、rateTokPerS 不写（无可算速率）", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "tool_call", toolCallId: "t1", title: "bash", status: "completed", content: [{ kind: "text", text: "ok" }] },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText(/工具 1 个/)).toBeInTheDocument();
    await vi.waitFor(() => {
      const msgs = useSessionStore.getState().runtime["k1"]?.messages ?? [];
      const last = msgs[msgs.length - 1];
      expect(last.role === "assistant" && last.turnMs !== undefined).toBe(true);
      expect(last.role === "assistant" && last.rateTokPerS).toBeUndefined();
    });
    expect(screen.queryByTestId("stream-rate")).not.toBeInTheDocument();
  });
});

describe("P38：建链加载悬浮层", () => {
  it("首条消息建链期间：悬浮层出现（新会话文案含 adapter 名），建链完成后消失", async () => {
    // 用受控 promise 挂起 openSession，保证断言发生在建链中
    let resolveOpen!: (s: AcpSession) => void;
    mockOpen.mockReturnValue(new Promise<AcpSession>((res) => { resolveOpen = res; }));
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // 建链中：悬浮层可见，新会话文案（resumeId 无 → false）
    const overlay = await screen.findByTestId("build-overlay");
    expect(overlay.getAttribute("data-resume")).toBe("false");
    expect(screen.getByText("正在唤醒 Oh My Pi")).toBeInTheDocument();

    resolveOpen(fakeSession([{ type: "turn_stop", stopReason: "end_turn" }]));
    await vi.waitFor(() => {
      expect(useSessionStore.getState().runtime["k1"]?.busy).toBe(false);
    });
    expect(screen.queryByTestId("build-overlay")).not.toBeInTheDocument();
  });

  it("恢复历史会话：悬浮层走「唤醒记忆」文案（resumeId 判定）", async () => {
    let resolveOpen!: (s: AcpSession) => void;
    mockOpen.mockReturnValue(new Promise<AcpSession>((res) => { resolveOpen = res; }));
    render(<ChatPanel tabKey="k1" adapter={adapter} resumeSessionId="hist-1" />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const overlay = await screen.findByTestId("build-overlay");
    expect(overlay.getAttribute("data-resume")).toBe("true");
    expect(screen.getByText("正在唤醒这段对话的记忆")).toBeInTheDocument();

    resolveOpen(fakeSession([{ type: "turn_stop", stopReason: "end_turn" }]));
  });
});

describe("P38：fork 按钮常显", () => {
  it("capabilities 为 null（历史会话未握手）：fork 按钮仍渲染，点击经 ensureSession 后走 onFork", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([
        { type: "agent_text", text: "历史回复" },
        { type: "turn_stop", stopReason: "end_turn" },
      ]),
    );
    const onFork = vi.fn();
    render(<ChatPanel tabKey="k1" adapter={adapter} onFirstPrompt={() => {}} onFork={onFork} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText(/历史回复/)).toBeInTheDocument();
    // capabilities=null（未声明能力）下按钮仍存在（常显裁决）
    const forkBtn = screen.getByRole("button", { name: "从这里分叉" });
    await user.click(forkBtn);
    // 点击时判定：fakeSession capabilities=null → toast 报不支持，onFork 不调用
    await vi.waitFor(() => {
      expect(onFork).not.toHaveBeenCalled();
    });
  });

  it("历史会话（resumeSessionId）打开即有 fork 按钮：点击触发建链（openSession 被调）", async () => {
    mockOpen.mockResolvedValue(
      fakeSession([{ type: "turn_stop", stopReason: "end_turn" }], { sessionCapabilities: { fork: {} } } as AcpSession["capabilities"]),
    );
    const onFork = vi.fn();
    render(<ChatPanel tabKey="k1" adapter={adapter} resumeSessionId="hist-2" onFirstPrompt={() => {}} onFork={onFork} onForkNavigate={() => {}} />);
    // 不发消息，直接点历史消息上的 fork（常显 + 日志回填的历史消息）
    const user = userEvent.setup();
    const forkBtn = await screen.findByRole("button", { name: "从这里分叉" });
    await user.click(forkBtn);
    // 点击 → ensureSession（openSession 被调）→ capabilities 有 fork → session.fork
    await vi.waitFor(() => {
      expect(mockOpen).toHaveBeenCalled();
    });
  });
});
