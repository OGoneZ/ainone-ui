// @vitest-environment jsdom
// PlanBar 计划栏测试（F-9-1 AC-P9-1/2/3）：
// 注入 plan 事件 → 计划栏出现 + 进度计数；turn_stop → 计划栏消失。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanBar } from "./PlanBar";
import { useSessionStore } from "../store/sessionStore";

beforeEach(() => {
  useSessionStore.setState({ runtime: {}, commands: {} });
});
afterEach(cleanup);

describe("PlanBar", () => {
  it("无 plan（busy 但未收到 plan）→ 不渲染", () => {
    useSessionStore.getState().ensure("k1", "omp");
    useSessionStore.setState((s) => ({ ...s }));
    render(<PlanBar tabKey="k1" />);
    expect(screen.queryByText(/执行计划/)).not.toBeInTheDocument();
  });

  it("注入 plan → 折叠态显示「已完成 0 / 共 N」", () => {
    useSessionStore.getState().ensure("k1", "omp");
    useSessionStore.getState().patch("k1", { busy: true });
    useSessionStore.getState().setPlan("k1", [
      { content: "分析", status: "pending" },
      { content: "实现", status: "pending" },
    ]);
    render(<PlanBar tabKey="k1" />);
    expect(screen.getByText("执行计划 · 已完成 0 / 共 2")).toBeInTheDocument();
  });

  it("plan 全量替换 → 计数实时更新；展开显示条目", async () => {
    useSessionStore.getState().ensure("k1", "omp");
    useSessionStore.getState().patch("k1", { busy: true });
    useSessionStore.getState().setPlan("k1", [
      { content: "分析", status: "completed" },
      { content: "实现", status: "in_progress" },
    ]);
    render(<PlanBar tabKey="k1" />);
    const user = userEvent.setup();

    expect(screen.getByText("执行计划 · 已完成 1 / 共 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /执行计划/ }));
    expect(screen.getByText("分析")).toBeInTheDocument();
    expect(screen.getByText("实现")).toBeInTheDocument();
  });

  it("turn 结束（plan 清空）→ 计划栏消失", () => {
    useSessionStore.getState().ensure("k1", "omp");
    useSessionStore.getState().patch("k1", { busy: true });
    useSessionStore.getState().setPlan("k1", [{ content: "x", status: "pending" }]);
    const { rerender } = render(<PlanBar tabKey="k1" />);
    expect(screen.getByText(/执行计划/)).toBeInTheDocument();

    // 模拟 turn 结束：busy=false + plan=null
    useSessionStore.getState().patch("k1", { busy: false });
    useSessionStore.getState().setPlan("k1", null);
    rerender(<PlanBar tabKey="k1" />);
    expect(screen.queryByText(/执行计划/)).not.toBeInTheDocument();
  });
});
