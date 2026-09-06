// @vitest-environment jsdom
// F-12-1/F-12-2 组件交互测试：编辑重试链路 + 提问卡数据流。
// 编辑重试（DEC-35）：点编辑 → 输入框回填 → 发送 → 消息截断替换 → warn 日志。
// 提问卡（F-12-2）：mock openSession 的 onElicitation 回调 → AskCard 渲染 → 提交 → resolver 收到答案。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "@/chat/ChatPanel";
import { openSession } from "../acp/session";
import { useSessionStore } from "../store/sessionStore";
import { logger } from "../lib/logger";
import type { AcpSession } from "../acp/session";

vi.mock("../acp/session", () => ({
  openSession: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// 虚拟列表 mock：渲染全部消息，避免 jsdom 高度为 0
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

const adapter = {
  id: "omp",
  name: "Oh My Pi",
  program: "omp",
  args: [],
  cwd: ".",
  logo: "#7c3aed",
  available: true,
} as any;

const input = () => screen.getByLabelText("消息输入");

/** 造一个受控 AcpSession：prompt 时手动触发 onOutgoing；可捕获 onElicitation 回调 */
function fakeSession(events: any[] = [], capture?: { elicit?: any }): AcpSession {
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
    ...(capture ? {} : {}),
  } as any;
}

/** openSession 的第 6 参（onElicitation）通过 mock 调用参数捕获（见各用例内 elicitHandler） */

beforeEach(() => {
  useSessionStore.setState({ runtime: {}, commands: {} });
  mockOpen.mockReset();
});

afterEach(cleanup);

describe("F-12-1 编辑重试", () => {
  async function seedHistory() {
    // 预置一段会话：user → assistant → user → assistant
    useSessionStore.getState().ensure("k1", "omp");
    useSessionStore.getState().setMessages("k1", [
      { role: "user", text: "问题一" },
      { role: "assistant", blocks: [{ kind: "text", text: "回答一" }] },
      { role: "user", text: "问题二" },
      { role: "assistant", blocks: [{ kind: "text", text: "回答二" }] },
    ]);
  }

  it("点编辑 → 输入框回填原文本 + 编辑横幅出现", async () => {
    await seedHistory();
    mockOpen.mockResolvedValue(fakeSession([]));
    render(<ChatPanel tabKey="k1" adapter={adapter} resumeSessionId="s-hist" />);
    const user = userEvent.setup();
    const editBtns = await screen.findAllByRole("button", { name: "编辑并重发" });
    await user.click(editBtns[1]); // 编辑第二条 user 消息
    expect(input()).toHaveValue("问题二");
    expect(screen.getByTestId("edit-banner")).toBeInTheDocument();
    // Esc 取消
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("edit-banner")).not.toBeInTheDocument());
    // 消息列表未变
    expect(useSessionStore.getState().runtime["k1"]!.messages).toHaveLength(4);
  });

  it("编辑态发送 → 截断替换 + warn 日志 + 会话重开", async () => {
    await seedHistory();
    mockOpen.mockResolvedValue(fakeSession([]));
    render(<ChatPanel tabKey="k1" adapter={adapter} resumeSessionId="s-hist" />);
    const user = userEvent.setup();
    const editBtns = await screen.findAllByRole("button", { name: "编辑并重发" });
    await user.click(editBtns[1]);
    // 改写文本
    await user.clear(input());
    await user.type(input(), "问题二（改）");
    await user.click(screen.getByRole("button", { name: "发送" }));
    const msgs = useSessionStore.getState().runtime["k1"]!.messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toEqual({ role: "user", text: "问题二（改）" });
    // 破坏性操作 warn 留痕（F-12-1 测试要求）
    expect(logger.warn).toHaveBeenCalledWith("chat", "edit-resend", expect.objectContaining({ index: 2 }));
    // 编辑横幅退出
    expect(screen.queryByTestId("edit-banner")).not.toBeInTheDocument();
  });
});

describe("F-12-2 提问卡数据流", () => {
  it("onElicitation（form）→ AskCard 渲染 → 提交 → resolver 收到 accept+answers", async () => {
    let elicitHandler: ((params: any) => Promise<any>) | undefined;
    mockOpen.mockImplementation(async (...args: any[]) => {
      elicitHandler = args[5];
      return fakeSession([]);
    });
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    // 触发建会话（发送一条消息）
    const user = userEvent.setup();
    await user.type(input(), "开始");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(elicitHandler).toBeDefined());

    // agent 发起 form 提问
    const promise = elicitHandler!({
      mode: "form",
      message: "请选择",
      requestedSchema: {
        type: "object" as const,
        properties: {
          choice: { type: "string", title: "用哪个方案？", enum: ["方案 A", "方案 B"] },
        },
        required: ["choice"],
      },
    });

    // 提问卡出现
    const card = await screen.findByTestId("ask-card");
    expect(card).toBeInTheDocument();
    expect(screen.getByText("用哪个方案？")).toBeInTheDocument();
    // 未答提交禁用 → 答案提交
    const submitBtn = screen.getByRole("button", { name: "提交回答" });
    expect(submitBtn).toBeDisabled();
    await user.click(screen.getByText("方案 B"));
    await user.click(submitBtn);

    const resp = await promise;
    expect(resp.action).toBe("accept");
    expect((resp as any).content).toEqual({ "用哪个方案？": "方案 B" });
    // 卡片退出
    await waitFor(() => expect(screen.queryByTestId("ask-card")).not.toBeInTheDocument());
  });

  it("拒绝回答 → resolver 收到 decline", async () => {
    let elicitHandler: ((params: any) => Promise<any>) | undefined;
    mockOpen.mockImplementation(async (...args: any[]) => {
      elicitHandler = args[5];
      return fakeSession([]);
    });
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(elicitHandler).toBeDefined());

    const promise = elicitHandler!({
      mode: "form",
      message: "请选择",
      requestedSchema: {
        type: "object" as const,
        properties: {},
      },
    });
    await screen.findByTestId("ask-card");
    await user.click(screen.getByRole("button", { name: "拒绝回答" }));
    const resp = await promise;
    expect(resp.action).toBe("decline");
  });

  it("URL/自定义 mode → 直接 decline，不出提问卡", async () => {
    let elicitHandler: ((params: any) => Promise<any>) | undefined;
    mockOpen.mockImplementation(async (...args: any[]) => {
      elicitHandler = args[5];
      return fakeSession([]);
    });
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    const user = userEvent.setup();
    await user.type(input(), "hi");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(elicitHandler).toBeDefined());

    const resp = await elicitHandler!({ mode: "url", message: "去这", url: "https://x" });
    expect(resp.action).toBe("decline");
    expect(screen.queryByTestId("ask-card")).not.toBeInTheDocument();
  });
});
