// @vitest-environment jsdom
// PermCard 测试（F-21-4，AC-P21-4）：
// 标题/选项全量渲染（kind 决定视觉分级）；点击按钮回传 ACP optionId（不是猜出来的 allow/reject）。
// WHY：选项由 harness 给出，客户端转译会丢「总是允许」类选项——回传必须保真 optionId。
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PermCard } from "./PermCard";

afterEach(cleanup);

const opts = [
  { optionId: "opt-allow-always", name: "总是允许", kind: "allow_always" },
  { optionId: "opt-allow-once", name: "允许一次", kind: "allow_once" },
  { optionId: "opt-reject-once", name: "拒绝一次", kind: "reject_once" },
];

describe("PermCard（F-21-4）", () => {
  it("渲染工具标题与 harness 全部选项按钮", () => {
    render(<PermCard title="rm -rf /tmp/x" options={opts} onDecide={vi.fn()} />);
    expect(screen.getByTestId("perm-card")).toBeInTheDocument();
    expect(screen.getByText("rm -rf /tmp/x")).toBeInTheDocument();
    for (const o of opts) {
      expect(screen.getByRole("button", { name: o.name })).toBeInTheDocument();
    }
  });

  it("点击选项回传原样 optionId（保真转传，不映射 allow/reject）", async () => {
    const onDecide = vi.fn();
    render(<PermCard title="t" options={opts} onDecide={onDecide} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "总是允许" }));
    expect(onDecide).toHaveBeenCalledWith("opt-allow-always");
    await user.click(screen.getByRole("button", { name: "拒绝一次" }));
    expect(onDecide).toHaveBeenLastCalledWith("opt-reject-once");
  });

  it("kind 缺失的选项仍渲染（中性样式，不崩）", () => {
    render(
      <PermCard
        title="t"
        options={[{ optionId: "x", name: "神秘选项", kind: null }]}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "神秘选项" })).toBeInTheDocument();
  });
});
