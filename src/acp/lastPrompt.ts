// 顶部「上一条指令」回跳纯逻辑（P11 · F-11-9）。零依赖，可单测。

import type { ChatMsg } from "./message-log";

/** 最后一条 user 消息下标（无则 -1） */
export function lastUserIndex(messages: ChatMsg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/** 气泡显隐判定：无 user 消息不显示；距底 <= 阈值（px）视为贴底隐藏 */
export function shouldShowLastPromptBubble(hasUser: boolean, distanceToBottom: number, threshold = 64): boolean {
  return hasUser && distanceToBottom > threshold;
}

/** 单行省略文本（规范化空白：换行折空格） */
export function ellipsize(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
