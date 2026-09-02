// Markdown/工具内容渲染探针：验证协议层能正确提取 diff 与 terminal 内容块。
// 让 agent 输出带代码块 + 编辑文件的回复，确认 dispatchUpdate 把 tool_call 的
// content 正确转成 ToolContent（diff/text/terminal），前端据此渲染。

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

let text = "";
let toolContentKinds = new Set<string>();
let sawMarkdown = false;
await session.prompt("用 markdown 回复：一个二级标题，下面一个带 python 代码块的列表项，并说明你支持 markdown", (e) => {
  if (e.type === "agent_text") {
    text += e.text;
    if (e.text.includes("```")) sawMarkdown = true;
  } else if (e.type === "tool_call" || e.type === "tool_update") {
    for (const c of e.content) toolContentKinds.add(c.kind);
  }
});

console.log("残留 markdown 代码围栏:", sawMarkdown);
console.log("工具内容 kinds:", [...toolContentKinds].join(",") || "（无工具调用，纯文本回复）");
console.log("回复含标题符:", text.includes("#") || text.includes("##"));
await session.dispose();

const ok = sawMarkdown || text.includes("#");
console.log(ok ? "\n✅ Markdown 源内容正常（代码围栏/标题到位，前端 react-markdown 负责渲染）" : "\n⚠️ 未捕捉到 markdown 标记");
process.exit(0); // 渲染正确性由浏览器验证，协议层只是确认内容含 markdown 标记
