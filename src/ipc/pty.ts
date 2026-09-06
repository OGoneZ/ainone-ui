// 终端会话前端封装（P23）：PTY 胶水层。
//
// p23g 重构（修复 P23-D1）：后端已改为 portable-pty + 自管读线程 + Channel 推送
// （terminal.rs），本层从「tauri-pty 包的 read 轮询」切换到「Channel 事件」：
//   - createTerminal → invoke terminal_spawn（program/args/env 来自 default shell
//     spec，与 harness 子进程同等增强 PATH），返回 terminalId/pid
//   - onData/onExit → 同一 Channel 的 data/exited 事件（对齐 bridge.ts 模式）
//   - write/resize/kill → 自有命令，不再与读通道抢锁（P23-D1 根因已消除）
// 数据形状：Channel 推 UTF-8 字节块，这里流式解码为 string（多字节跨 chunk 不断裂）。

import { invoke, Channel } from "@tauri-apps/api/core";

export interface TerminalSession {
  /** Rust 侧会话句柄（write/resize/kill 均以此为键） */
  terminalId: number;
  pid: number;
  /** PTY 输出（UTF-8 解码后的字符串块） */
  onData: (cb: (data: string) => void) => void;
  /** shell 已退出（code 来自 Rust 读线程 wait()） */
  onExit: (cb: (code: number) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

export interface CreateTerminalOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** default shell spec（Rust terminal_default_shell_with_path 返回） */
interface ShellSpec {
  program: string;
  args: string[];
  path: string;
}

/** Rust TerminalEvent 序列化后的形状（serde tag="event"） */
type TerminalEvent =
  | { event: "data"; payload: number[] }
  | { event: "exited"; payload: { code: number } };

async function defaultShellSpec(): Promise<ShellSpec> {
  try {
    return await invoke<ShellSpec>("terminal_default_shell_with_path");
  } catch {
    // 非 Tauri 环境（测试）兜底
    return {
      program: "/bin/zsh",
      args: ["-l"],
      path: (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PATH ?? "",
    };
  }
}

/** 创建终端会话：spawn 默认 shell 进 PTY，返回归一化的会话句柄。
 *  spawn 失败（shell 不存在等）直接抛错，由调用方负责 UI 提示。 */
export async function createTerminal(opts: CreateTerminalOptions = {}): Promise<TerminalSession> {
  const spec = await defaultShellSpec();

  const dataCbs = new Set<(data: string) => void>();
  const exitCbs = new Set<(code: number) => void>();
  const decoder = new TextDecoder("utf-8");

  const channel = new Channel<TerminalEvent>();
  channel.onmessage = (msg) => {
    switch (msg.event) {
      case "data":
        // payload 经 serde 是 number[]，流式解码保证多字节跨 chunk 不断裂
        for (const cb of dataCbs) cb(decoder.decode(Uint8Array.from(msg.payload), { stream: true }));
        break;
      case "exited":
        for (const cb of exitCbs) cb(msg.payload.code);
        break;
    }
  };

  const spawned = await invoke<{ terminal_id: number; pid: number }>("terminal_spawn", {
    program: spec.program,
    args: spec.args,
    cwd: opts.cwd && opts.cwd.length > 0 ? opts.cwd : null,
    env: { PATH: spec.path },
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    onEvent: channel,
  });

  return {
    terminalId: spawned.terminal_id,
    pid: spawned.pid,
    onData(cb) {
      dataCbs.add(cb);
    },
    onExit(cb) {
      exitCbs.add(cb);
    },
    write(data) {
      invoke("terminal_write", { terminalId: spawned.terminal_id, data }).catch(() => {});
    },
    resize(cols, rows) {
      // 行列合法才下发（xterm fit 在 0 尺寸容器时可能给出 0）
      if (cols > 0 && rows > 0) {
        invoke("terminal_resize", { terminalId: spawned.terminal_id, cols, rows }).catch(() => {});
      }
    },
    kill() {
      invoke("terminal_kill", { terminalId: spawned.terminal_id }).catch(() => {});
    },
  };
}
