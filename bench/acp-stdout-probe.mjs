// 基准 D：真实 harness stdout 写模式实测 —— 直接 spawn claude-agent-acp（本仓 claude-code
// 适配器的真实程序），发一条诱导长输出的 prompt，按「tauri-plugin-shell read_raw_bytes 粒度」
// 记录每次可读块的到达时刻与大小。这近似 pump_events 逐条转发的消息频率。
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const proc = spawn("/Users/zhubaoduo/.bun/bin/claude-agent-acp", [], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "/tmp",
});

let id = 0;
const send = (obj) => {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, ...obj }) + "\n");
};
const notify = (method, params) => {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
};

// ---- 到达侧统计：accumulated read events（近似 Rust 侧 BufReader 读块）----
const reads = []; // { t, bytes }
let buf = Buffer.alloc(0);
let lineCount = 0;
const lines = []; // { t, bytes } 每个 NDJSON 行
let t0 = null;
let promptSentAt = null;
let done = false;

proc.stdout.on("data", (chunk) => {
  if (t0 === null) t0 = performance.now();
  reads.push({ t: performance.now(), bytes: chunk.length });
  buf = Buffer.concat([buf, chunk]);
  let idx;
  while ((idx = buf.indexOf(0x0a)) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    lineCount++;
    if (line.length > 0) lines.push({ bytes: line.length });
  }
});

proc.stderr.on("data", (d) => process.stderr.write(d));

const steps = [];
function step(name, fn) { steps.push([name, fn]); }

step("initialize", () => send({ method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } } }));
step("wait-init", () => {});
step("newSession", () => send({ method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }));
step("wait-session", () => {});
step("prompt-long-output", () => {
  promptSentAt = performance.now();
  send({ method: "session/prompt", params: {
    sessionId: globalThis.__sid,
    prompt: [{ type: "text", text: "请连续输出一段 8000 字左右的关于操作系统的科普讲解，使用 markdown，包含多个二级标题、列表和一个 TS 代码块（代码块 60 行以上）。不要停顿，直接开始，不要任何前置说明。" }],
  } });
});

let phase = 0;
const interval = setInterval(() => {
  if (phase < steps.length) {
    const [name, fn] = steps[phase];
    if (name === "wait-init" && !globalThis.__inited) return;
    if (name === "wait-session" && !globalThis.__sid) return;
    if (name === "prompt-long-output" && !globalThis.__sid) return;
    fn();
    phase++;
  }
}, 150);

proc.stdout.on("data", (chunk) => {
  const s = chunk.toString();
  try {
    for (const line of s.split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id === 1 && msg.result) globalThis.__inited = true;
      if (msg.id === 2 && msg.result?.sessionId) globalThis.__sid = msg.result.sessionId;
    }
  } catch {}
});

// 捕捉 chunk 计数：统计 session/update 里 agent_message_chunk 条数与文本量
let chunkCount = 0;
let chunkBytes = 0;
let updateCount = 0;
const origOnData = proc.stdout.listeners("data").slice();
// 再挂一个监听器做应用层统计（Node EventEmitter 支持多监听）
proc.stdout.on("data", (chunk) => {
  const s = chunk.toString();
  for (const line of s.split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === "session/update") {
        updateCount++;
        const u = msg.params?.update;
        if (u?.sessionUpdate === "agent_message_chunk") {
          chunkCount++;
          chunkBytes += (u.content?.text ?? "").length;
        }
      }
      if (msg.method === "session/prompt" || msg.result?.stopReason) done = true;
    } catch {}
  }
});

setTimeout(() => {
  const dur = promptSentAt ? (performance.now() - promptSentAt) / 1000 : 0;
  // 只统计 prompt 之后的 read 事件
  const pread = reads.filter((r) => r.t >= (t0 ?? 0));
  const promptReads = promptSentAt ? reads.filter((r) => r.t >= promptSentAt) : [];
  const sizes = promptReads.map((r) => r.bytes);
  const total = sizes.reduce((a, b) => a + b, 0);
  sizes.sort((a, b) => a - b);
  const med = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
  // 读事件频率：按 100ms 桶
  const buckets = new Map();
  for (const r of promptReads) {
    const b = Math.floor((r.t - promptSentAt) / 100);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const peakBucket = Math.max(0, ...buckets.values());
  console.log(`
===== claude-agent-acp stdout 写模式实测 =====
prompt 后持续: ${dur.toFixed(1)}s | 完成: ${done}
read 块数(≈Rust 转发条数): ${promptReads.length} | 平均 ${promptReads.length ? (promptReads.length / dur).toFixed(1) : 0} 条/s（峰值 100ms 桶: ${peakBucket} 条 ≈ ${peakBucket * 10}/s 瞬时）
read 块大小: med=${med}B total=${(total / 1024).toFixed(1)}KB
NDJSON 行数: ${lineCount}
session/update 总数: ${updateCount} | agent_message_chunk: ${chunkCount} 条 / ${chunkBytes} 字符
→ 若逐条转发：每条 read = 1 次 webview.eval；chunk 粒度 = ${chunkCount ? (chunkBytes / chunkCount).toFixed(0) : 0} 字符/chunk
`);
  proc.kill();
  process.exit(0);
}, 90_000);

proc.on("exit", (c) => {
  clearInterval(interval);
});
