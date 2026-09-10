// 基准 B：streamPacer tick 的 O(pending) 验证 —— 用真实 src/chat/hooks/streamPacer.ts
// 场景：未闭合 code fence 期间揭示被 gate 拦下 → pending 只增不减，tick 每帧全量切分
// 对照：无 fence 正常揭示（pending 被消费，tick 快）
import { describe, it } from "vitest";
import { performance } from "node:perf_hooks";
import { createStreamPacer } from "@/chat/hooks/streamPacer";

const codeLine = "export function handler(req: Request): Promise<Response> { const data = await req.json(); return Response.json({ ok: true, data }); }\n";
const textLine = "这是一段普通文本，包含 **加粗** 与 `inline code`，用于无围栏对照场景的持续揭示。\n";

function feed(totalKB: number, line: string, stepBytes = 256) {
  const bytes = new TextEncoder().encode(line).length;
  const lines = Math.ceil((totalKB * 1024) / bytes);
  const chunks: string[] = [];
  let buf = "";
  for (let i = 0; i < lines; i++) {
    buf += line;
    if (buf.length >= stepBytes) { chunks.push(buf); buf = ""; }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function timedTicks(p: ReturnType<typeof createStreamPacer>, rounds = 30) {
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    p.tick(1000 + i * 33.4); // 30fps 节奏
    times.push(performance.now() - t0);
  }
  return times;
}

describe("基准 B：streamPacer tick", () => {
  it("场景 B1：fence 阻塞下 pending 增长 → tick 耗时随 pending 线性/超线性增长", () => {
    console.log("\n--- B1 未闭合代码围栏（揭示被 gate 拦下，pending 全量积压）---");
    for (const kb of [16, 64, 256, 1024]) {
      const p = createStreamPacer({});
      p.onChunk("```ts\n"); // 开 fence，不闭合
      const chunks = feed(kb, codeLine);
      for (const c of chunks) p.onChunk(c);
      // 连续 tick（期间不再喂数据）：测「积压已成型后」单帧成本
      const times = timedTicks(p, 20);
      times.sort((a, b) => a - b);
      console.log(
        `pending=${p.pendingCount() / 1024 | 0}KB | tick med=${times[10].toFixed(2)}ms max=${times[times.length - 1].toFixed(2)}ms`,
      );
      p.dispose();
    }
  });

  it("场景 B2：对照组 无围栏正常揭示（pending 被消费，恒定小）", () => {
    console.log("\n--- B2 无围栏（正常揭示，pending 恒小）---");
    for (const totalKB of [16, 64, 256, 1024]) {
      const p = createStreamPacer({});
      const chunks = feed(totalKB, textLine);
      // 模拟真实流式：边喂边 tick（60 帧窗口内把全部数据喂完）
      let ci = 0;
      const times: number[] = [];
      for (let frame = 0; frame < 200 && ci < chunks.length; frame++) {
        const t0 = performance.now();
        for (let k = 0; k < 8 && ci < chunks.length; k++) p.onChunk(chunks[ci++]);
        p.tick(1000 + frame * 33.4);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      console.log(
        `total=${totalKB}KB | tick+feed med=${times[Math.floor(times.length / 2)].toFixed(2)}ms max=${times[times.length - 1].toFixed(2)}ms | 剩余pending=${(p.pendingCount() / 1024).toFixed(0)}KB`,
      );
      p.dispose();
    }
  });

  it("场景 B3：O(pending) 判定 —— 同一时刻，pending 越大单 tick 越贵", () => {
    console.log("\n--- B3 同帧成本 vs pending 大小 ---");
    for (const kb of [64, 256, 1024]) {
      const p = createStreamPacer({});
      p.onChunk("```ts\n");
      for (const c of feed(kb, codeLine)) p.onChunk(c);
      const t0 = performance.now();
      p.tick(1000); // 单次 tick，pending = kb
      const dt = performance.now() - t0;
      console.log(`pending=${p.pendingCount() / 1024 | 0}KB → 单 tick=${dt.toFixed(2)}ms`);
      p.dispose();
    }
  });
});
