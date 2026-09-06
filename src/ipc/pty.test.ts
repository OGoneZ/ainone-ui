// pty.ts 胶水单测（P23）：mock 底层 tauri-pty 与 Tauri IPC，验证归一化行为。
//
// 意图（AC-P23-8）：终端生命周期三件套行为正确——
//   1. spawn 参数来自 Rust default shell spec（program/args/path 注入）
//   2. onData 的 Uint8Array 以 UTF-8 流式解码为 string（多字节跨 chunk 不断裂）
//   3. kill/退出后 terminal_untrack 解除登记（Rust 退出清理事实源一致）

import { describe, it, expect, vi, beforeEach } from "vitest";

const { spawnMock, killSpy, resizeSpy, writeSpy, eventHandlers, invokeMock } = vi.hoisted(() => {
  const eventHandlers: { data: ((e: Uint8Array) => void)[]; exit: ((e: { exitCode: number }) => void)[] } = {
    data: [],
    exit: [],
  };
  return {
    eventHandlers,
    spawnMock: vi.fn(() => ({
      pid: 4242,
      onData: (cb: (e: Uint8Array) => void) => {
        eventHandlers.data.push(cb);
        return { dispose: () => {} };
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        eventHandlers.exit.push(cb);
        return { dispose: () => {} };
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    })),
    killSpy: vi.fn(),
    resizeSpy: vi.fn(),
    writeSpy: vi.fn(),
    invokeMock: vi.fn(),
  };
});

vi.mock("tauri-pty", () => ({ spawn: spawnMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { createTerminal } from "./pty";

beforeEach(() => {
  eventHandlers.data = [];
  eventHandlers.exit = [];
  spawnMock.mockClear();
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "terminal_default_shell_with_path") {
      return Promise.resolve({ program: "/bin/zsh", args: ["-l"], path: "/usr/bin:/bin" });
    }
    return Promise.resolve(null);
  });
});

describe("createTerminal", () => {
  it("spawn 参数来自 default shell spec 且 PATH 注入 env", async () => {
    const t = await createTerminal({ cwd: "/tmp/w", cols: 100, rows: 30 });
    expect(t.pid).toBe(4242);
    expect(spawnMock).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-l"],
      expect.objectContaining({ cwd: "/tmp/w", cols: 100, rows: 30, env: { PATH: "/usr/bin:/bin" } }),
    );
    // spawn 成功即登记（Rust 退出清理事实源）
    expect(invokeMock).toHaveBeenCalledWith("terminal_track", { pid: 4242 });
  });

  it("onData 以 UTF-8 流式解码为 string（多字节跨 chunk 不断裂）", async () => {
    const t = await createTerminal();
    const got: string[] = [];
    t.onData((s) => got.push(s));
    // 「中」的 UTF-8 = E4 B8 AD，拆两个 chunk
    eventHandlers.data[0](new Uint8Array([0xe4, 0xb8]));
    eventHandlers.data[0](new Uint8Array([0xad]));
    expect(got.join("")).toBe("中");
  });

  it("resize 忽略非法 0 尺寸（xterm fit 空容器给出 0）", async () => {
    const t = await createTerminal();
    // 拿到底层 pty 实例的 resize 断言
    const underlying = spawnMock.mock.results[0].value as { resize: ReturnType<typeof vi.fn> };
    t.resize(0, 0);
    t.resize(120, 40);
    expect(underlying.resize).toHaveBeenCalledTimes(1);
    expect(underlying.resize).toHaveBeenCalledWith(120, 40);
  });

  it("退出事件触发 onExit 并解除登记", async () => {
    const t = await createTerminal();
    const onExit = vi.fn();
    t.onExit(onExit);
    eventHandlers.exit[0]({ exitCode: 3 });
    expect(onExit).toHaveBeenCalledWith(3);
    expect(invokeMock).toHaveBeenCalledWith("terminal_untrack", { pid: 4242 });
  });

  it("kill 解除登记并调用底层 kill", async () => {
    const t = await createTerminal();
    const underlying = spawnMock.mock.results[0].value as { kill: ReturnType<typeof vi.fn> };
    t.kill();
    expect(underlying.kill).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("terminal_untrack", { pid: 4242 });
  });
});
