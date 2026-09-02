// AC-P4-9 性能回归：5000 条消息日志回填 < 2 秒。
// 复用生产 parseLog（DEC-8），生成 5000 条 JSONL 行（含含换行正文/thinking/tool 混合）
// 实测解析耗时。渲染流畅由 react-virtual 背书（AC-P3-5 已验，P3 记录有据）。

import { parseLog, serializeMessages, type ChatMsg } from "../../src/acp/message-log";

const N = 5000;

// 造多样消息：user / assistant（4 blocks，含 thinking 计时 + tool + 含换行正文）
function gen(): ChatMsg[] {
  const out: ChatMsg[] = [];
  for (let i = 0; i < N; i++) {
    out.push({ role: "user", text: `第 ${i} 条用户消息\n带个换行` });
    out.push({
      role: "assistant",
      blocks: [
        { kind: "thought", text: `思考 ${i}`, ms: 1200 },
        { kind: "tool", toolCallId: `t-${i}`, title: "read", status: "completed", content: [{ kind: "text", text: "x".repeat(50) }] },
        { kind: "text", text: "回复 " + i + "\n```python\nprint(" + i + ")\n```\n**加粗**" },
      ],
    });
  }
  return out;
}

const msgs = gen(); // 实际 10000 条（5000 往返），比 AC-P4-9 更严
const raw = serializeMessages(msgs).map((l) => l + "\n").join("");

const t0 = performance.now();
const parsed = parseLog(raw);
const dt = performance.now() - t0;

const ok = parsed.length === msgs.length;
console.log(`输入 ${msgs.length} 条消息（${(raw.length / 1024 / 1024).toFixed(2)} MB）`);
console.log(`parseLog 回填耗时：${dt.toFixed(1)} ms`);
console.log(`回填条数一致：${ok}`);
if (ok && dt < 2000) {
  console.log("\n✅ AC-P4-9 通过：日志回填 < 2 秒");
  process.exit(0);
} else {
  console.log("\n❌ AC-P4-9 未通过");
  process.exit(1);
}
