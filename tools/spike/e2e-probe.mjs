// E2E 探针：用与 src/acp/session.ts 相同的 SDK 调用路径，验证各 harness 端到端。
// 与 session.ts 唯一的差异：spawn 用 Node child_process，fs 回调用本地 fs（而非 Tauri invoke）。
// 目的：证明「协议 + SDK + 流式」这层（也是用户报错的 cwd 层）对所有 harness 正确。

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HARNESSES = [
  { name: "omp", program: "omp", args: ["acp", "--model", "duo-king-6.6"] },
  { name: "claude-code", program: "claude-agent-acp", args: [] },
  // codex 裸启动无响应，先用超时判定，失败不阻塞其它
  { name: "codex", program: "codex-acp", args: [] },
];

function run(program, args, cwd) {
  return spawn(program, args, { cwd, stdio: ["pipe", "pipe", "inherit"] });
}

async function probeHarness(h, cwd) {
  const child = run(h.program, h.args, cwd);
  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout);

  const clientImpl = {
    async requestPermission(params) {
      const allow = params.options.find((o) => o.kind === "allow_once");
      return { outcome: { outcome: "selected", optionId: allow?.optionId ?? params.options[0].optionId } };
    },
    async readTextFile({ path: p }) {
      return { content: fs.readFileSync(p, "utf8") };
    },
    async writeTextFile({ path: p, content }) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content ?? "");
      return {};
    },
  };

  const app = acp
    .client({ name: "ainone-e2e" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => clientImpl.requestPermission(ctx.params))
    .onRequest(acp.methods.client.fs.readTextFile, (ctx) => clientImpl.readTextFile(ctx.params))
    .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => clientImpl.writeTextFile(ctx.params));

  const stream = acp.ndJsonStream(input, output);

  const result = await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: "ainone-e2e", version: "0.1.0" },
    });
    const session = await ctx.buildSession(cwd).start();
    session.prompt("say exactly: ACP-OK");
    let text = "";
    for (;;) {
      const msg = await session.nextUpdate();
      if (msg.kind === "stop") {
        return { ok: text.includes("ACP-OK"), text, stopReason: msg.stopReason, agent: init.agentInfo?.name };
      }
      if (msg.update.sessionUpdate === "agent_message_chunk" && msg.update.content.type === "text") {
        text += msg.update.content.text;
      }
    }
  });

  child.kill();
  return result;
}

const cwd = path.resolve("/Users/zhubaoduo/dev/ainone-ui");
let pass = 0, fail = 0;
for (const h of HARNESSES) {
  const label = `${h.name} (${h.program}${h.args.length ? " " + h.args.join(" ") : ""})`;
  try {
    const result = await Promise.race([
      probeHarness(h, cwd),
      new Promise((_, rej) => setTimeout(() => rej(new Error("超时 60s")), 60_000)),
    ]);
    if (result.ok) {
      console.log(`✅ ${label} → agent=${result.agent} stopReason=${result.stopReason}`);
      pass++;
    } else {
      console.log(`❌ ${label} → 未收到 ACP-OK，实际=${JSON.stringify(result.text).slice(0, 80)}`);
      fail++;
    }
  } catch (e) {
    console.log(`❌ ${label} → ${e.message}`);
    fail++;
  }
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
