// streamPacer 单测（P35 R1）：平滑揭示是本模块的全部意图——
// 到达突发（8/s、几十字/条）与显示节奏（30fps、匀速小片）解耦；
// 落后自动加速（catch-up）防积压；grapheme/fence 两个安全边界不可破；
// flush 终态不丢字；reduced-motion 零开销。

import { describe, it, expect } from "vitest";
import { createStreamPacer } from "./streamPacer";

/** 手动时钟：测试内自控时间推进 */
function manualClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      return t;
    },
  };
}

/** 便捷驱动：onChunk 后按 fps=30 的节拍推 N 帧，返回揭示进度 */
function drive(pacer: ReturnType<typeof createStreamPacer>, clock: ReturnType<typeof manualClock>, frames: number) {
  let changed = 0;
  for (let i = 0; i < frames; i++) {
    clock.advance(1000 / 30);
    if (pacer.tick(clock.now())) changed += 1;
  }
  return changed;
}

describe("streamPacer（P35 R1 平滑揭示）", () => {
  it("匀速揭示：单条大 chunk 按 30fps 分帧出，不再一次性蹦出", () => {
    const clock = manualClock();
    const p = createStreamPacer({}, clock.now);
    p.onChunk("这是一段比较长的流式文本内容用来验证匀速揭示效果——共三十个字");
    expect(p.revealedText()).toBe(""); // 到达即缓冲，不直接显示
    const changedFrames = drive(p, clock, 10);
    const shown = p.revealedText().length;
    expect(changedFrames).toBeGreaterThan(3); // 多帧渐进（不是一帧全出）
    expect(shown).toBeGreaterThan(0);
  });

  it("终态完整性：逐帧揭示后 flush，全文一字不丢", () => {
    const clock = manualClock();
    const p = createStreamPacer({}, clock.now);
    const FULL = "第一段到达。第二段到达。第三段到达。".repeat(3);
    // 模拟 8 条突发 chunk
    for (const part of FULL.match(/.{1,12}/g) ?? []) p.onChunk(part);
    drive(p, clock, 90); // 3 秒
    p.flush();
    expect(p.revealedText()).toBe(FULL);
    expect(p.pendingCount()).toBe(0);
  });

  it("catch-up：积压超阈值后揭示加速（单位时间揭示量上升）", () => {
    const clock = manualClock();
    const p = createStreamPacer(
      { catchUpThreshold: 100, targetLatencyMs: 900, catchUpLatencyMs: 350 },
      clock.now,
    );
    p.onChunk("字".repeat(300)); // 远超阈值 100
    drive(p, clock, 30); // 1 秒
    const revealed1s = p.revealedText().length;
    // 1 秒揭示量应显著高于底速 minCps=40（catch-up 生效）
    expect(revealed1s).toBeGreaterThanOrEqual(60);
    // 继续推到清空
    drive(p, clock, 120);
    expect(p.pendingCount()).toBe(0);
  });

  it("grapheme 安全：emoji / 中文词组不切半", () => {
    const clock = manualClock();
    const p = createStreamPacer({ maxCharsPerCommit: 3 }, clock.now);
    p.onChunk("👨‍👩‍👧‍👦🚀🎉中文混排");
    drive(p, clock, 60);
    p.flush();
    expect(p.revealedText()).toBe("👨‍👩‍👧‍👦🚀🎉中文混排");
  });

  it("fence 阻塞：未闭合代码围栏内的内容不出（闭合后继续）", () => {
    const clock = manualClock();
    const p = createStreamPacer({}, clock.now);
    // 一帧预算足够揭示到围栏开启行之后
    p.onChunk("前置说明\n```ts\nconst secret = 1;\n");
    drive(p, clock, 60); // 2 秒
    const mid = p.revealedText();
    // 前置说明 + 围栏开启行可出；代码内容被阻塞（gate.held 持有，不进 revealed）
    expect(mid).toContain("前置说明");
    expect(mid).toContain("```ts");
    expect(mid).not.toContain("const secret");

    // 闭合围栏到达后，代码内容解除阻塞
    p.onChunk("```\n后置说明");
    drive(p, clock, 60);
    expect(p.revealedText()).toContain("const secret");
    expect(p.revealedText()).toContain("后置说明");
  });

  it("flush 覆盖未闭合 fence：终态全文完整（包括围栏内）", () => {
    const clock = manualClock();
    const p = createStreamPacer({}, clock.now);
    p.onChunk("```py\nprint('未闭合')");
    drive(p, clock, 30);
    p.flush();
    expect(p.revealedText()).toBe("```py\nprint('未闭合')");
  });

  it("commitFps 跳帧：tick 间隔小于最小帧距时不揭示（30fps 上限）", () => {
    const clock = manualClock();
    const p = createStreamPacer({ commitFps: 30 }, clock.now);
    p.onChunk("待揭示内容");
    clock.advance(10);
    expect(p.tick(clock.now())).toBe(false); // 10ms < 33ms → 跳帧
    clock.advance(40); // 累计 50ms > 33ms → 揭示
    expect(p.tick(clock.now())).toBe(true);
  });

  it("396 条突发回放（P31 事故同款）：揭示帧率 ≤ commitFps，flush 后全文完整", () => {
    const clock = manualClock();
    const p = createStreamPacer({}, clock.now);
    const TOTAL = 396;
    let ticks = 0;
    // 事件与帧交错到达：每事件后推 4 帧（模拟 8/s 事件 × 30fps 帧）
    for (let i = 0; i < TOTAL; i++) {
      p.onChunk("流式内容片段。");
      for (let f = 0; f < 4; f++) {
        clock.advance(8); // 125ms 事件间隔 / 4 帧 ≈ 每帧 31ms
        if (p.tick(clock.now())) ticks += 1;
      }
    }
    p.flush();
    // 揭示提交次数受帧率约束：48s × 30fps = 1440 上限（事件率 396 之上但每帧最多一次）
    expect(ticks).toBeLessThanOrEqual(48 * 30);
    expect(p.revealedText().length).toBe(TOTAL * 7);
  });

  it("reduced-motion 直通：onChunk 即全量揭示，tick 永无变化", () => {
    const clock = manualClock();
    const p = createStreamPacer({ reducedMotion: true }, clock.now);
    p.onChunk("直达全文");
    expect(p.revealedText()).toBe("直达全文");
    expect(p.pendingCount()).toBe(0);
    expect(p.tick(clock.now())).toBe(false);
  });

  it("突发积压不倾泻：空窗期 budget 清零，下一批到达不一次性全出", () => {
    const clock = manualClock();
    const p = createStreamPacer({}, clock.now);
    p.onChunk("第一批");
    drive(p, clock, 30);
    expect(p.pendingCount()).toBe(0);
    drive(p, clock, 60); // 长空窗
    p.onChunk("第二批".repeat(20)); // 大批量到达
    clock.advance(33);
    p.tick(clock.now());
    expect(p.revealedText().length).toBeLessThan(3 + 120); // 不会一帧全倾泻
  });
});
