// 基准 A：复刻 streamdown 2.6 每-commit 的解析路径，验证「全文 remend + 全文 Lexer.lex」O(n²) 假设
// 路径 = dist/chunk-YOKDWASO.js 中组件 Xa 的 useMemo 依赖链：
//   at = useMemo(() => streaming ? Fa(children, x) : children)   // Fa = remend
//   G  = useMemo(() => parseMarkdownIntoBlocks(at))              // = Lexer.lex(全文)
// 再叠加尾块 unified parse（unified().use(remark-parse)...)
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const root = new URL("..", import.meta.url).pathname;
const p = (name) => require.resolve(name, { paths: [root + "node_modules/.pnpm/marked@17.0.6/node_modules", root + "node_modules/.pnpm/remend@1.3.1/node_modules", root + "node_modules"] });

// streamdown 实际用的 marked 17.0.6（实测哪个被解析）
const marked = await import(`file://${root}node_modules/.pnpm/marked@17.0.6/node_modules/marked/lib/marked.esm.js`);
const remendMod = await import(`file://${root}node_modules/.pnpm/remend@1.3.1/node_modules/remend/dist/index.js`);

const { Lexer } = marked;
const remend = remendMod.default ?? remendMod.remend ?? remendMod;
console.log("marked from: .pnpm/marked@17.0.6");
console.log("remend export keys:", Object.keys(remendMod));

// ---- 构造有代表性的流式 markdown ----
// 场景 1: 长混合文档（段落+列表+行内代码），近似 agent 日常输出
// 场景 2: 长代码块（fence 内），近似大型代码生成
function makeMixedDoc(targetBytes) {
  const para = "这是一段示例文本，包含 **加粗**、`inline code` 和 [链接](https://example.com)。Agent 在流式输出时会持续追加此类内容，用于测试解析成本随长度的增长。\n\n- 列表项一 `code`\n- 列表项二 **bold**\n- 列表项三\n\n```ts\nconst x = 1;\nconst y = foo(x);\n```\n\n";
  let s = "";
  while (Buffer.byteLength(s) < targetBytes) s += para;
  return s;
}
function makeCodeDoc(targetBytes) {
  const line = "export function handler(req: Request): Promise<Response> { const data = await req.json(); return Response.json({ ok: true, data }); }\n";
  let s = "以下是实现方案：\n\n```ts\n";
  while (Buffer.byteLength(s) < targetBytes) s += line;
  return s;
}

// ---- 每-commit 成本测量 ----
function measure(doc, commitCount, label) {
  const total = doc.length;
  // 流式模拟：等量追加，每个 commit 后跑一次「remend(全文) + lex(全文)」
  const step = Math.ceil(total / commitCount);
  const parse = (text) => Lexer.lex(text, { gfm: true });

  // warmup
  remend("短文本 **b", (s) => s);
  parse(doc.slice(0, 2000));

  const times = [];
  for (let i = step; i <= total; i += step) {
    const snapshot = doc.slice(0, i);
    const t0 = performance.now();
    const repaired = remend(snapshot, (s) => s);
    parse(repaired);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const med = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const max = times[times.length - 1];
  // 帧预算违反率（16.6ms = 60fps；8.3ms = 120fps 的一半预算留给解析）
  const over60 = times.filter((t) => t > 16.6).length;
  const over33 = times.filter((t) => t > 33).length;
  console.log(
    `[${label}] len=${(total / 1024).toFixed(0)}KB commits=${times.length} | med=${med.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms total=${(sum / 1000).toFixed(2)}s | >16.6ms帧: ${over60}次(${((over60 / times.length) * 100).toFixed(0)}%) >33ms: ${over33}次`,
  );
  return { med, p95, max, sum };
}

console.log("\n=== 场景 1：混合 markdown（agent 日常输出形态）===");
for (const kb of [8, 32, 100]) {
  measure(makeMixedDoc(kb * 1024), 100, `混合 ${kb}KB`);
}
console.log("\n=== 场景 2：单一长代码块（fence 内，fence 未闭合时 remend/门控行为不同）===");
for (const kb of [8, 32, 100]) {
  measure(makeCodeDoc(kb * 1024), 100, `代码 ${kb}KB`);
}
console.log("\n=== 场景 3：O(n²) 判定 —— 同一 commit 位置，文本越长单 commit 越贵 ===");
// 若 O(n²) 成立：100KB 文本的第 50 个 commit 的耗时 ≈ 25KB 文本第 50 个 commit 的 4 倍
const q = (doc, n) => {
  const step = Math.ceil(doc.length / n);
  const t0 = performance.now();
  const r = remend(doc.slice(0, step * Math.floor(n / 2)), (s) => s);
  Lexer.lex(r, { gfm: true });
  return performance.now() - t0;
};
const d25 = makeMixedDoc(25 * 1024), d100 = makeMixedDoc(100 * 1024);
const t25 = q(d25, 100), t100 = q(d100, 100);
console.log(`25KB 中点 commit=${t25.toFixed(2)}ms | 100KB 中点 commit=${t100.toFixed(2)}ms | 倍数=${(t100 / t25).toFixed(1)}x（O(n²) 预测 ≈4x）`);
