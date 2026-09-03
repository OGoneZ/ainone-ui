// @vitest-environment jsdom
// AskCard 提问卡测试（F-12-2，AC-P12-6/7/8）：
// 渲染单选/多选/Other → 未全答提交禁用 → 作答提交 → 已回答态 + 答案回传；拒绝走 decline。
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AskCard } from "./AskCard";
import type { AskQuestion } from "../acp/askCard";

afterEach(cleanup);

const qs: AskQuestion[] = [
  { question: "用哪个方案？", options: ["方案 A", "方案 B"], multi: false },
  { question: "要哪些功能？", options: ["日志", "通知"], multi: true },
];

describe("AskCard（F-12-2）", () => {
  it("渲染问题与选项（单选/多选/Other 齐全）", () => {
    render(<AskCard questions={qs} onAnswer={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByText("用哪个方案？")).toBeInTheDocument();
    expect(screen.getByText("方案 A")).toBeInTheDocument();
    expect(screen.getByText("要哪些功能？")).toBeInTheDocument();
    // 每题都有 Other
    expect(screen.getAllByText("其他").length).toBe(2);
  });

  it("未全部作答 → 提交禁用；全答后可提交并回传答案", async () => {
    const onAnswer = vi.fn();
    render(<AskCard questions={qs} onAnswer={onAnswer} onDecline={vi.fn()} />);
    const user = userEvent.setup();
    const submitBtn = screen.getByRole("button", { name: "提交回答" });
    expect(submitBtn).toBeDisabled();

    // 答第 1 题（单选）
    await user.click(screen.getByText("方案 B"));
    expect(submitBtn).toBeDisabled(); // 第 2 题未答
    // 答第 2 题（多选）
    await user.click(screen.getByText("日志"));
    expect(submitBtn).toBeEnabled();

    await user.click(submitBtn);
    expect(onAnswer).toHaveBeenCalledWith({
      "用哪个方案？": "方案 B",
      "要哪些功能？": ["日志"],
    });
    expect(await screen.findByTestId("ask-answered")).toBeInTheDocument();
  });

  it("拒绝回答 → onDecline 被调，卡片进入已回答态", async () => {
    const onDecline = vi.fn();
    render(<AskCard questions={qs} onAnswer={vi.fn()} onDecline={onDecline} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "拒绝回答" }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("ask-answered")).toBeInTheDocument();
  });

  it("已回答态下操作按钮消失（防重复提交）", async () => {
    render(<AskCard questions={qs} onAnswer={vi.fn()} onDecline={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "拒绝回答" }));
    expect(screen.queryByRole("button", { name: "提交回答" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拒绝回答" })).not.toBeInTheDocument();
  });
});
