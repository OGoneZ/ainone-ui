// session/load 恢复验证（AC-P2-4 暗号续聊）
// 流程：new → prompt 记住暗号 → 记录 sessionId → kill → 重新 spawn → load → prompt 问暗号
// 复用 session.ts 的自建队列逻辑（request prompt + onNotification session/update）

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";

const CWD = path.resolve("/Users/zhubaoduo/dev/ainone-ui");

function spawnAgent(program, args) {
  return spawn(program, args, { cwd: CWD, stdio: ["pipe", "pipe", "inherit"] });
}

async function connect(child) {
  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout);
  const client = {
    async requestPermission(params) {
      const allow = params.options.find((o) => o.kind === "allow_once");
      return { outcome: { outcome: "selected", optionId: allow?.optionId ?? params.options[0].optionId } };
    },
    async readTextFile({ path: p }) { return { content: fs.readFileSync(p, "utf8") }; },
    async writeTextFile({ path: p, content }) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content ?? ""); return {};
    },
  };
  const app = acp.client({ name: "ainone-e2e" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => client.requestPermission(ctx.params))
    .onRequest(acp.methods.client.fs.readTextFile, (ctx) => client.readTextFile(ctx.params))
    .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => client.writeTextFile(ctx.params));

  const connection = app.connect(acp.ndJsonStream(input, output));
  const init = await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "ainone-e2e", version: "0.1.0" },
  });
  return { connection, init };
}

// 自建 update 队列（与 session.ts 同构）
function makeQueue(connection) {
  let bound = "";
  const q = [];
  const waiters = [];
  connection.onNotification !== undefined; // no-op
  return null;
}

const PROGRAM = "claude-agent-acp";
const ARGS = [];
const SECRET = "banana-77";

// 第一段：new + prompt 记住暗号
const child1 = spawnAgent(PROGRAM, ARGS);
{
  const { connection, init } = await connect(child1);
  console.log("① agent:", init.agentInfo?.name);
  const resp = await connection.agent.request(acp.methods.agent.session.new, { cwd: CWD, mcpServers: [] });
  const sid = resp.sessionId;
  console.log("① sessionId:", sid);

  let text = "";
  const updates = [];
  connection.onNotification && (() => {})();
  // 用 ActiveSession 简化（load 前用 SDK 标准流程走通 new+prompt）
  // 但 ActiveSession 在 connect() 后需 buildSession；这里直接 prompt + 手动收 update
  const promptP = connection.agent.request(acp.methods.agent.session.prompt, {
    sessionId: sid, prompt: [{ type: "text", text: `记住密码是 ${SECRET}，之后我提问时复述它` }],
  });
  // 手动收 update：轮询 connection 没有公开订阅，改用 ActiveSession
  child1.kill();
  console.log("① 未用标准队列，改为次轮统一验证");
}

// 直接重写：用 SDK ActiveSession 走完 new + prompt，再用 load 验证
async function runFull() {
  // 段1：新会话记住暗号
  const c1 = spawnAgent(PROGRAM, ARGS);
  const conn1 = await connect(c1);
  const s1 = await conn1.connection.agent.buildSession(CWD).start();
  let sid = s1.sessionId;
  await s1.prompt(`记住密码是 ${SECRET}，之后我提问时复述它。现在只需回复：已记住`);
  let t1 = "";
  for (;;) {
    const m = await s1.nextUpdate();
    if (m.kind === "stop") break;
    if (m.update.sessionUpdate === "agent_message_chunk" && m.update.content.type === "text") t1 += m.update.content.text;
  }
  console.log("① new 会话:", sid, "| 回复:", JSON.stringify(t1.slice(0, 60)));
  s1.dispose();
  c1.kill();

  // 段2：load 恢复，问暗号
  const c2 = spawnAgent(PROGRAM, ARGS);
  const conn2 = await connect(c2);
  await conn2.connection.agent.request(acp.methods.agent.session.load, { sessionId: sid, cwd: CWD, mcpServers: [] });
  const s2 = await conn2.connection.agent.buildSession(CWD).start();
  await s2.prompt("我让你记住的密码是什么？");
  let t2 = "";
  for (;;) {
    const m = await s2.nextUpdate();
    if (m.kind === "stop") break;
    if (m.update.sessionUpdate === "agent_message_chunk" && m.update.content.type === "text") t2 += m.update.content.text;
  }
  console.log("② load 后提问回复:", JSON.stringify(t2.slice(0, 200)));
  console.log("② 暗号命中:", t2.includes(SECRET));
  s2.dispose();
  c2.kill();
  return t2.includes(SECRET);
}

const pass = await runFull();
console.log(pass ? "\n✅ session/load 恢复验证通过（暗号命中）" : "\n❌ 暗号未命中");
process.exit(pass ? 0 : 1);
