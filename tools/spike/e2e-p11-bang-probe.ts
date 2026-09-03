// P11 · F-11-4a spike：实测 harness 在 ACP 通道下是否解释 `!cmd` 前缀（AC-P11-10）。
// 对每个可用 harness 发 `!echo hello-ainone` 与 `!ls`，捕获 assistant 回复，
// 判定是否出现命令执行痕迹（echo 回显/文件列表）→ 决定 DEC-29 分支 a/b。
// 结论写入 docs/plan-p11.md §7；报文存档 docs/protocol-samples/sample-bang-<id>.json。

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createAcpSession, type AcpSession, type Outgoing } from "../../src/acp/session-core";

/** 探针专用 cwd：隔离目录，避免读到大仓文件干扰判定 */
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "ainone-bang-"));
fs.writeFileSync(path.join(CWD, "probe-file.txt"), "probe\n");
fs.mkdirSync(path.join(CWD, "probe-dir"));

const ADAPTERS: Array<{ id: string; program: string }> = [
  { id: "claude-code", program: "claude-agent-acp" },
  { id: "omp", program: "omp" },
  { id: "pi", program: "pi-acp" },
];

function available(program: string): boolean {
  const { execFileSync } = require("node:child_process") as any;
  try {
    execFileSync("which", [program], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function spawnAgent(program: string) {
  return spawn(program, [], { cwd: CWD, stdio: ["pipe", "pipe", "inherit"] });
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

/** 收集一轮 assistant 正文（带 120s 超时：harness 对 `!` 无响应时 prompt 永不 resolve） */
function collectText(session: AcpSession, text: string): Promise<string> {
  const chunks: string[] = [];
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("prompt 超时（120s）—harness 可能未响应")), 120_000),
  );
  return Promise.race([
    session.prompt(text, (e: Outgoing) => {
      if (e.type === "agent_text") chunks.push(e.text);
    }).then(() => chunks.join("")),
    timeout,
  ]);
}

const EXEC_MARKERS = ["hello-ainone", "probe-file.txt", "probe-dir"];
function executed(reply: string): boolean {
  const lower = reply.toLowerCase();
  return EXEC_MARKERS.filter((m) => lower.includes(m)).length >= 2;
}

const results: Array<Record<string, unknown>> = [];
for (const a of ADAPTERS) {
  if (!available(a.program)) {
    console.log(`⏭ 跳过 ${a.id}（${a.program} 不可用）`);
    continue;
  }
  // 每个 harness 整体 150s 看门狗：initialize/session-new/prompt 任一挂起都算「无响应」
  const record = await Promise.race([
    (async () => {
      const child = spawnAgent(a.program);
      try {
        const session = await createAcpSession({
          streams: makeStreams(child),
          cwd: CWD,
          onPermission: allowPermission,
          ipc: makeIpc(child),
        });
        const replyEcho = await collectText(session, "!echo hello-ainone");
        const replyLs = await collectText(session, "!ls");
        const isExec = executed(replyEcho + replyLs);
        const rec: Record<string, unknown> = {
          adapter: a.id,
          program: a.program,
          bangEcho: { reply: replyEcho.slice(0, 500) },
          bangLs: { reply: replyLs.slice(0, 500) },
          executed: isExec,
          verdict: isExec
            ? "分支 a：harness 解释 ! 前缀（客户端透传）"
            : "分支 b：harness 不解释（客户端本地执行 + 注入）",
        };
        fs.writeFileSync(
          path.resolve(`./docs/protocol-samples/sample-bang-${a.id}.json`),
          JSON.stringify(rec, null, 2),
        );
        console.log(`${a.id}: executed=${isExec}`);
        return rec;
      } catch (e) {
        console.log(`❌ ${a.id} 失败: ${String(e)}`);
        return { adapter: a.id, program: a.program, executed: false, verdict: `失败：${String(e)}` };
      } finally {
        child.kill();
      }
    })(),
    new Promise<Record<string, unknown>>((r) =>
      setTimeout(() => {
        console.log(`⏱ ${a.id}: 150s 无响应（视为不解释 ! 前缀）`);
        r({ adapter: a.id, program: a.program, executed: false, verdict: "无响应（超时，未产生 turn）" });
      }, 150_000),
    ),
  ]);
  results.push(record);
}

fs.rmSync(CWD, { recursive: true, force: true });
const exec = results.filter((r) => r.executed);
console.log(`\n结论：${results.length} 个 harness 实测，${exec.length} 个执行了 ! 命令`);
console.log(exec.length > 0 ? "→ DEC-29 分支 a（至少一个 harness 解释）" : "→ DEC-29 分支 b（均不解释，客户端 exec_in_cwd）");
process.exit(0);
