// 会话内搜索的纯逻辑（P9 · F-9-2）。零依赖，可单测。
//
// 数据源（DEC-17）：内存态消息列表（正文 / thinking / 工具标题）。5000 条规模
// 线性扫描足够（纯前端 <10ms），不建倒排索引；性能不达标再升级。

import type { ChatMsg } from "@/acp/message-log";

/** 一条消息的可搜纯文本（正文 + thinking + 工具标题） */
export function messageSearchText(msg: ChatMsg): string {
  if (msg.role === "user") return msg.text;
  return msg.blocks
    .map((b) => {
      if (b.kind === "text" || b.kind === "thought") return b.text;
      if (b.kind === "tool") return b.title;
      return "";
    })
    .join("\n");
}

export interface SearchHit {
  index: number;
  /** 命中片段（用于高亮定位前的摘要） */
  excerpt: string;
}

/** 对消息列表全文检索，返回命中下标数组（不区分大小写）。 */
export function searchMessages(messages: ChatMsg[], keyword: string): SearchHit[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  messages.forEach((m, i) => {
    const text = messageSearchText(m);
    const idx = text.toLowerCase().indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - 20);
      const excerpt = text.slice(start, idx + q.length + 40);
      hits.push({ index: i, excerpt });
    }
  });
  return hits;
}
