// P8 决策 spike：实测 claude-agent-acp 的协议能力，为 IDEA-002/005/006 采证。
//
// 目标（点亮 6 条 IDEA 里「协议不确定性」的部分）：
//   1. session/fork 是否真实现、返回什么（决定 IDEA-005 分叉可行性）
//   2. usage_update 是否真发、格式（决定 IDEA-002 元数据「上下文占用/token」数据源）
//   3. providers/list 返回什么（决定 IDEA-002 「当前模型」数据源）
//   4. current_mode_update / session_info_update 是否发（IDEA-002 的 model/mode 采集）
//
// 复用生产 session-core.ts（DEC-8），不改动它——spike 只观测。

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { createAcpSession } from "../../src/acp/session-core";

const CWD = path.resolve("/Users/zhubaoduo/dev/ainone-ui");
const PROGRAM = "claude-agent-acp";

function spawnAgent() {
  return spawn(PROGRAM, [], { cwd: CWD, stdio: ["pipe", "pipe", "pipe"] });
}

function makeStreams(child: any) {
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});
  return {
    stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
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

// 捕获一 turn 内出现的所有 update 类型（含 usage_update / current_mode_update）
function makeCapture() {
  const seenUpdateTypes = new Set<string>();
  const usageSamples: any[] = [];
  const modeSamples: any[] = [];
  const infoSamples: any[] = [];
  return {
    seenUpdateTypes,
    usageSamples,
    modeSamples,
    infoSamples,
    onUpdate: (u: acp.SessionNotification) => {
      seenUpdateTypes.add(u.update.sessionUpdate);
      if (u.update.sessionUpdate === "usage_update") {
        usageSamples.push({ used: u.update.used, size: u.update.size, cost: u.update.cost ?? null });
      }
      if (u.update.sessionUpdate === "current_mode_update") {
        modeSamples.push(u.update.currentModeId);
      }
      if (u.update.sessionUpdate === "session_info_update") {
        infoSamples.push(u.update);
      }
    },
  };
}

// 直接底层的 initialize 后，再手动发 fork/providers/usage 观测 —— 需要绕开 session-core 封装的 dispatchUpdate。
// 这里用一个原始连接对：手动走 initialize + new + prompt，观察通知流。
async function rawProbe() {
  const child = spawnAgent();
  const streams = makeStreams(child);
  const ipc = makeIpc(child);

  const app = acp
    .client({ name: "ainone-ui-spike" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => allowPermission(ctx.params))
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({ content: await ipc.fsRead(ctx.params.path) }))
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      await ipc.fsWrite(ctx.params.path, ctx.params.content);
      return {};
    });

  const cap = makeCapture();
  app.onNotification(acp.methods.client.session.update, (ctx) => cap.onUpdate(ctx.params));

  const stream = acp.ndJsonStream(streams.stdin, streams.stdout);
  const conn = app.connect(stream);

  // 读 stderr（可能藏着 fork/usage 的错误）
  const errBuf: string[] = [];
  void (async () => {
    const r = streams.stderr.getReader();
    const d = new TextDecoder();
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      if (value) errBuf.push(d.decode(value));
    }
  })();

  await conn.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: "ainone-ui-spike", version: "0.1.0" },
  });

  // —— 探测 1: providers/list ——
  let providers: any = null;
  let providersErr: string | null = null;
  try {
    providers = await conn.agent.request(acp.methods.agent.providers.list as any, {});
  } catch (e) {
    providersErr = String(e);
  }

  // —— 探测 2: session/new + prompt（观察 usage_update / current_mode）——
  const sresp = await conn.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, {
    cwd: CWD,
    mcpServers: [],
  });
  const sid = sresp.sessionId;

  const promptPromise = conn.agent.request(acp.methods.agent.session.prompt, {
    sessionId: sid,
    prompt: [{ type: "text", text: "回复一个词：好" }],
  });
  await promptPromise.catch(() => {});

  // —— 探测 3: session/fork ——
  let forkResp: any = null;
  let forkErr: string | null = null;
  try {
    forkResp = await conn.agent.request(acp.methods.agent.session.fork as any, {
      sessionId: sid,
      cwd: CWD,
    });
  } catch (e) {
    forkErr = String(e);
  }

  console.log("=== ① providers/list ===");
  console.log(providers ? JSON.stringify(providers, null, 2).slice(0, 1500) : `❌ ${providersErr}`);
  console.log("\n=== ② 一 turn 出现的 update 类型 ===");
  console.log([...cap.seenUpdateTypes].join(", "));
  console.log("usage 样本:", JSON.stringify(cap.usageSamples));
  console.log("current_mode:", JSON.stringify(cap.modeSamples));
  console.log("\n=== ③ session/fork ===");
  console.log(forkResp ? JSON.stringify(forkResp, null, 2).slice(0, 800) : `❌ ${forkErr}`);
  console.log("\n=== ④ stderr 关键行（前 20 行非空）===");
  console.log(errBuf.join("").split("\n").filter(Boolean).slice(0, 20).join("\n"));

  conn.close();
  ipc.kill().catch(() => {});
}

rawProbe()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("spike 异常：", e);
    process.exit(1);
  });
