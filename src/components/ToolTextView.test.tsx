// @vitest-environment jsdom
// P11 F-R6：工具输出格式化组件测试——JSON pretty / ANSI 彩色 / 折叠。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ToolTextView } from "./ChatPanel";

vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => cleanup());

describe("ToolTextView（F-R6）", () => {
  it("合法 JSON pretty-print 后展示（AC-R6-2）", () => {
    render(<ToolTextView text='{"a":1,"b":[2,3]}' />);
    // pretty 化后键值以缩进形式出现
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
  });

  it("ANSI 色码渲染为彩色 span，无残留转义字样（AC-R6-1）", () => {
    // 真实 ESC 字符（）；agent 终端输出里的转义序列是控制字符而非字面量
    const esc = "\u001b";
    const { container } = render(<ToolTextView text={`${esc}[31m红色错误${esc}[0m 完成`} />);
    expect(container.querySelector("span[style]")).not.toBeNull();
    expect(container.textContent).toContain("红色错误");
    // 原始转义序列不应以字面形式残留在 DOM
    expect(container.textContent).not.toContain("[31m");
  });

  it("普通文本原样展示不误判为 JSON（AC-R6-3）", () => {
    render(<ToolTextView text="npm error code E404" />);
    expect(screen.getByText(/npm error code E404/)).toBeInTheDocument();
  });

  it("超长输出默认折叠，点击展开全部（AC-R6-4）", () => {
    const long = "x".repeat(2500);
    render(<ToolTextView text={long} />);
    const foldBtn = screen.getByRole("button", { name: /展开全部（2500 字符）/ });
    expect(foldBtn).toBeInTheDocument();
    fireEvent.click(foldBtn);
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });
});
