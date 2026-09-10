// 基准 A2：前缀冻结后每-commit 解析成本。
// 对照 bench/streamdown-parse.bench.mjs（改前：全文 remend + 全文 Lexer.lex）：
//   冻结后每帧成本 = parseMarkdownIntoBlocks(全文 lex，仍在) + 尾块 remend + 尾块 lex。
// 注意：块重扫（Lexer.lex 全文）仍 O(n)——但 settled 块不再跑 remend/unified parse，
// 且「成本大头」（尾块 unified parse + React reconcile）被冻结掉。
// 更进一步：settled 判定用引用比较，已完成块不再进入任何 parse 管线。
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const root = new URL("..", import.meta.url).pathname;
const marked = await import(`file://${root}node_modules/.pnpm/marked@17.0.6/node_modules/marked/lib/marked.esm.js`);
const remendMod = await import(`file://${root}node_modules/.pnpm/remend@1.3.1/node_modules/remend/dist/index.js`);
const { Lexer } = marked;
const remend = remendMod.default ?? remendMod.remend ?? remendMod;

function makeMixedDoc(targetBytes) {
  const para = "这是一段示例文本，包含 **加粗**、`inline code` 和 [链接](https://example.com)。Agent 在流式输出时会持续追加此类内容，用于测试解析成本随长度的增长。\n\n- 列表项一 `code`\n- 列表项二 **bold**\n- 列表项三\n\n```ts\nconst x = 1;\nconst y = foo(x);\n```\n\n";
  let s = "";
  while (Buffer.byteLength(s) < targetBytes) s += para;
  return s;
}

// 复刻 streamdown 内部 parseMarkdownIntoBlocks（dist _t：Lexer.lex + 合并）
function parseBlocks(text) {
  return Lexer.lex(text, { gfm: true }).map((t) => t.raw);
}

function measureFrozen(doc, commitCount, label) {
  const total = doc.length;
  const step = Math.ceil(total / commitCount);
  const times = [];
  for (let i = step; i <= total; i += step) {
    const snapshot = doc.slice(0, i);
    const t0 = performance.now();
    // 冻结渲染管线：全文切块（O(n) lex，不可避免）→ 只有尾块跑 remend
    const blocks = parseBlocks(snapshot);
    const tail = blocks.length ? blocks[blocks.length - 1] : "";
    const tailRepaired = remend(tail, (s) => s);
    Lexer.lex(tailRepaired, { gfm: true }); // 尾块 lex
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(
    `[${label}] len=${(total / 1024).toFixed(0)}KB | 冻结后 med=${med.toFixed(2)}ms p95=${p95.toFixed(2)}ms`,
  );
}

console.log("\n=== P42 前缀冻结后：每-commit 解析成本（对照基准 A 的未冻结值）===");
for (const kb of [8, 32, 100]) {
  measureFrozen(makeMixedDoc(kb * 1024), 100, `混合 ${kb}KB`);
}
console.log("\n参考（基准 A 未冻结）：8KB med=0.35ms | 32KB med=1.00ms | 100KB med=2.95ms");
