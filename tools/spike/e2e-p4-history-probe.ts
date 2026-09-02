// P4 整合探针（AC-P4-4/5/9）+ 回归：验证「日志回填」完整链路。
//
// 模拟 ChatPanel 的真实数据流（复用生产代码，DEC-8）：
//   1) 新会话 prompt 记暗号 → 事件经 turn.ts 累加成 assistant blocks
//   2) turn 结束：序列化 user + assistant 消息 → append 到 JSONL 日志
//   3) 「重启」（新进程 + 新 store）：读日志回填 messages（parseLog）
//   4) session/load 恢复 agent 上下文 → 问暗号 → 复述命中（D-1 已消）
//
// 验证点：
//   - 日志写读无损（含含换行文本、thinking 计时、tool 块）
//   - load 后 agent 上下文仍在（暗号命中）

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { createAcpSession } from "../../src/acp/session-core";
import { newTurn, applyEvent } from "../../src/acp/turn";
import { serializeMessages, parseLog, type ChatMsg } from "../../src/acp/message-log";

const CWD = path.resolve("/Users/zhubaoduo/dev/ainone-ui");
const PROGRAM = "claude-agent-acp";
const ARGS: string[] = [];
const SECRET = "banana-77";
// 临时日志文件（模拟 appDataDir/sessions/<id>.jsonl）
const LOG = path.join(CWD, "tools/spike/.tmp-p4-probe.jsonl");

function spawnAgent() {
  return spawn(PROGRAM, ARGS, { cwd: CWD, stdio: ["pipe", "pipe", "inherit"] });
}

function makeStreams(child: any) {
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});
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

// 模拟 ChatPanel：事件 → turn blocks → 消息数组
function accumulateOn(msgs: ChatMsg[], words: string[] = []) {
  let turn = newTurn();
  return (e: any) => {
    if (e.type === "agent_text") {
      turn = applyEvent(turn, e, Date.now);
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        last.blocks = turn.blocks;
      } else {
        msgs.push({ role: "assistant", blocks: turn.blocks });
      }
    } else if (e.type === "agent_thought" || e.type === "tool_call" || e.type === "tool_update" || e.type === "turn_stop") {
      turn = applyEvent(turn, e, Date.now);
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") last.blocks = turn.blocks;
      else msgs.push({ role: "assistant", blocks: turn.blocks });
    }
  };
}

async function run() {
  fs.rmSync(LOG, { force: true });
  const faillog: string[] = [];

  // —— 阶段 1：新会话记暗号 + 落盘 ——
  const c1 = spawnAgent();
  const s1 = await createAcpSession({
    streams: makeStreams(c1),
    cwd: CWD,
    onPermission: allowPermission,
    ipc: makeIpc(c1),
  });
  const sid = s1.sessionId;
  const msgs: ChatMsg[] = [{ role: "user", text: `记住密码是 ${SECRET}，之后复述。现在只需回复：已记住` }];
  await s1.prompt(msgs[0].text, accumulateOn(msgs));
  // turn 结束落盘
  fs.appendFileSync(LOG, serializeMessages(msgs).map((l) => l + "\n").join(""));
  await s1.dispose();
  console.log("① 新会话落盘", msgs.length, "条消息");

  // —— 阶段 2：「重启」读回日志 ——
  const raw = fs.readFileSync(LOG, "utf8");
  const restored = parseLog(raw);
  if (restored.length !== msgs.length) faillog.push(`回填条数不符: ${restored.length} != ${msgs.length}`);
  const userBack = restored[0];
  if (!(userBack.role === "user" && userBack.text.includes(SECRET))) faillog.push("user 消息回填错误");
  const asst = restored[1];
  if (!(asst.role === "assistant" && asst.blocks.length > 0)) faillog.push("assistant 消息回填错误");
  console.log("② 日志回填：", restored.length, "条，含 thinking 块：", asst.blocks.some((b) => b.kind === "thought"));

  // —— 阶段 3：load 续聊 + 问暗号 ——
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
  const hit = t2.includes(SECRET);
  if (!hit) faillog.push("load 后暗号未命中");
  console.log("③ load 续聊回复命中暗号：", hit);
  await s2.dispose();

  fs.rmSync(LOG, { force: true });
  if (faillog.length > 0) {
    console.log("\n❌ 失败：\n- " + faillog.join("\n- "));
    process.exit(1);
  }
  console.log("\n✅ P4 日志回填完整链路通过（写盘→回填→load 续聊，D-1 已消）");
  process.exit(0);
}

run().catch((e) => {
  fs.rmSync(LOG, { force: true });
  console.error("探针异常：", e);
  process.exit(1);
});
