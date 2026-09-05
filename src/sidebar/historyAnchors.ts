// 历史锚点提取（P16 · F-16-2，DEC-49）：从线性消息数组提取用户消息锚点。
//
// 消息模型（ChatMsg）无 id/parent 树结构——「消息树」的树语义 = 当前分支上
// 用户消息的祖先链（回溯即剪枝，rewind 截断后重算自然变短；分叉走 logCopy
// 整段复制成新会话，天然是新枝）。UI 层呈扁平锚点列表，不伪造树形缩进。
// 纯函数，可单测。

import type { ChatMsg } from "@/acp/message-log";

export interface UserAnchor {
  /** 在 messages 数组中的位置（scrollToIndex / rewind 截断均以此为准） */
  index: number;
  /** 用户消息全文（回溯确认 Dialog 复用） */
  text: string;
  /** 首行摘要（列表展示，截 ~48 字） */
  preview: string;
}

const PREVIEW_LEN = 48;

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const t = line.trim();
  return t.length > PREVIEW_LEN ? `${t.slice(0, PREVIEW_LEN)}…` : t;
}

/** 提取全部用户消息锚点（保持时间序） */
export function extractUserAnchors(messages: ChatMsg[]): UserAnchor[] {
  const anchors: UserAnchor[] = [];
  messages.forEach((m, index) => {
    if (m.role === "user") {
      anchors.push({ index, text: m.text, preview: firstLine(m.text) || "（空消息）" });
    }
  });
  return anchors;
}
