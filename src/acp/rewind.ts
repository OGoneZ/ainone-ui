// 消息回溯的纯截断逻辑（P8 · F-8-6 情况一）。零依赖，可单测。
//
// 语义（DEC-15 情况一）：以某条用户消息「之前」的历史为基底，之后消息全部丢弃。
// 「回溯到第 N 条」= 保留 messages[0, N)，即 slice(0, index)。
//
// 情况二（回上下文 + 文件，git 快照回滚）为 S 级外置能力，不在本期纯函数范围。

import type { ChatMsg } from "./message-log";

/**
 * 截断消息列表到 index 之前（不含 index）。
 * N=0 → 空数组；越界 → 全部保留；负数 → 空数组。
 */
export function truncateToMessageIndex(messages: ChatMsg[], index: number): ChatMsg[] {
  if (index <= 0) return [];
  if (index >= messages.length) return messages.slice();
  return messages.slice(0, index);
}
