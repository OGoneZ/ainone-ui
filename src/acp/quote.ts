// 批注式引用提问的纯拼装逻辑（P8 · F-8-2 用法 1）。零依赖，可单测。
//
// 用户对 assistant 消息框选多处、各处填疑问，发送时把所有批注组装为
// 一条纯文本请求。格式（确定性，见 plan-p8.md F-8-2）：
//
//   [引用 1] <原文片段>
//   疑问：<批注内容>
//   ---
//   [引用 2] <原文片段>
//   疑问：<批注内容>

export interface Quote {
  /** 选中的原文片段 */
  text: string;
  /** 针对该段的疑问 / 评论 */
  question: string;
}

/** 把多条批注拼装成一条请求文本（段间 "---" 分隔，序号从 1 起） */
export function composeQuotedPrompt(quotes: Quote[]): string {
  return quotes
    .map((q, i) => `[引用 ${i + 1}] ${q.text}\n疑问：${q.question}`)
    .join("\n---\n");
}
