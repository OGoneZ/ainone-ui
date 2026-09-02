// pi 桥接器完整链路验证（AC-P2-2 的 Pi 项）
// pi-acp 是 pi 的 ACP 桥接器（本机 pi 0.84.4 + pi-acp 0.0.33）

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { createAcpSession } from "../../src/acp/session-core";

const CWD = path.resolve("/Users/zhubaoduo/dev/ainone-ui");
const child = spawn("pi-acp", [], { cwd: CWD, stdio: ["pipe", "pipe", "inherit"] });

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

console.log("pi 会话:", session.sessionId);
let text = "";
await session.prompt("say exactly: PI-OK", (e) => { if (e.type === "agent_text") text += e.text; });
console.log("回复尾:", JSON.stringify(text.replace(/Notice.*$/s, "").trim().slice(-80)));
console.log("PI-OK 命中:", text.includes("PI-OK"));
await session.dispose();
process.exit(text.includes("PI-OK") ? 0 : 1);
