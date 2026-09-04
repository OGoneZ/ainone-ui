// F-12-5 diff 行内评论回传（Vibe Kanban 模式，DEC-38）：
// 评论逐条收集 → 组装为一条 prompt 随消息发送 → 发送后清空。
// 组装格式确定性，纯函数可单测。

export interface DiffComment {
  path: string;
  /** diff 中该行在 newText 里的 1 基行号；0 = 新文件/未知行号 */
  line: number;
  /** 被评论的行内容 */
  lineText: string;
  comment: string;
}

export function composeDiffComments(comments: DiffComment[]): string {
  if (comments.length === 0) return "";
  const parts = comments.map((c, i) => {
    const loc = c.line > 0 ? `${c.path}:${c.line}` : `${c.path}`;
    const line = c.lineText ? `${c.lineText}\n` : "";
    return `[diff 评论 ${i + 1}] ${loc}\n${line}评论：${c.comment}\n---`;
  });
  return parts.join("\n");
}
