// F-12-1 编辑重试：ChatGPT 式「从该消息重新聊」的纯数据变换。
// 语义（DEC-35）：以用户消息 index 为编辑目标——
//   - index 之前（含 index）保留，index 处替换为编辑后文本
//   - index 之后的所有消息（上一轮回复等）全部丢弃
// 零 React/Tauri 依赖，vitest 直接覆盖。

import type { ChatMsg } from "@/acp/message-log";

/** 越界 / 非用户消息 / 空文本 → null（调用方降级提示，不截断） */
export function truncateMessagesToEdit(
  messages: ChatMsg[],
  index: number,
  newText: string,
): ChatMsg[] | null {
  if (index < 0 || index >= messages.length) return null;
  if (messages[index].role !== "user") return null;
  if (!newText.trim()) return null;
  const kept = messages.slice(0, index);
  kept.push({ role: "user", text: newText });
  return kept;
}
