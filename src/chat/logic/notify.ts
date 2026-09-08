// P32 F-32-1 通知触发决策纯函数。零依赖，可单测。
//
// 防打扰原则：只在「用户看别处」时提醒——窗口失焦才发；
// 用户主动取消（cancelled）不算「任务完成」，不发。

/** 通知触发原因 */
export type NotifyReason = "turn_end" | "perm";

/** ACP StopReason（session/prompt 响应，P1 M1 语义：cancelled = 用户主动停止） */
export type StopReason = string;

export interface NotifyDecisionInput {
  reason: NotifyReason;
  /** 主窗口是否聚焦（document.hasFocus()） */
  windowFocused: boolean;
  /** 仅 reason=turn_end 时有意义：prompt 响应的 stopReason */
  stopReason?: StopReason;
}

export interface NotifyDecision {
  send: boolean;
  /** send=true 时的日志/埋点说明 */
  why?: "unfocused-turn-end" | "unfocused-perm";
}

/** 用户主动停止的 stopReason（P24e 对齐：协议原生 cancelled） */
export const USER_CANCELLED: StopReason = "cancelled";

export function shouldNotify(input: NotifyDecisionInput): NotifyDecision {
  // 聚焦时不打扰（用户正盯着界面）
  if (input.windowFocused) return { send: false };
  if (input.reason === "perm") return { send: true, why: "unfocused-perm" };
  // turn_end：用户主动取消不算完成
  if (input.stopReason === USER_CANCELLED) return { send: false };
  return { send: true, why: "unfocused-turn-end" };
}

/** 通知正文：消息首行摘要（≤60 字符），无正文回退提示语 */
export function turnEndBody(firstLine: string | undefined): string {
  const line = (firstLine ?? "").trim();
  if (!line) return "任务已完成";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
