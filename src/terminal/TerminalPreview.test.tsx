// @vitest-environment jsdom
// P36 S6：终端窗格文件预览——terminal tab 只渲染 TerminalPanel（无 ChatPanel），
// 文件树 ainone:open-file 此前无人接收 → 点击文件无反应。锁定：归属事件开浮层 +
// 别人的忽略 + × 关闭。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@xterm/xterm", () => {
  return {
    Terminal: class {
      cols = 80;
      rows = 24;
      options: Record<string, unknown> = {};
      dispose = vi.fn();
      open = vi.fn();
      loadAddon = vi.fn();
      focus = vi.fn();
      onData = vi.fn();
      constructor(opts: Record<string, unknown>) {
        this.options = opts;
      }
    },
  };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock("@/ipc/pty", () => ({
  createTerminal: vi.fn(() =>
    Promise.resolve({
      write: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
      resize: vi.fn(),
    }),
  ),
}));

import { TerminalPanel } from "./TerminalPanel";
import { mockTauriIpc } from "@/test/mockIpc";

function dispatch(detail: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent("ainone:open-file", { detail }));
  });
}

afterEach(cleanup);

describe("P36 S6 终端窗格文件预览", () => {
  it("detail={path, tabKey=自己} → 打开预览浮层（即使非活跃）", async () => {
    mockTauriIpc({ handlers: { fd_read: () => "file body" } });
    render(<TerminalPanel tabKey="tab-t1" cwd="/ws" active={false} />);
    dispatch({ path: "/ws/a.ts", tabKey: "tab-t1" });
    await waitFor(() => expect(document.querySelector(".filepreview")).toBeTruthy());
  });

  it("detail={path, tabKey=别人} → 忽略（分屏不串扰）", async () => {
    render(<TerminalPanel tabKey="tab-t1" cwd="/ws" active={true} />);
    dispatch({ path: "/ws/a.ts", tabKey: "tab-t2" });
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector(".filepreview")).toBeNull();
  });

  it("旧 string detail（无归属）→ 本窗格接收", async () => {
    mockTauriIpc({ handlers: { fd_read: () => "body" } });
    render(<TerminalPanel tabKey="tab-t1" cwd="/ws" active={true} />);
    dispatch("/ws/legacy.ts");
    await waitFor(() => expect(document.querySelector(".filepreview")).toBeTruthy());
  });

  it("× 关闭浮层", async () => {
    mockTauriIpc({ handlers: { fd_read: () => "body" } });
    render(<TerminalPanel tabKey="tab-t1" cwd="/ws" active={true} />);
    dispatch({ path: "/ws/a.ts", tabKey: "tab-t1" });
    await waitFor(() => expect(document.querySelector(".filepreview")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "关闭预览" }));
    expect(document.querySelector(".filepreview")).toBeNull();
  });
});
