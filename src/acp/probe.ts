// 握手级探测 Tauri 绑定：spawnHarness → probeInitialize → agent_kill。
//
// 消费 bridge.ts 的 closed Promise 与 stderr 尾迹，产出两级错误
// （spawn / handshake，见 probe-core.ts）。

import { invoke } from "@tauri-apps/api/core";
import { spawnHarness, type HarnessProcess } from "./bridge";
import { probeInitialize, type ProbeResult } from "./probe-core";
import type { Adapter } from "@/ipc/adapters";

/** stderr 环形缓冲容量（字节） */
const STDERR_TAIL_BYTES = 2048;

function collectStderrTail(proc: HarnessProcess): () => string {
  const dec = new TextDecoder();
  let tail = "";
  void (async () => {
    const reader = proc.stderr.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      tail = (tail + dec.decode(value)).slice(-STDERR_TAIL_BYTES);
    }
  })();
  return () => tail;
}

/**
 * 对一条适配器做完整探测：spawn → ACP initialize → kill。
 * 注意：探测期间 harness 进程真实启动，结束后立即回收。
 */
export async function probeAdapter(adapter: Adapter, cwd?: string): Promise<ProbeResult> {
  const workdir = cwd && cwd.length > 0 ? cwd : adapter.cwd;
  let proc: HarnessProcess | null = null;
  try {
    proc = await spawnHarness(adapter.program, adapter.args, workdir);
  } catch (e) {
    // spawn 本身失败（Rust 侧报「未找到程序 …」等）= spawn 级错误
    return { ok: false, level: "spawn", message: e instanceof Error ? e.message : String(e) };
  }
  const stderrTail = collectStderrTail(proc);
  try {
    return await probeInitialize({
      streams: { stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr },
      closed: proc.closed,
      stderrTail,
      timeoutMs: 8_000,
    });
  } finally {
    await invoke("agent_kill", { agentId: proc.agentId }).catch(() => {});
  }
}
