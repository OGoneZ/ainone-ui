// steering 协议基础验证：cancel 当前 turn 后，同一会话能继续发新 prompt。
// 这是 ChatPanel「打断并发送」依赖的核心协议假设。

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { createAcpSession } from "../../src/acp/session-core";

const CWD = path.resolve("/Users/zhubaoduo/dev/ainone-ui");
const child = spawn("claude-agent-acp", [], { cwd: CWD, stdio: ["pipe", "pipe", "inherit"] });
child.stdin?.on("error", () => {});

const session = await createAcpSession({
  streams: {
    stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: new ReadableStream<Uint8Array>(),
  },
  cwd: CWD,
  onPermission: async (params: any) => {
    const o = params.options.find((x: any) => x.kind === "allow_once");
    return { outcome: { outcome: "selected", optionId: o?.optionId ?? params.options[0].optionId } };
  },
  ipc: {
    fsRead: (p) => Promise.resolve(fs.readFileSync(p, "utf8")),
    fsWrite: (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); return Promise.resolve(); },
    kill: () => Promise.resolve(child.kill()),
  },
});

// 第一轮：长任务开头就 cancel
const t0 = Date.now();
const firstP = session.prompt("从 1 数到 1000，逐一列出每个数字", () => {});
setTimeout(() => session.cancel(), 1500); // 1.5s 后打断
await firstP;
console.log("① cancel 后第一轮结束，耗时", ((Date.now() - t0) / 1000).toFixed(1) + "s");

// 第二轮：cancel 后继续发新 prompt
let text = "";
await session.prompt("回复：STEER-OK", (e) => { if (e.type === "agent_text") text += e.text; });
console.log("② 第二轮回复命中 STEER-OK:", text.includes("STEER-OK"));

await session.dispose();
process.exit(text.includes("STEER-OK") ? 0 : 1);
