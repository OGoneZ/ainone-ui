// 握手级探测核心：纯协议层，零 Tauri 依赖（可在 Node/vitest 直接测）。
//
// 借鉴 AionUi 的两级连接测试（fail_cli / fail_acp）：
//   - level "spawn"     —— 程序起不来/立即退出（未安装、运行时错误）
//   - level "handshake" —— 进程活着但 ACP initialize 握手失败/超时
//
// 与 session-core 同构：streams/closed/stderrTail 依赖注入（DEC-8）。

import * as acp from "@agentclientprotocol/sdk";
import type { Streams } from "./session-core";

export interface AgentInfo {
  name?: string;
  version?: string;
  title?: string | null;
}

export type ProbeResult =
  | { ok: true; agentInfo: AgentInfo; protocolVersion: number | string }
  | { ok: false; level: "spawn" | "handshake"; message: string };

export interface ProbeDeps {
  streams: Streams;
  /** 子进程退出信号（bridge.ts 的 closed），先于握手完成 = spawn 级失败 */
  closed?: Promise<{ code: number | null }>;
  /** stderr 尾迹（环形缓冲最后一段），失败时拼进错误信息 */
  stderrTail?: () => string;
  /** 握手超时，默认 8000ms */
  timeoutMs?: number;
}

/** 组装「进程退出 + stderr 尾迹」的失败文案 */
function spawnFailMessage(code: number | null, stderrTail?: () => string): string {
  const tail = stderrTail?.().trim();
  const codeStr = code === null ? "被信号终止" : `退出码 ${code}`;
  return tail
    ? `进程启动后立即退出（${codeStr}）。stderr 尾部：${tail}`
    : `进程启动后立即退出（${codeStr}），无 stderr 输出。`;
}

export async function probeInitialize(deps: ProbeDeps): Promise<ProbeResult> {
  const { streams, closed, stderrTail } = deps;
  const timeoutMs = deps.timeoutMs ?? 8_000;

  const app = acp.client({ name: "ainone-ui-probe" });
  const stream = acp.ndJsonStream(streams.stdin, streams.stdout);
  const connection = app.connect(stream);

  const initPromise = connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
      elicitation: { form: {} },
    },
    clientInfo: { name: "ainone-ui", version: "0.1.0" },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("__probe_timeout__")), timeoutMs);
  });

  try {
    const resp = await Promise.race([
      initPromise,
      // closed 缺省用永不 settle 的占位（不能用立即 throw 的 promise，会秒赢 race）
      closed?.then((c) => {
        throw new Error(`__probe_spawn__${JSON.stringify(c)}`);
      }) ?? new Promise<never>(() => {}),
      timeoutPromise,
    ]);
    return {
      ok: true,
      agentInfo: (resp as acp.InitializeResponse).agentInfo ?? {},
      protocolVersion: (resp as acp.InitializeResponse).protocolVersion,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "__probe_timeout__") {
      return { ok: false, level: "handshake", message: `initialize 握手超时（${timeoutMs}ms），进程可能卡住` };
    }
    if (msg.startsWith("__probe_spawn__")) {
      try {
        const code = JSON.parse(msg.slice("__probe_spawn__".length)).code as number | null;
        return { ok: false, level: "spawn", message: spawnFailMessage(code, stderrTail) };
      } catch {
        return { ok: false, level: "spawn", message: spawnFailMessage(null, stderrTail) };
      }
    }
    // initialize 本身 reject（协议错误/流中断）——区分「进程已死」与「协议失败」
    if (closed) {
      const settled = await Promise.race([
        closed.then(() => "closed" as const),
        new Promise<"alive">((r) => setTimeout(() => r("alive"), 50)),
      ]);
      if (settled === "closed") {
        const c = await closed;
        return { ok: false, level: "spawn", message: spawnFailMessage(c.code, stderrTail) };
      }
    }
    const tail = stderrTail?.().trim();
    return {
      ok: false,
      level: "handshake",
      message: tail ? `握手失败：${msg}。stderr 尾部：${tail}` : `握手失败：${msg}`,
    };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      connection.close();
    } catch {
      /* ignore */
    }
  }
}
