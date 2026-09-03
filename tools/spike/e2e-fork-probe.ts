// P8 · F-8-5 会话分叉协议验证（AC-P8-25）：真实 harness fork 返回新 sessionId。
// 复用生产 session-core.ts（DEC-8），spike 只观测。

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { createAcpSession } from "../../src/acp/session-core";

const CWD = path.resolve("/Users/zhubaoduo/dev/ainone-ui");
const PROGRAM = "claude-agent-acp";

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

await session.prompt("回复一个字：好", () => {});

let forkedId = "";
let pass = false;
try {
  forkedId = await session.fork(CWD);
  pass = typeof forkedId === "string" && forkedId.length > 0 && forkedId !== session.sessionId;
  console.log("fork 返回新 sessionId:", forkedId, "| 原 sessionId:", session.sessionId);
} catch (e) {
  console.log("❌ fork 失败（harness 可能未实现 session.fork）:", String(e));
}

await session.dispose();
console.log(pass ? "\n✅ session/fork 返回新 sessionId" : "\n❌ 未获得有效新 sessionId");
process.exit(pass ? 0 : 1);
