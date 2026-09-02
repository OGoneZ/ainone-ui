// 并行隔离验证（AC-P2-3 协议层）：两个 harness 同时跑，各自 update 不串流。
// 复用生产 session-core，验证「多进程并行 + 每会话独立队列」的隔离性。

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { createAcpSession } from "../../src/acp/session-core";

const CWD = path.resolve("/Users/zhubaoduo/dev/ainone-ui");

const HARNESSES = [
  { name: "omp", program: "omp", args: ["acp", "--model", "duo-king-6.6"], secret: "ORANGE-11" },
  { name: "claude-code", program: "claude-agent-acp", args: [], secret: "BLUE-22" },
];

function spawnAgent(h) {
  return spawn(h.program, h.args, { cwd: CWD, stdio: ["pipe", "pipe", "inherit"] });
}
function makeStreams(child: any) {
  return {
    stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: new ReadableStream<Uint8Array>(),
  };
}
async function allowPermission(params: any) {
  const o = params.options.find((x: any) => x.kind === "allow_once");
  return { outcome: { outcome: "selected", optionId: o?.optionId ?? params.options[0].optionId } };
}

async function runOne(h: any): Promise<{ name: string; hit: boolean; crossed: boolean }> {
  const child = spawnAgent(h);
  const session = await createAcpSession({
    streams: makeStreams(child),
    cwd: CWD,
    onPermission: allowPermission,
    ipc: {
      fsRead: (p) => Promise.resolve(fs.readFileSync(p, "utf8")),
      fsWrite: (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); return Promise.resolve(); },
      kill: () => Promise.resolve(child.kill()),
    },
  });
  let text = "";
  await session.prompt(`你的代号是 ${h.secret}。现在只回复你的代号，不要提其他代号。`, (e) => {
    if (e.type === "agent_text") text += e.text;
  });
  const clean = text.replace(/Notice.*$/s, "").trim();
  const hit = clean.includes(h.secret);
  // 串流检测：是否混入了另一个 harness 的代号
  const other = HARNESSES.find((x) => x.secret !== h.secret)!;
  const crossed = clean.includes(other.secret);
  await session.dispose();
  return { name: h.name, hit, crossed };
}

console.log("并行启动 2 个 harness（彼此独立会话语义）…");
const results = await Promise.all(HARNESSES.map(runOne));
for (const r of results) {
  console.log(`  ${r.name}: 代号命中=${r.hit} 串流=${r.crossed}`);
}
const allHit = results.every((r) => r.hit);
const noCross = results.every((r) => !r.crossed);
console.log(allHit && noCross ? "\n✅ 并行隔离验证通过（各自命中，无串流）" : "\n❌ 并行隔离失败");
process.exit(allHit && noCross ? 0 : 1);
