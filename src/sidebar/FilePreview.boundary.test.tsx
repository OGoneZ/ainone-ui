// @vitest-environment jsdom
// P36：FilePreview 局部 ErrorBoundary——渲染异常必须被圈在浮层内（显示错误 + 可关闭），
// 不得炸到父级（2026-09-09 事故：异常穿透到 flexlayout boundary → ChatPanel 卸载 → 会话 dispose）。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn() }));
vi.mock("shiki/core", () => ({ createHighlighterCore: vi.fn() }));
vi.mock("shiki/engine/javascript", () => ({ createJavaScriptRegexEngine: vi.fn() }));
// 让 markdown 渲染必然抛错 → FilePreview 渲染树抛异常
vi.mock("streamdown", () => ({
  Streamdown: () => {
    throw new Error("boom-markdown");
  },
}));

import { FilePreview } from "./FilePreview";
import { mockTauriIpc } from "@/test/mockIpc";

afterEach(cleanup);

describe("FilePreview 局部 ErrorBoundary（P36）", () => {
  it("渲染异常被圈在浮层内：显示错误信息，不向父级传播", async () => {
    mockTauriIpc({ handlers: { fd_read: () => "# hello" } });
    const { baseElement } = render(<FilePreview path="/w/a.md" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/boom-markdown/)).toBeInTheDocument());
    // 错误浮层存在且父容器（body）下只有这一个 filepreview——异常没有炸掉 render 树
    expect(document.querySelector(".filepreview")).toBeTruthy();
    void baseElement;
  });

  it("错误态点关闭 → onClose 回调（浮层可退出）", async () => {
    mockTauriIpc({ handlers: { fd_read: () => "# hello" } });
    const onClose = vi.fn();
    render(<FilePreview path="/w/a.md" onClose={onClose} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "关闭预览" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(onClose).toHaveBeenCalled();
  });
});
