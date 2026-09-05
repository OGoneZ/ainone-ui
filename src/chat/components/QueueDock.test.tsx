// @vitest-environment jsdom
// QueueDock 测试（P16 · F-16-3，AC-P16-6/8/10）：
// 徽标/展开/编辑/删除/立即发；dnd-kit 拖拽手势在 jsdom 无法真实模拟——
// 合并/重排以 store action 直接断言（queue.test.ts 覆盖纯函数）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { QueueDock } from "./QueueDock";
import { useQueueStore } from "@/store/queueStore";

const item = (id: string, text: string) => ({ id, text });

beforeEach(() => {
  useQueueStore.setState({ queues: {} });
});
afterEach(cleanup);

describe("QueueDock（DEC-50）", () => {
  it("空队列不渲染任何浮层", () => {
    const { container } = render(<QueueDock tabKey="t1" busy={false} onSendNow={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("收起态渲染「队列 N」徽标；点击展开卡片", async () => {
    useQueueStore.setState({ queues: { t1: [item("a", "任务一"), item("b", "任务二")] } });
    render(<QueueDock tabKey="t1" busy={false} onSendNow={vi.fn()} />);
    const badge = screen.getByRole("button", { name: /命令队列 2 条待执行/ });
    expect(badge).toHaveTextContent("队列 2");
    await userEvent.click(badge);
    expect(screen.getByText("任务一")).toBeInTheDocument();
    expect(screen.getByText("任务二")).toBeInTheDocument();
  });

  it("删除条目 → store 移除；删空后浮层整体消失", async () => {
    useQueueStore.setState({ queues: { t1: [item("a", "任务一")] } });
    render(<QueueDock tabKey="t1" busy={false} onSendNow={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /命令队列 1 条/ }));
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(useQueueStore.getState().queues["t1"]).toEqual([]),
    );
    // 队列空 → 整个 dock 不渲染
    expect(screen.queryByTestId("queue-dock")).not.toBeInTheDocument();
  });

  it("点击文本进入编辑，Enter 提交 → store.edit 生效", async () => {
    useQueueStore.setState({ queues: { t1: [item("a", "旧文本")] } });
    render(<QueueDock tabKey="t1" busy={false} onSendNow={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /命令队列 1 条/ }));
    await userEvent.click(screen.getByText("旧文本"));
    const input = screen.getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "新文本{Enter}");
    await waitFor(() =>
      expect(useQueueStore.getState().queues["t1"]?.[0].text).toBe("新文本"),
    );
  });

  it("「立即发」→ 回调该条文本（移出队列发生在 ChatPanel.sendNowSteer，AC-P16-9）", async () => {
    useQueueStore.setState({ queues: { t1: [item("a", "插队任务"), item("b", "其他")] } });
    const onSendNow = vi.fn();
    render(<QueueDock tabKey="t1" busy onSendNow={onSendNow} />);
    await userEvent.click(screen.getByRole("button", { name: /命令队列 2 条/ }));
    await userEvent.click(screen.getAllByRole("button", { name: "立即发送" })[0]);
    await waitFor(() => expect(onSendNow).toHaveBeenCalledWith("插队任务"));
  });

  it("store.merge 直接断言合并落账（拖拽动画不做 jsdom 断言，AC-P16-8）", async () => {
    useQueueStore.setState({
      queues: { t1: [item("a", "任务一"), item("b", "任务二"), item("c", "任务三")] },
    });
    render(<QueueDock tabKey="t1" busy={false} onSendNow={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /命令队列 3 条/ }));
    act(() => {
      useQueueStore.getState().merge("t1", "a", "b");
    });
    const q = useQueueStore.getState().queues["t1"] ?? [];
    expect(q).toHaveLength(2);
    expect(q[0]).toEqual({ id: "a", text: "任务一\n\n任务二" });
    // 合并后 UI 反映新状态（合并条保留 id=a，title 为拼接文本）
    // 合并条保留 id=a，文本拼接「任务一\n\n任务二」（单行截断显示）。
    // jsdom getByTitle/getByText 对含换行 attr/文本匹配有坑 → 按 class 取第一个文本钮断言
    await waitFor(() => {
      const texts = screen.getAllByText(/任务/);
      expect(texts.some((el) => (el.getAttribute("title") ?? "").includes("任务二"))).toBe(true);
    });
  });
});
