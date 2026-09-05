// @vitest-environment jsdom
// FilePreview 测试（P16 · F-16-1，AC-P16-1/3）：类型分流渲染 + 关闭 + 超纲/超大占位。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// mock Tauri 插件（invoke 走全局 mockIpc 兜底，见 setup.ts/mockIpc.ts）
vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
}));
// mock shiki（单测不测真实高亮，只测分流与降级路径）
vi.mock("shiki/core", () => ({
  createHighlighterCore: vi.fn(() =>
    Promise.resolve({
      codeToHtml: () => "<pre class='shiki'>highlighted</pre>",
      loadLanguage: () => Promise.resolve(),
    }),
  ),
}));
vi.mock("shiki/engine/javascript", () => ({
  createJavaScriptRegexEngine: vi.fn(),
}));
// Streamdown mock（真实组件体积大，分流测试只需占位）
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children?: React.ReactNode }) => <div data-testid="streamdown">{children}</div>,
}));

import { FilePreview } from "./FilePreview";
import { mockTauriIpc } from "@/test/mockIpc";
import { openPath } from "@tauri-apps/plugin-opener";

const mockRead = vi.fn();

beforeEach(() => {
  // FilePreview 里 invoke("fd_read") 走 __TAURI_INTERNALS__；用 handlers 可编程
  mockTauriIpc({
    handlers: { fd_read: (args: { path: string }) => mockRead(args.path) },
  });
  mockRead.mockReset();
});
afterEach(cleanup);

describe("FilePreview（DEC-48）", () => {
  it("头部显示文件名 + 类型徽标；× 关闭回调", async () => {
    mockRead.mockResolvedValue("hello");
    const onClose = vi.fn();
    const { rerender } = render(<FilePreview path="/w/notes.md" onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId("streamdown")).toBeInTheDocument());
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("markdown")).toBeInTheDocument();

    rerender(<FilePreview path="/w/notes.md" onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("code 文件读入后渲染（mock shiki 输出 pre）", async () => {
    mockRead.mockResolvedValue("fn main() {}");
    render(<FilePreview path="/w/main.rs" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/highlighted/)).toBeInTheDocument());
    expect(screen.getByText("code")).toBeInTheDocument();
  });

  it("未知扩展名 → text 纯文本兜底", async () => {
    mockRead.mockResolvedValue("plain content");
    render(<FilePreview path="/w/data.xyz" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/plain content/)).toBeInTheDocument());
    expect(screen.getByText("text")).toBeInTheDocument();
  });

  it("binary 类型不读内容 → 占位 + 系统打开按钮（AC-P16-1/3）", async () => {
    render(<FilePreview path="/w/report.pdf" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "用系统应用打开" })).toBeInTheDocument());
    expect(mockRead).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "用系统应用打开" }));
    expect(openPath).toHaveBeenCalledWith("/w/report.pdf");
  });

  it("文本超 1MB → too-large 占位（AC-P16-3）", async () => {
    mockRead.mockResolvedValue("x".repeat(1_000_001));
    render(<FilePreview path="/w/big.log" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/文件过大/)).toBeInTheDocument());
  });

  it("读取失败 → 错误提示（fail loud）", async () => {
    mockRead.mockRejectedValue("permission denied");
    render(<FilePreview path="/w/secret" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/读取失败/)).toBeInTheDocument());
  });

  it("全屏按钮切换 → aria-label 变化；全屏态无拖拽手柄；Esc 先退全屏", async () => {
    mockRead.mockResolvedValue("hello");
    const onClose = vi.fn();
    render(<FilePreview path="/w/a.txt" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText("a.txt")).toBeInTheDocument());

    // 手柄存在（非全屏态）
    expect(screen.getByRole("separator", { name: "拖拽调整预览宽度" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "全屏预览" }));
    expect(screen.getByRole("button", { name: "退出全屏" })).toBeInTheDocument();
    // 全屏态隐藏拖拽手柄
    expect(screen.queryByRole("separator", { name: "拖拽调整预览宽度" })).not.toBeInTheDocument();

    // Esc 第一击退全屏（不关闭）
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "全屏预览" })).toBeInTheDocument();

    // Esc 第二击关闭
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("Esc 关闭", async () => {
    mockRead.mockResolvedValue("hi");
    const onClose = vi.fn();
    render(<FilePreview path="/w/a.txt" onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
