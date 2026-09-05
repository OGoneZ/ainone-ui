// @vitest-environment jsdom
// HistoryPanel 测试（P16 · F-16-2，AC-P16-4/5）：锚点渲染/跳转事件/回溯事件/空态。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// logger 内部走 @tauri-apps/plugin-log（依赖 Tauri invoke），jsdom 无 Tauri 运行时 → mock 掉
vi.mock("@/lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { HistoryPanel } from "./HistoryPanel";
import type { ChatMsg } from "@/acp/message-log";

const user = (text: string): ChatMsg => ({ role: "user", text });
const assistant = (): ChatMsg => ({
  role: "assistant",
  blocks: [{ kind: "text", text: "回复" }],
});

afterEach(cleanup);

describe("HistoryPanel（DEC-49）", () => {
  it("渲染锚点列表：序号 + 首行摘要 + 完整文本 title", () => {
    const msgs: ChatMsg[] = [user("帮我看看构建\n第二行"), assistant(), user("跑一下测试")];
    render(<HistoryPanel messages={msgs} />);
    expect(screen.getByText("历史消息 · 2")).toBeInTheDocument();
    expect(screen.getByText("帮我看看构建")).toBeInTheDocument();
    expect(screen.getByText("跑一下测试")).toBeInTheDocument();
    // 完整文本进 title（多行消息 title 含换行后的第二行）
    expect(screen.getByText("帮我看看构建").closest("button")?.getAttribute("title")).toContain("第二行");
  });

  it("点击条目 → 发 ainone:jump-message（含 index）", async () => {
    const spy = vi.fn();
    window.addEventListener("ainone:jump-message", spy);
    const msgs: ChatMsg[] = [user("第一问"), assistant(), user("第二问")];
    render(<HistoryPanel messages={msgs} />);
    await userEvent.click(screen.getByText("第二问"));
    expect(spy).toHaveBeenCalledTimes(1);
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.index).toBe(2);
    window.removeEventListener("ainone:jump-message", spy);
  });

  it("点击回溯小钮 → 发 ainone:rewind-request（含 index）", async () => {
    const spy = vi.fn();
    window.addEventListener("ainone:rewind-request", spy);
    const msgs: ChatMsg[] = [user("第一问"), assistant(), user("第二问")];
    render(<HistoryPanel messages={msgs} />);
    await userEvent.click(screen.getByRole("button", { name: "回溯到第 1 条消息" }));
    const detail = (spy.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.index).toBe(0);
    window.removeEventListener("ainone:rewind-request", spy);
  });

  it("用户消息不足 2 条 → 空态提示", () => {
    render(<HistoryPanel messages={[user("唯一一条"), assistant()]} />);
    expect(screen.getByText(/历史消息会在对话后出现在这里/)).toBeInTheDocument();
    expect(screen.queryByTestId("history-panel")).not.toBeInTheDocument();
  });

  it("assistant-only 会话 → 空态", () => {
    render(<HistoryPanel messages={[assistant(), assistant()]} />);
    expect(screen.getByText(/历史消息会在对话后出现在这里/)).toBeInTheDocument();
  });
});
