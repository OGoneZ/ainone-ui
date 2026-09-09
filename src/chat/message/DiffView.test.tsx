// @vitest-environment jsdom
// F-12-5 diff 行内评论 + P36 修复：评论输入不得用 window.prompt（WKWebView 不支持
// 同步 prompt，用户实测点击卡死）——必须走 Dialog 受控输入。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { DiffView } from "./DiffView";
import type { DiffComment } from "@/chat/logic/diffComments";

afterEach(cleanup);

function renderDiff(onAdd: (c: DiffComment) => void) {
  render(
    <DiffView
      path="/a/b.ts"
      oldText="const a = 1;"
      newText="const a = 2;"
      diffComments={[]}
      onAddDiffComment={onAdd}
    />,
  );
}

describe("DiffView 行内评论（P36 Dialog 修复）", () => {
  it("点评论 → 弹出输入 Dialog（不再依赖 window.prompt）", () => {
    const warn = vi.spyOn(window, "prompt");
    renderDiff(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "评论 /a/b.ts:1" }));
    expect(screen.getByText("评论 /a/b.ts:1")).toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("输入 + 添加评论 → onAddDiffComment 收到 {path, line, lineText, comment}", () => {
    const onAdd = vi.fn();
    renderDiff(onAdd);
    fireEvent.click(screen.getByRole("button", { name: "评论 /a/b.ts:1" }));
    const input = screen.getByPlaceholderText("输入评论内容…");
    fireEvent.change(input, { target: { value: "这里用 const 更好" } });
    fireEvent.click(screen.getByRole("button", { name: "添加评论" }));
    expect(onAdd).toHaveBeenCalledWith({
      path: "/a/b.ts",
      line: 1,
      lineText: "const a = 2;",
      comment: "这里用 const 更好",
    });
  });

  it("Enter 提交；空评论禁用添加；取消关闭", () => {
    const onAdd = vi.fn();
    renderDiff(onAdd);
    fireEvent.click(screen.getByRole("button", { name: "评论 /a/b.ts:1" }));
    const input = screen.getByPlaceholderText("输入评论内容…");
    // 空评论：添加按钮禁用
    expect(screen.getByRole("button", { name: "添加评论" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "ok" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith({
      path: "/a/b.ts",
      line: 1,
      lineText: "const a = 2;",
      comment: "ok",
    });
  });

  it("无 onAddDiffComment → 不渲染任何评论入口（评论能力缺省关闭）", () => {
    render(<DiffView path="/a.ts" oldText="old" newText="new" />);
    expect(screen.queryByRole("button", { name: /评论 / })).toBeNull();
  });
});
