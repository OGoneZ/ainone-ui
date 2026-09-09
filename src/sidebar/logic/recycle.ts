// 会话空闲回收判定纯逻辑（P8 · F-8-1）。零依赖，可单测。
//
// 模型 A：1 session = 1 子进程常驻。某 session 持续 thresholdMs 无任何交互
// （无新 prompt）且当前无运行中的 turn → 回收其子进程；再点开时重新
// spawn + session/load 恢复（配合消息日志回填，不丢历史）。

/**
 * 判定某 session 是否应被空闲回收。
 *
 * @param lastActivityMs 最后一次交互时间戳（Prompt 发起/turn 结束时刷新）；<=0 表从未活动（不回收）
 * @param nowMs 当前时间戳
 * @param thresholdMs 回收阈值；<=0 表关闭回收（永不回收）
 * @param isBusy 是否有运行中的 turn（忙时绝不回收）
 * @param visible 是否在分屏上正显示（P38：可见 tab 阈值放宽到 VISIBLE_THRESHOLD_MS——
 *        用户可能在阅读回复，turn 结束后仍不杀；后台 tab 照旧 thresholdMs）
 */
export function shouldRecycleSession(
  lastActivityMs: number,
  nowMs: number,
  thresholdMs: number,
  isBusy: boolean,
  visible = false,
): boolean {
  if (isBusy) return false;
  if (thresholdMs <= 0) return false;
  if (lastActivityMs <= 0) return false;
  return nowMs - lastActivityMs >= (visible ? Math.max(thresholdMs, VISIBLE_THRESHOLD_MS) : thresholdMs);
}

/** 空闲回收默认阈值：5 分钟（plan-p8.md F-8-1） */
export const RECYCLE_THRESHOLD_MS = 5 * 60 * 1000;
/** 可见 tab 回收阈值：30 分钟（P38——分屏上正显示的 tab 用户可能在看，放宽回收） */
export const VISIBLE_THRESHOLD_MS = 30 * 60 * 1000;
