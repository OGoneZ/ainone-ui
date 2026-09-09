// 流式揭示调度器（P35 R2）：pacer 的自持帧时钟 + 提交节流的合体。
//
// 与 streamCommitThrottle（P31）的关系：throttle 解决「同一帧内多条事件合并
// 提交」，但它的 schedule 只在事件到达时被调用——空窗期（SSE 突发间隙）没有
// 事件 → 没有帧 → pacer 不推进 → 揭示停滞，文字「隔一会蹦一段」。本调度器
// 在 pacer 仍有未揭示积压时**自持 rAF 循环**持续排帧（30fps 上限），保证
// 揭示节奏与时钟而非事件到达率对齐。
//
// 语义：
//   - kick()：事件到达/需要提交时调用——若已有帧排队则合并（同 throttle）
//   - 帧回调内：先 pacer.tick(now)（推进揭示），再 commit()（把揭示快照落 store）
//   - tick 后若仍有 pending → 自动排下一帧（自持循环）；积压清空且无 pending → 停
//   - flush()：立即推完揭示并提交（turn 终态收口）
//   - dispose()：撤销排队帧（turn 异常收口/组件卸载）

import type { StreamPacer } from "./streamPacer";

export interface RevealScheduler {
  /** 事件到达：排一帧（合并语义）；若 pacer 有积压会自持后续帧 */
  kick(): void;
  /** 立即推完揭示并提交（终态） */
  flush(): void;
  /** 撤销排队帧（异常收口） */
  dispose(): void;
}

/** rAF 不可用环境（测试/SSR）回退毫秒数 */
const FALLBACK_DELAY_MS = 16;

export function createRevealScheduler(
  pacer: StreamPacer,
  commit: () => void,
  scheduleFrame: (cb: () => void) => () => void = defaultScheduleFrame,
  now: () => number = Date.now,
): RevealScheduler {
  let frameQueued = false;
  let cancelFrame: (() => void) | null = null;
  let disposed = false;

  const runFrame = () => {
    frameQueued = false;
    cancelFrame = null;
    if (disposed) return;
    pacer.tick(now()); // 推进揭示（30fps 跳帧由 pacer 内部钳制）
    commit(); // 揭示快照落 store
    if (pacer.pendingCount() > 0) kick(); // 仍有积压 → 自持下一帧
  };

  function kick() {
    if (disposed || frameQueued) return;
    frameQueued = true;
    cancelFrame = scheduleFrame(runFrame);
  }

  return {
    kick,
    flush() {
      if (disposed) return;
      if (frameQueued && cancelFrame) {
        cancelFrame();
        frameQueued = false;
        cancelFrame = null;
      }
      pacer.flush();
      commit();
    },
    dispose() {
      disposed = true;
      if (frameQueued && cancelFrame) cancelFrame();
      frameQueued = false;
      cancelFrame = null;
    },
  };
}

function defaultScheduleFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, FALLBACK_DELAY_MS);
  return () => clearTimeout(id);
}
