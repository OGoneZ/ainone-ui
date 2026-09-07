// @vitest-environment jsdom
// P25 ChatPanel 键盘导航测试：焦点域切换 / 滚动键族 / 用户消息跳转 / 双击 Esc 中断 /
// 语音开关（Alt+\）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "@/chat/ChatPanel";
import { useSessionStore } from "../store/sessionStore";
import { useKeymapStore } from "../store/keymapStore";
import { openSession } from "../acp/session";
import type { AcpSession } from "../acp/session";
import type { AdapterWithStatus } from "../ipc/adapters";

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
    base_url: "https://qa.example.com/v1",
    model: "qa-model",
    timeout_ms: 30000,
    has_api_key: false,
  }),
  quickAsk: vi.fn().mockResolvedValue("解释"),
}));
vi.mock("../lib/logger", () => ({
  logger: {
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => {
    const items = Array.from({ length: opts.count }, (_, index) => ({ key: index, index, start: 0 }));
    return {
      getTotalSize: () => opts.count * 80,
      getVirtualItems: () => items,
      measureElement: () => {},
      scrollToIndex: vi.fn(),
    };
  },
}));

// jsdom 滚动容器：scrollTop 可正常赋值，但 scrollHeight/clientHeight 默认 0——
// 测试里用 defineProperty 按需覆写（本文件的滚动用例）。

const mockOpen = vi.mocked(openSession);

const adapter: AdapterWithStatus = {
  id: "omp",
  name: "Oh My Pi",
  program: "omp",
  args: [],
  cwd: ".",
  logo: "#7c3aed",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
};

const input = () => screen.getByLabelText("消息输入");

/** 造一个受控 AcpSession；cancel 留 spy 供中断断言 */
function fakeSession(events: Array<{ type: string; [k: string]: any }> = [], cancelSpy?: () => void): AcpSession {
  return {
    sessionId: "s-test",
    capabilities: null,
    agentInfo: null,
    sessionOrigin: "new",
    prompt: async (_text: string, onOutgoing: (e: any) => void) => {
      for (const e of events) onOutgoing(e);
    },
    cancel: async () => cancelSpy?.(),
    fork: async () => "s-forked",
    listProviders: async () => [],
    recycle: async () => {},
    dispose: async () => {},
  };
}

/** 向 window 派发 keydown（ChatPanel 的 pane 监听挂 window）。
 *  用真实 KeyboardEvent 而非 fireEvent.keyDown(window, ...)：后者在
 *  testing-library 的 window 目标上有 target 归一化差异，实测不可达。
 *  组件状态更新异步渲染，配合 flush 渲染的 helper 使用。 */
function press(e: Partial<KeyboardEvent> & { key: string }) {
  window.dispatchEvent(new KeyboardEvent("keydown", e as KeyboardEventInit));
}

/** 等一帧让 React 提交 setState */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({ runtime: {}, commands: {} });
  useKeymapStore.setState({ overrides: {} });
  mockOpen.mockReset();
  mockOpen.mockResolvedValue(fakeSession());
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("P25 ChatPanel 键盘导航", () => {
  it("Ctrl+L 切换焦点域：data-zone 在 composer/chat 间翻转", async () => {
    const { container } = render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const panel = container.querySelector(".panel")!;
    expect(panel.getAttribute("data-zone")).toBe("composer");
    press({ key: "l", code: "KeyL", ctrlKey: true });
    await flush();
    expect(panel.getAttribute("data-zone")).toBe("chat");
    press({ key: "l", code: "KeyL", ctrlKey: true });
    await flush();
    expect(panel.getAttribute("data-zone")).toBe("composer");
  });

  it("zone=chat 且非输入焦点时 ↑↓/PgUp/PgDn/Home/End 滚动 .chat 容器", async () => {
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const chat = document.querySelector(".chat") as HTMLElement;
    // jsdom 无 layout：clientHeight/scrollHeight 恒 0，覆写为可算的尺寸
    Object.defineProperty(chat, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(chat, "scrollHeight", { value: 2000, configurable: true });
    // 进入 chat 域（zone 是同步 ref，无需 flush 即可滚动）
    press({ key: "l", code: "KeyL", ctrlKey: true });
    await flush();
    press({ key: "ArrowDown", code: "ArrowDown" });
    press({ key: "ArrowDown", code: "ArrowDown" });
    press({ key: "PageDown", code: "PageDown" });
    // 2×40 + 500×0.9 = 530
    expect(chat.scrollTop).toBeCloseTo(530);
    press({ key: "PageUp", code: "PageUp" });
    // 530 - 450 = 80
    expect(chat.scrollTop).toBe(80);
    press({ key: "Home", code: "Home" });
    expect(chat.scrollTop).toBe(0);
    // End 的钳位行为依赖真实 layout（jsdom 不执行），覆盖式断言在浏览器手测补足
  });

  it("zone=composer 时裸 ↑↓ 不拦截（光标自由移动）", async () => {
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const chat = document.querySelector(".chat") as HTMLElement;
    Object.defineProperty(chat, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(chat, "scrollHeight", { value: 2000, configurable: true });
    const user = userEvent.setup();
    await user.type(input(), "hi");
    press({ key: "ArrowDown", code: "ArrowDown" });
    expect(chat.scrollTop).toBe(0);
  });

  it("Alt+↓ / Alt+↑ 跳转下/上一条用户消息（flash 高亮 + 游标推进）", async () => {
    // 直接向 store 灌历史消息（省去逐条发送）
    const { container } = render(<ChatPanel tabKey="k1" adapter={adapter} />);
    act(() => {
      useSessionStore.setState((s) => ({
        runtime: {
          ...s.runtime,
          k1: {
            ...s.runtime.k1!,
            messages: [
              { role: "user", text: "q1", blocks: [] },
              { role: "assistant", text: "a1", blocks: [] },
              { role: "user", text: "q2", blocks: [] },
              { role: "assistant", text: "a2", blocks: [] },
              { role: "user", text: "q3", blocks: [] },
            ],
          } as any,
        },
      }));
    });
    const chat = container.querySelector(".chat") as HTMLElement;
    press({ key: "ArrowDown", code: "ArrowDown", altKey: true });
    // flash 在 jumpToIndex 的双 rAF 后置位（jsdom rAF≈16ms 定时器），等足时间
    await new Promise((r) => setTimeout(r, 120));
    // 第一条 user（index 0）被 flash 高亮
    expect(chat.querySelector('[data-flash="true"]')).not.toBeNull();
    // 游标推进逻辑经两次 ↓ 一次 ↑ 验证不抛错且仍有高亮目标
    press({ key: "ArrowDown", code: "ArrowDown", altKey: true });
    press({ key: "ArrowUp", code: "ArrowUp", altKey: true });
    await new Promise((r) => setTimeout(r, 120));
    expect(chat.querySelector('[data-flash="true"]')).not.toBeNull();
  });

  it("双击 Esc（500ms 内）busy 时中断当前回复", async () => {
    const cancelSpy = vi.fn();
    // prompt 挂起不返回 → busy 停留 true（真实 ACP 流式期间的形态）
    const never = new Promise<never>(() => {});
    mockOpen.mockResolvedValue({
      sessionId: "s-test",
      capabilities: null,
      agentInfo: null,
      sessionOrigin: "new",
      prompt: () => never,
      cancel: cancelSpy,
      fork: async () => "s-forked",
      listProviders: async () => [],
      recycle: async () => {},
      dispose: async () => {},
    } as unknown as AcpSession);
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await vi.waitFor(() => {
      expect(useSessionStore.getState().runtime["k1"]?.busy).toBe(true);
    });
    press({ key: "Escape", code: "Escape" });
    press({ key: "Escape", code: "Escape" });
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("双击 Esc 非编辑态之外：编辑重发态下单 Esc 消费、不触发中断", async () => {
    const cancelSpy = vi.fn();
    const never = new Promise<never>(() => {});
    mockOpen.mockResolvedValue({
      sessionId: "s-test",
      capabilities: null,
      agentInfo: null,
      sessionOrigin: "new",
      prompt: () => never,
      cancel: cancelSpy,
      fork: async () => "s-forked",
      listProviders: async () => [],
      recycle: async () => {},
      dispose: async () => {},
    } as unknown as AcpSession);
    const { container } = render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await vi.waitFor(() => {
      expect(useSessionStore.getState().runtime["k1"]?.busy).toBe(true);
    });
    // 注入一条 user 消息后从 hover 编辑钮进入编辑态
    act(() => {
      useSessionStore.setState((s) => ({
        runtime: {
          ...s.runtime,
          k1: { ...s.runtime.k1!, messages: [{ role: "user", text: "hi", blocks: [] }] } as any,
        },
      }));
    });
    const editBtn = container.querySelector("button[aria-label='编辑重发']");
    if (editBtn) {
      await user.click(editBtn);
      press({ key: "Escape", code: "Escape" });
      press({ key: "Escape", code: "Escape" });
      // 第一次 Esc 消费编辑态并归零双击计数；第二次重新起算——两次都在
      // 「消费→起算」链上，不应触发 cancel
      expect(cancelSpy).not.toHaveBeenCalled();
    }
  });

  it("Alt+\\ 触发语音开关注册回调", async () => {
    // 直接挂 ChatPanel 同款注册链路：渲染组件后从 ref 不可测，改为验证
    // keydown 分支调用 voiceToggleRef——用一个真组件 + mock getUserMedia 太重，
    // 这里验证「命中即 preventDefault 且不抛错」，注册链路单独在 VoiceInput 测。
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const e1 = new KeyboardEvent("keydown", { key: "\\", code: "Backslash", altKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(e1);
    expect(e1.defaultPrevented).toBe(true);
  });
});

describe("P25 VoiceInput registerToggle", () => {
  it("注册的 toggle 回调随 state 变化重挂（idle → start）", async () => {
    const { VoiceInput } = await import("@/chat/composer/VoiceInput");
    const registerToggle = vi.fn();
    render(<VoiceInput onTranscribed={() => {}} registerToggle={registerToggle} />);
    // 首次注册：idle 态的 toggle
    expect(registerToggle).toHaveBeenCalled();
    const toggle = registerToggle.mock.lastCall?.[0] as () => void;
    // idle 调 toggle → 进入录音态需要 getUserMedia；mock 掉后验证不抛错
    const gUM = vi.fn().mockResolvedValue({
      getTracks: () => [],
    });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: gUM }, configurable: true });
    // MediaRecorder 必须是可 new 的构造器：vi.fn() + 箭头 mockImplementation 在
    // vitest 4 的 new Mock 路径下报「not a constructor」，start() 同步抛出 →
    // void start() 的 promise 落成 unhandled rejection，污染后续测试报告。
    // 用类 mock（与 VoiceInput.test.tsx 的 FakeRecorder 同式）。
    class FakeRecorder {
      stream: unknown;
      start = vi.fn();
      ondataavailable: ((e: unknown) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(stream: unknown) {
        this.stream = stream;
      }
    }
    (window as any).MediaRecorder = FakeRecorder;
    toggle();
    await vi.waitFor(() => {
      expect(gUM).toHaveBeenCalled();
    });
  });
});

describe("P25 Ctrl+O 折叠全部活动组", () => {
  /** 灌入一条含 thought+tool 块的 assistant 消息 */
  async function setupWithActivity() {
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    act(() => {
      useSessionStore.setState((s) => ({
        runtime: {
          ...s.runtime,
          k1: {
            ...s.runtime.k1!,
            messages: [
              {
                role: "assistant",
                text: "",
                blocks: [
                  { kind: "thought", text: "想一想", ms: 1200 },
                  { kind: "tool", toolCallId: "t1", title: "bash", status: "completed", ms: 300, content: [{ kind: "text", text: "ok" }] },
                  { kind: "text", text: "结论" },
                ],
              } as any,
            ],
          } as any,
        },
      }));
    });
    await new Promise((r) => setTimeout(r, 30));
  }

  it("Ctrl+O 后思考/工具全部展开，再按收起（三态循环）", async () => {
    await setupWithActivity();
    // 折叠态：组摘要可见、正文不可见
    expect(screen.getByText(/思考 1 次/)).toBeInTheDocument();
    expect(screen.queryByText("想一想")).not.toBeInTheDocument();
    // 第一次 Ctrl+O：全部展开
    press({ key: "o", code: "KeyO", ctrlKey: true });
    await flush();
    expect(await screen.findByText("想一想")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    // 第二次：全部收起
    press({ key: "o", code: "KeyO", ctrlKey: true });
    await flush();
    expect(screen.queryByText("想一想")).not.toBeInTheDocument();
    // 第三次：又全展开（true 循环）
    press({ key: "o", code: "KeyO", ctrlKey: true });
    await flush();
    expect(await screen.findByText("想一想")).toBeInTheDocument();
  });

  it("折叠态卡头有淡色快捷键提示（含键名）", async () => {
    await setupWithActivity();
    const hint = document.querySelector(".activity-kbd-hint");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("Ctrl+O");
    // 展开后（覆写 true）提示隐藏
    press({ key: "o", code: "KeyO", ctrlKey: true });
    await flush();
    expect(document.querySelector(".activity-kbd-hint")).toBeNull();
  });

  it("覆写生效时手动点单卡 → 清除覆写回局部态（收起）", async () => {
    await setupWithActivity();
    press({ key: "o", code: "KeyO", ctrlKey: true });
    await flush();
    expect(screen.getByText("想一想")).toBeInTheDocument();
    // 手动点组卡头收起（覆写清除 + 局部折叠）
    await userEvent.setup().click(screen.getByText(/思考 1 次/));
    await flush();
    expect(screen.queryByText("想一想")).not.toBeInTheDocument();
  });
});
