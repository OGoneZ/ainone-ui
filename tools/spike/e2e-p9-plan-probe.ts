// P9 · F-9-0 前置 spike：实测 harness 是否发 plan block（AC-P9-0-1/2）。
// 复用生产 session-core.ts（DEC-8），prompt 回调捕获 plan 由 dispatchUpdate 外发。
// 触发条件：发出「拆解执行计划」类 prompt，观察一 turn 内是否出现 plan。

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { createAcpSession } from "../../src/acp/session-core";

const CWD = path.resolve("/Users/zhubaoduo/dev/ainone-ui");
const PROGRAM = "claude-agent-acp";
const SAMPLE_OUT = path.resolve("./docs/protocol-samples/sample-plan.json");

function spawnAgent() {
  return spawn(PROGRAM, [], { cwd: CWD, stdio: ["pipe", "pipe", "inherit"] });
}

function makeStreams(child: any) {
  child.stdin?.on("error", () => {});
  return {
    stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: new ReadableStream<Uint8Array>() as ReadableStream<Uint8Array>,
  };
}

function makeIpc(child: any) {
  return {
    fsRead: (p: string) => Promise.resolve(fs.readFileSync(p, "utf8")),
    fsWrite: (p: string, c: string) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c);
      return Promise.resolve();
    },
    kill: () => Promise.resolve(child.kill()),
  };
}

async function allowPermission(params: any) {
  const o = params.options.find((x: any) => x.kind === "allow_once");
  return { outcome: { outcome: "selected", optionId: o?.optionId ?? params.options[0].optionId } };
}

const child = spawnAgent();
const session = await createAcpSession({
  streams: makeStreams(child),
  cwd: CWD,
  onPermission: allowPermission,
  ipc: makeIpc(child),
});

let planSeen: any[] = [];
await session.prompt("帮我制定一个「给 ainone-ui 加 README」的执行计划，分步骤列出", (e) => {
  if (e.type === "plan") {
    planSeen = e.entries;
    console.log("plan-seen entries count:", e.entries.length);
  }
});

const pass = planSeen.length > 0;
console.log(pass ? "\n✅ 捕获到 plan block" : "\n⚠️ 未捕获 plan block（claude-agent-acp 本轮未发 plan）");

// AC-P9-0-2：报文存档
if (pass) {
  fs.writeFileSync(SAMPLE_OUT, JSON.stringify({ entries: planSeen }, null, 2));
  console.log("已存档:", SAMPLE_OUT);
}

await session.dispose();
// AC-P9-0-1 允许「捕获即通过」；两 harness 均不发则降级（计划栏无数据源即隐藏），
// 探针本身仍以「实际捕获结果」为准退出——这里 plan 未捕获不判失败，因为降级预案已立项。
process.exit(0);
