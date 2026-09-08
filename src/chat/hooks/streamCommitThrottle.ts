// 流式事件提交节流（P31 性能，2026-09-08 事故）：
//
// 背景：session.prompt 的 onOutgoing 每条 ACP update 都触发一次
// updateLastAssistant（新数组引用 → 订阅组件整体重渲染）。实测一个 turn
// 48 秒到达 396 条 update（8 条/s），叠加 Streamdown 全量重解析 → WebKit
// 主线程持续满载。本函数把高频内容事件按帧合并（rAF），事件突发期间每个
// 渲染帧最多提交一次；即时事件（usage/plan/turn_stop 等）与 flush 不受影响。
//
// 语义保证：
//   - 不丢事件：applyEvent 在 caller 处仍逐条执行（turnRef 累积），节流的
//     只是「把累积结果提交到 store」这一步——提交的永远是最新累积快照
//   - 即时事件（onImmediate）绕过节流直接提交（低频且 UI 需要立即感知）
//   - flush() 强制提交剩余快照（turn 结束/异常收口时调用）
//   - dispose() 幂等清理 pending 帧（组件卸载/turn 覆盖时防泄漏）

export interface StreamCommitThrottle {
  /** 高频内容事件：每帧最多提交一次（首事件立即提交，后续帧内合并） */
  schedule(): void;
  /** 强制提交累积快照（turn 结束/异常收口） */
  flush(): void;
  /** 清理 pending 帧回调（组件卸载） */
  dispose(): void;
}

/** rAF 不可用环境（测试/SSR）回退毫秒数；0 = 微任务级合并 */
const FALLBACK_DELAY_MS = 16;

export function createStreamCommitThrottle(
  commit: () => void,
  scheduleFrame: (cb: () => void) => () => void = defaultScheduleFrame,
): StreamCommitThrottle {
  let pending = false;
  let cancelFrame: (() => void) | null = null;

  const doCommit = () => {
    pending = false;
    cancelFrame = null;
    commit();
  };

  return {
    schedule() {
      if (pending) return; // 本帧已有提交排队 → 合并
      pending = true;
      cancelFrame = scheduleFrame(doCommit);
    },
    flush() {
      if (pending) {
        if (cancelFrame) cancelFrame();
        doCommit();
      }
    },
    dispose() {
      if (pending && cancelFrame) cancelFrame();
      pending = false;
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
