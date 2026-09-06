// pty.ts 胶水单测（P23，p23g 更新）：mock 底层 invoke/Channel，验证归一化行为。
//
// 意图（AC-P23-8 + P23-D1 修复回归）：终端生命周期与数据通道行为正确——
//   1. spawn 参数来自 Rust default shell spec（program/args/path 注入）
//   2. Channel data 事件以 UTF-8 流式解码为 string（多字节跨 chunk 不断裂）
//   3. kill/resize 走自有命令（terminal_write/resize/kill），不依赖插件轮询

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock, ChannelMock, channelInstances } = vi.hoisted(() => {
  const channelInstances: { onmessage: ((msg: unknown) => void) | null }[] = [];
  return {
    invokeMock: vi.fn(),
    ChannelMock: class {
      onmessage: ((msg: unknown) => void) | null = null;
      constructor() {
        channelInstances.push(this);
      }
    },
    channelInstances,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: ChannelMock,
}));

import { createTerminal } from "./pty";

beforeEach(() => {
  channelInstances.length = 0;
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "terminal_default_shell_with_path") {
      return Promise.resolve({ program: "/bin/zsh", args: ["-l"], path: "/usr/bin:/bin" });
    }
    if (cmd === "terminal_spawn") {
      return Promise.resolve({ terminal_id: 7, pid: 4242 });
    }
    return Promise.resolve(null);
  });
});

describe("createTerminal", () => {
  it("spawn 参数来自 default shell spec 且 PATH 注入 env，cwd 空串传 null", async () => {
    const t = await createTerminal({ cwd: "/tmp/w", cols: 100, rows: 30 });
    expect(t.terminalId).toBe(7);
    expect(t.pid).toBe(4242);
    expect(invokeMock).toHaveBeenCalledWith("terminal_spawn", {
      program: "/bin/zsh",
      args: ["-l"],
      cwd: "/tmp/w",
      env: { PATH: "/usr/bin:/bin" },
      cols: 100,
      rows: 30,
      onEvent: expect.anything(),
    });
  });

  it("Channel data 事件以 UTF-8 流式解码（多字节跨 chunk 不断裂）", async () => {
    const t = await createTerminal();
    const ch = channelInstances[0];
    const got: string[] = [];
    t.onData((s) => got.push(s));
    // 「中」的 UTF-8 = E4 B8 AD，拆两个事件
    ch.onmessage!({ event: "data", payload: [0xe4, 0xb8] });
    ch.onmessage!({ event: "data", payload: [0xad] });
    expect(got.join("")).toBe("中");
  });

  it("exited 事件触发 onExit 回调", async () => {
    const t = await createTerminal();
    const ch = channelInstances[0];
    const onExit = vi.fn();
    t.onExit(onExit);
    ch.onmessage!({ event: "exited", payload: { code: 3 } });
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it("write/resize/kill 走自有命令（terminal_write/resize/kill）", async () => {
    const t = await createTerminal();
    t.write("ls\r");
    t.resize(120, 40);
    t.resize(0, 0); // 0 尺寸不下发
    t.kill();
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).toHaveBeenCalledWith("terminal_write", { terminalId: 7, data: "ls\r" });
    expect(invokeMock).toHaveBeenCalledWith("terminal_resize", { terminalId: 7, cols: 120, rows: 40 });
    expect(invokeMock).not.toHaveBeenCalledWith("terminal_resize", expect.objectContaining({ cols: 0 }));
    expect(invokeMock).toHaveBeenCalledWith("terminal_kill", { terminalId: 7 });
  });
});
