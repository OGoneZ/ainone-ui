// 管道桥接层：把 Rust 自管子进程（agent_spawn）的双向字节流，转成 ACP SDK 需要的 Web Stream。
//
// 背景（plan.md DEC-5 / DEC-7）：
//   - SDK 的 ndJsonStream(output, input) 需要一对 Readable/Writable<Uint8Array>
//   - 子进程由 Rust 层自管（不受 capability scope 白名单限制），通过 Channel 把
//     stdout/stderr/退出事件流式推给前端；前端经 agent_stdin_write 写 stdin
//   - 本层做两件事：事件 → ReadableStream；WritableStream → agent_stdin_write
//   - 不做 JSONL 行切分——交给 SDK 内置 LineBuffer（只按 LF 切行，正是 DEC-5 语义）

import { invoke, Channel } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";

export interface HarnessProcess {
  agentId: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: WritableStream<Uint8Array>;
  /** 子进程退出信号，code 为 null 表示被信号终止 */
  closed: Promise<{ code: number | null }>;
  /** stderr 尾迹（环形缓冲最后 2KB），启动失败时拼进错误信息 */
  stderrTail: () => string;
}

/** Rust 侧 AgentEvent 序列化后的形状（serde tag="event"） */
type AgentEvent =
  | { event: "stdout"; payload: number[] }
  | { event: "stderr"; payload: number[] }
  | { event: "error"; payload: string }
  | { event: "terminated"; payload: { code: number | null } };

function bytes(payload: number[] | string): Uint8Array {
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  return Uint8Array.from(payload);
}

/**
 * spawn 一个 harness 子进程，并把它暴露成 SDK 可用的双向字节流。
 */
export async function spawnHarness(
  program: string,
  args: string[],
  cwd: string,
): Promise<HarnessProcess> {
  // 用 deferred 方式暴露 stdout/stderr 流的 controller 与「退出」resolve
  let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let onClosed!: (v: { code: number | null }) => void;
  const closed = new Promise<{ code: number | null }>((res) => {
    onClosed = res;
  });

  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      stdoutCtrl = c;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      stderrCtrl = c;
    },
  });

  const channel = new Channel<AgentEvent>();
  // stderr 环形缓冲：只留最后 2KB，供启动失败时提示（P4）
  let stderrTailStr = "";
  channel.onmessage = (msg) => {
    switch (msg.event) {
      case "stdout":
        stdoutCtrl.enqueue(bytes(msg.payload));
        break;
      case "stderr":
        stderrTailStr = (stderrTailStr + new TextDecoder().decode(Uint8Array.from(msg.payload))).slice(-2048);
        stderrCtrl.enqueue(bytes(msg.payload));
        break;
      case "error":
        // 进程级错误：中断 stdout 流并标记结束
        logger.error("bridge", `agent:${agentId} 进程错误`, msg.payload);
        try {
          stdoutCtrl.error(new Error(msg.payload));
        } catch {
          /* ignore */
        }
        break;
      case "terminated":
        logger.info("bridge", `agent:${agentId} 进程退出 code=${msg.payload.code}`);
        try {
          stdoutCtrl.close();
        } catch {
          /* ignore */
        }
        try {
          stderrCtrl.close();
        } catch {
          /* ignore */
        }
        onClosed({ code: msg.payload.code });
        break;
    }
  };

  const agentId = await invoke<number>("agent_spawn", {
    program,
    args,
    cwd,
    onEvent: channel,
  });
  logger.info("bridge", "spawn 成功", { agentId, program, args, cwd });

  // stdin：写字节 → agent_stdin_write
  const stdin = new WritableStream<Uint8Array>({
    async write(chunk) {
      await invoke("agent_stdin_write", { agentId, data: Array.from(chunk) });
    },
  });

  return { agentId, stdout, stderr, stdin, closed, stderrTail: () => stderrTailStr };
}
