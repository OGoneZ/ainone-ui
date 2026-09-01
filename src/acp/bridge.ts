// 管道桥接层：把 tauri plugin-shell 的子进程事件流，转成 ACP SDK 需要的 Web Stream。
//
// 背景（见 plan.md DEC-5 / DEC-7）：
//   - SDK 的 ndJsonStream(output, input) 需要一对 Readable/Writable<Uint8Array>
//   - plugin-shell 的 Command 只提供 EventEmitter 事件（stdout/stderr.on('data')）
//     和 child.write(bytes) 回调式写入
//   - 本层负责这两者之间的转换，且不做任何 JSONL 行切分——那交给 SDK 内置的
//     LineBuffer（它只用 LF 切行，正是我们需要的语义）

import { Command, Child } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";

/** 归一化 plugin-shell 事件载荷为 Uint8Array（raw 模式给 number[]，text 给 string） */
function toBytes(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (Array.isArray(payload)) return Uint8Array.from(payload);
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  return new Uint8Array();
}

export interface HarnessProcess {
  child: Child;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  /** 子进程退出信号，code 为 null 表示被信号终止 */
  closed: Promise<{ code: number | null }>;
}

/**
 * spawn 一个 harness 子进程，并把它暴露成 SDK 可用的双向字节流。
 * @param program 可执行名（须在 capability 的 shell scope 中预注册，如 "omp"）
 * @param args    启动参数，如 ["acp", "--model", "duo-king-6.6"]
 * @param cwd     工作目录
 */
export async function spawnHarness(
  program: string,
  args: string[],
  cwd: string,
): Promise<HarnessProcess> {
  // 基础环境（含 ~/.bun/bin 的 PATH），避免 plugin-shell 清空环境导致 omp 找不到 bun
  const env = await invoke<Record<string, string>>("get_base_env");

  // encoding: 'raw' → stdout/stderr 事件给原始字节，让 SDK 的 LineBuffer 自行切行
  const command = Command.create(program, args, {
    cwd,
    env,
    encoding: "raw" as never,
  });

  const child = await command.spawn();

  // ---- stdout → ReadableStream<Uint8Array> ---------------------------------
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      command.stdout.on("data", (payload) => {
        controller.enqueue(toBytes(payload));
      });
      command.on("error", (err) => controller.error(new Error(String(err))));
      command.on("close", () => {
        try {
          controller.close();
        } catch {
          /* 已关闭则忽略 */
        }
      });
    },
  });

  // ---- stderr → ReadableStream<Uint8Array>（仅用于日志，不喂 SDK）---------
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      command.stderr.on("data", (payload) => {
        controller.enqueue(toBytes(payload));
      });
      command.on("close", () => {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });
    },
  });

  // ---- stdin → WritableStream<Uint8Array> ----------------------------------
  const stdin = new WritableStream<Uint8Array>({
    async write(chunk) {
      // plugin-shell 的 write 接受 number[]（raw 字节），不接受 Uint8Array
      await child.write(Array.from(chunk));
    },
  });

  // ---- 退出信号 -------------------------------------------------------------
  const closed = new Promise<{ code: number | null }>((resolve) => {
    command.on("close", (payload) => resolve({ code: payload.code }));
    command.on("error", () => resolve({ code: null }));
  });

  return { child, stdout, stderr, stdin, closed };
}
