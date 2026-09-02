// session/load 恢复验证（AC-P2-4 暗号续聊）
// 直接复用生产代码 session-core.ts（零 Tauri 依赖的核心），用 bun 运行。
// 这验证的就是前端真正用的协议逻辑，不是复制品。

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { createAcpSession } from "../../src/acp/session-core";

const CWD = path.resolve("/Users/zhubaoduo/dev/ainone-ui");
const PROGRAM = "claude-agent-acp";
const ARGS: string[] = [];
const SECRET = "banana-77";

function spawnAgent() {
  return spawn(PROGRAM, ARGS, { cwd: CWD, stdio: ["pipe", "pipe", "inherit"] });
}

function makeStreams(child: any) {
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

async function run() {
  // 段1：新会话记住暗号
  const c1 = spawnAgent();
  const s1 = await createAcpSession({
    streams: makeStreams(c1),
    cwd: CWD,
    onPermission: allowPermission,
    ipc: makeIpc(c1),
  });
  const sid = s1.sessionId;
  let t1 = "";
  await s1.prompt(`记住密码是 ${SECRET}，之后我提问时复述它。现在只需回复：已记住`, (e) => {
    if (e.type === "agent_text") t1 += e.text;
  });
  console.log("① new 会话:", sid, "| 回复:", JSON.stringify(t1.replace(/Notice.*$/s, "").trim().slice(0, 60)));
  await s1.dispose();

  // 段2：load 恢复，问暗号（新进程 = 模拟重启应用）
  const c2 = spawnAgent();
  const s2 = await createAcpSession({
    streams: makeStreams(c2),
    cwd: CWD,
    onPermission: allowPermission,
    ipc: makeIpc(c2),
    resumeSessionId: sid,
  });
  let t2 = "";
  await s2.prompt("我让你记住的密码是什么？", (e) => {
    if (e.type === "agent_text") t2 += e.text;
  });
  console.log("② load 后提问回复:", JSON.stringify(t2.replace(/Notice.*$/s, "").trim().slice(0, 120)));
  console.log("② 暗号命中:", t2.includes(SECRET));
  await s2.dispose();
  return t2.includes(SECRET);
}

const pass = await run();
console.log(pass ? "\n✅ session/load 恢复验证通过（暗号命中，复用生产 session-core）" : "\n❌ 暗号未命中");
process.exit(pass ? 0 : 1);
