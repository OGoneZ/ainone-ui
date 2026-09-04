// 会话空闲回收判定纯逻辑（P8 · F-8-1）。零依赖，可单测。
//
// 模型 A：1 session = 1 子进程常驻。某 session 持续 thresholdMs 无任何交互
// （无新 prompt）且当前无运行中的 turn → 回收其子进程；再点开时重新
// spawn + session/load 恢复（配合消息日志回填，不丢历史）。

/**
 * 判定某 session 是否应被空闲回收。
 *
 * @param lastActivityMs 最后一次交互时间戳（Prompt 发起时刷新）；<=0 表从未活动（不回收）
 * @param nowMs 当前时间戳
 * @param thresholdMs 回收阈值；<=0 表关闭回收（永不回收）
 * @param isBusy 是否有运行中的 turn（忙时绝不回收）
 */
export function shouldRecycleSession(
  lastActivityMs: number,
  nowMs: number,
  thresholdMs: number,
  isBusy: boolean,
): boolean {
  if (isBusy) return false;
  if (thresholdMs <= 0) return false;
  if (lastActivityMs <= 0) return false;
  return nowMs - lastActivityMs >= thresholdMs;
}

/** 空闲回收默认阈值：5 分钟（plan-p8.md F-8-1） */
export const RECYCLE_THRESHOLD_MS = 5 * 60 * 1000;
