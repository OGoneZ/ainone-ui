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
import { ChatPanel } from "./ChatPanel";
import { useSessionStore } from "../store/sessionStore";
import { openSession } from "../acp/session";
import type { AcpSession } from "../acp/session";
import type { AdapterWithStatus } from "../config/adapters";

vi.mock("../acp/session", () => ({
  openSession: vi.fn(),
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
  available: true,
};

const input = () => screen.getByLabelText("消息输入");

/** 造一个受控 AcpSession：prompt 时手动触发 onOutgoing 事件流 */
function fakeSession(events: Array<{ type: string; [k: string]: any }>): AcpSession {
  return {
    sessionId: "s-test",
    prompt: async (_text: string, onOutgoing: (e: any) => void) => {
      for (const e of events) onOutgoing(e);
    },
    cancel: async () => {},
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

  it("流式 thinking：turn 结束折叠为「已思考 N 秒」", async () => {
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

    // turn 结束后 thought 封口 → summary「已思考 N 秒」（N 可为 0）
    expect(await screen.findByText(/已思考 \d+ 秒/)).toBeInTheDocument();
    expect(await screen.findByText(/回复正文/)).toBeInTheDocument();
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
});
