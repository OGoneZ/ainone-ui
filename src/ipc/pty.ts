// 终端会话前端封装（P23）：PTY 胶水层。
//
// tauri-pty（tauri-plugin-pty 的官方 API 包）暴露 node-pty 形状的 IPty，
// 本层在其上做三件归一化，TerminalPanel 只面向这里的薄接口：
//   1. 默认 shell 解析 —— invoke terminal_default_shell（Rust 侧 $SHELL 兜底 /bin/zsh），
//      并注入增强 PATH（env_path 增强目录 + 进程 PATH，与 harness 子进程行为一致）
//   2. 生命周期登记 —— spawn 成功后 terminal_track 登记、kill/退出后 terminal_untrack，
//      Rust 侧应用退出清理以登记表为事实源
//   3. 数据形状 —— onData 的 Uint8Array 经 UTF-8 解码为 string（xterm.write 接受
//      string/Uint8Array，这里统一 string 简化主题与缓冲处理；二进制图形序列
//      允许有损，harness session 同样不支持）

import { invoke } from "@tauri-apps/api/core";
import { spawn as ptySpawn, type IPty } from "tauri-pty";

export interface TerminalSession {
  pid: number;
  /** PTY 输出（UTF-8 解码后的字符串块） */
  onData: (cb: (data: string) => void) => void;
  /** 子进程退出（exitCode 来自插件 exitstatus 阻塞 wait） */
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

/** 增强 PATH 注入（对齐 agent.rs spawn env 语义）：桌面应用 PATH 常缺
 *  用户工具目录，终端里 node/bun/omp 等需与 agent 子进程同等可达。
 *  前端取进程 PATH 原样透传；Rust enhanced_path 不经 IPC 暴露，故由
 *  default_shell 命令一并返回（见 terminal.rs ShellSpec）。 */
interface ShellSpec {
  program: string;
  args: string[];
  path: string;
}

async function defaultShellSpec(): Promise<ShellSpec> {
  try {
    return await invoke<ShellSpec>("terminal_default_shell_with_path");
  } catch {
    // 旧后端 / 非 Tauri 环境（测试）兜底
    return {
      program: "/bin/zsh",
      args: ["-l"],
      path: typeof process !== "undefined" ? process.env?.PATH ?? "" : "",
    };
  }
}

/** 创建终端会话：spawn 默认 shell 进 PTY，返回归一化的会话句柄。
 *  spawn 失败（shell 不存在等）直接抛错，由调用方负责 UI 提示。 */
export async function createTerminal(opts: CreateTerminalOptions = {}): Promise<TerminalSession> {
  const spec = await defaultShellSpec();
  const pty: IPty = ptySpawn(spec.program, spec.args, {
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: opts.cwd && opts.cwd.length > 0 ? opts.cwd : undefined,
    env: { PATH: spec.path },
  });

  // 生命周期登记（失败不影响会话本体，仅退出清理缺一条记录）
  invoke("terminal_track", { pid: pty.pid }).catch(() => {});
  const untrack = () => invoke("terminal_untrack", { pid: pty.pid }).catch(() => {});

  const decoder = new TextDecoder("utf-8");
  const dataCbs = new Set<(data: string) => void>();
  const exitCbs = new Set<(code: number) => void>();

  const dataDispose = pty.onData((bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    for (const cb of dataCbs) cb(text);
  });
  const exitDispose = pty.onExit(({ exitCode }) => {
    untrack();
    for (const cb of exitCbs) cb(exitCode);
  });

  return {
    pid: pty.pid,
    onData(cb) {
      dataCbs.add(cb);
    },
    onExit(cb) {
      exitCbs.add(cb);
    },
    write(data) {
      pty.write(data);
    },
    resize(cols, rows) {
      // 行列合法才下发（xterm fit 在 0 尺寸容器时可能给出 0）
      if (cols > 0 && rows > 0) pty.resize(cols, rows);
    },
    kill() {
      dataDispose.dispose();
      exitDispose.dispose();
      untrack();
      pty.kill();
    },
  };
}
