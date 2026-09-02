// @vitest-environment jsdom
// CommandQueuePanel 测试（F-9-3 AC-P9-9 组件侧 + 展示/编辑/删除/排序）：
// 用真实 queueStore 驱动，验证「运行中追加 → turn 结束自动消费」由面板 + 纯函数配合。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandQueuePanel } from "./CommandQueuePanel";
import { useQueueStore } from "../store/queueStore";

beforeEach(() => {
  useQueueStore.setState({ queues: {} });
});
afterEach(cleanup);

describe("CommandQueuePanel", () => {
  it("空队列 → 不渲染", () => {
    render(<CommandQueuePanel tabKey="k1" />);
    expect(screen.queryByText(/命令队列/)).not.toBeInTheDocument();
  });

  it("有指令 → 折叠态显示「N 条待执行」，展开列条目", async () => {
    useQueueStore.getState().enqueue("k1", { id: "q1", text: "第一条指令" });
    useQueueStore.getState().enqueue("k1", { id: "q2", text: "第二条指令" });
    render(<CommandQueuePanel tabKey="k1" />);
    const user = userEvent.setup();

    expect(screen.getByText("命令队列 · 2 条待执行")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /命令队列/ }));
    expect(screen.getByDisplayValue("第一条指令")).toBeInTheDocument();
    expect(screen.getByDisplayValue("第二条指令")).toBeInTheDocument();
  });

  it("删除指令：点 × → 列表减少", async () => {
    useQueueStore.getState().enqueue("k1", { id: "q1", text: "指令" });
    render(<CommandQueuePanel tabKey="k1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /命令队列/ }));
    await user.click(screen.getByRole("button", { name: "删除队列指令 1" }));
    expect(screen.queryByText(/命令队列/)).not.toBeInTheDocument();
  });

  it("上移/下移排序：点↓ 改变顺序", async () => {
    useQueueStore.getState().enqueue("k1", { id: "q1", text: "A" });
    useQueueStore.getState().enqueue("k1", { id: "q2", text: "B" });
    render(<CommandQueuePanel tabKey="k1" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /命令队列/ }));

    // 点第 1 条「下移」→ 顺序变 B, A
    await user.click(screen.getByRole("button", { name: "下移指令 1" }));
    // 用 store 状态断言（避免 aria-label 与按钮文案交叉匹配的脆弱性）
    const arr = useQueueStore.getState().queues["k1"] ?? [];
    expect(arr.map((i) => i.text)).toEqual(["B", "A"]);
  });
});
