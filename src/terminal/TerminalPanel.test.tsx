// @vitest-environment jsdom
// TerminalPanel 组件测试（P23）：jsdom 冒烟——mock PTY 与 xterm 渲染链路，
// 验证生命周期三态（运行中 / spawn 失败 / 已退出+重建）与清理行为。
//
// 意图（AC-P23-8）：终端 Tab 的失败与退出必须可见可恢复，且关闭 Tab 时
// PTY 一定被 kill（防 shell 残留，AC-P23-2 的组件级兜底）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { createTerminalMock, exitListeners, dataListeners } = vi.hoisted(() => {
  const exitListeners: ((code: number) => void)[] = [];
  const dataListeners: ((s: string) => void)[] = [];
  return {
    exitListeners,
    dataListeners,
    createTerminalMock: vi.fn(async () => ({
      pid: 1234,
      onData: (cb: (s: string) => void) => {
        dataListeners.push(cb);
      },
      onExit: (cb: (code: number) => void) => {
        exitListeners.push(cb);
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    })),
  };
});

vi.mock("@/ipc/pty", () => ({ createTerminal: createTerminalMock }));

// xterm 是 ESM 包且 jsdom 下 open() 需要 rAF/尺寸，mock 掉仿真器本体——
// 这里测的是面板接线与状态机，不是 xterm 内部（xterm 自身有完整测试）。
vi.mock("@xterm/xterm", () => {
  const terminalInstances: {
    opts: Record<string, unknown>;
    dispose: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  }[] = [];
  return {
    Terminal: class {
      cols = 80;
      rows = 24;
      options: Record<string, unknown> = {};
      dispose = vi.fn();
      write = vi.fn();
      open = vi.fn();
      onData = vi.fn();
      loadAddon = vi.fn();
      focus = vi.fn();
      constructor(opts: Record<string, unknown>) {
        this.options = opts;
        terminalInstances.push({ opts, dispose: this.dispose, write: this.write });
      }
      static instances = terminalInstances;
    },
  };
});

vi.mock("@xterm/addon-fit", () => {
  const fits: { fit: ReturnType<typeof vi.fn> }[] = [];
  return {
    FitAddon: class {
      fit = vi.fn();
      constructor() {
        fits.push({ fit: this.fit });
      }
      static instances = fits;
    },
  };
});

import { TerminalPanel } from "./TerminalPanel";
import { useTerminalStore } from "@/store/terminalStore";

beforeEach(() => {
  createTerminalMock.mockClear();
  exitListeners.length = 0;
  dataListeners.length = 0;
  useTerminalStore.getState().drop("t1");
});

afterEach(() => {
  cleanup();
});

describe("TerminalPanel", () => {
  it("挂载即 spawn 终端会话（cwd 透传）并 ensure runtime", async () => {
    render(<TerminalPanel tabKey="t1" cwd="/tmp/w" active />);
    await vi.waitFor(() => {
      expect(createTerminalMock).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: "/tmp/w" }),
      );
    });
    expect(useTerminalStore.getState().runtime["t1"]).toEqual({ exited: false, exitCode: null });
    expect(document.querySelector(".terminal-host")).toBeInTheDocument();
    // 运行中无状态条
    expect(screen.queryByTestId("terminal-exit-bar")).not.toBeInTheDocument();
  });

  it("spawn 失败显示错误条（可感知，不白屏）", async () => {
    createTerminalMock.mockRejectedValueOnce(new Error("未找到程序 /bin/zsh"));
    render(<TerminalPanel tabKey="t1" active />);
    await vi.waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("终端启动失败：未找到程序 /bin/zsh");
    });
  });

  it("退出事件 → 状态条展示（非 0 码带 code）+ runtime 标记；重新打开重建会话", async () => {
    render(<TerminalPanel tabKey="t1" active />);
    await vi.waitFor(() => expect(exitListeners.length).toBe(1));

    act(() => exitListeners[0](3));
    expect(screen.getByTestId("terminal-exit-bar")).toHaveTextContent("进程已退出（code 3）");
    expect(useTerminalStore.getState().runtime["t1"]).toEqual({ exited: true, exitCode: 3 });

    // 重新打开 → 新会话
    await userEvent.click(screen.getByRole("button", { name: "重新打开" }));
    await vi.waitFor(() => expect(createTerminalMock).toHaveBeenCalledTimes(2));
    expect(useTerminalStore.getState().runtime["t1"].exited).toBe(false);
  });

  it("卸载 kill PTY 并 drop runtime（防 shell 残留）", async () => {
    const killSpy = vi.fn();
    createTerminalMock.mockImplementationOnce(async () => ({
      pid: 1234,
      onData: (cb: (s: string) => void) => dataListeners.push(cb),
      onExit: (cb: (code: number) => void) => exitListeners.push(cb),
      write: vi.fn(),
      resize: vi.fn(),
      kill: killSpy,
    }));
    const { unmount } = render(<TerminalPanel tabKey="t1" active />);
    await vi.waitFor(() => expect(createTerminalMock).toHaveBeenCalledTimes(1));
    unmount();
    expect(killSpy).toHaveBeenCalled();
    expect(useTerminalStore.getState().runtime["t1"]).toBeUndefined();
  });

  it("0 退出码的状态条不带 code 尾注", async () => {
    render(<TerminalPanel tabKey="t1" active />);
    await vi.waitFor(() => expect(exitListeners.length).toBe(1));
    act(() => exitListeners[0](0));
    // span 文本恰好是「进程已退出」（按钮文案另算）
    const bar = screen.getByTestId("terminal-exit-bar");
    expect(bar.querySelector("span")).toHaveTextContent(/^进程已退出$/);
  });
});
