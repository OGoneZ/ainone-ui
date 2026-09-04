// 聊天面板输入区旁路条带：批注卡 / 附件胶囊 / diff 评论条带 / 编辑横幅。
// 自 ChatPanel 拆出（P13 C3e）：纯展示，状态与发送编排留在 ChatPanel。

import { CloseIcon } from "@/components/ui/icons";
import type { Quote } from "@/chat/logic/quote";
import type { FileRef } from "@/chat/logic/fileRef";
import type { DiffComment } from "@/chat/logic/diffComments";

/** F-8-2 批注卡列表：多段批注 + 统一发送 */
export function QuotePanel({
  quotes,
  onSetQuestion,
  onRemove,
  onSend,
}: {
  quotes: Quote[];
  onSetQuestion: (idx: number, question: string) => void;
  onRemove: (idx: number) => void;
  onSend: () => void;
}) {
  if (quotes.length === 0) return null;
  return (
    <div className="quote-panel">
      {quotes.map((q, i) => (
        <div key={i} className="quote-card">
          <span className="quote-index">引用 {i + 1}</span>
          <div className="quote-text" title={q.text}>{q.text}</div>
          <input
            aria-label={`批注疑问 ${i + 1}`}
            className="quote-input"
            placeholder="填写疑问或评论…"
            value={q.question}
            onChange={(e) => onSetQuestion(i, e.target.value)}
          />
          <button type="button" className="quote-remove" aria-label={`移除引用 ${i + 1}`} onClick={() => onRemove(i)}>
            <CloseIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
          </button>
        </div>
      ))}
      <div className="quote-actions">
        <span className="quote-hint">已选 {quotes.length} 处</span>
        <button type="button" className="quote-send" onClick={onSend}>发送批注</button>
      </div>
    </div>
  );
}

/** F-8-3 附件胶囊列表：文件名 + × 移除（拖拽高亮反馈见 .panel[data-dragging]） */
export function AttachList({
  files,
  onRemove,
}: {
  files: FileRef[];
  onRemove: (idx: number) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="attach-list">
      {files.map((f, i) => (
        <span key={f.path} className="attach-chip">
          <span className="attach-name" title={f.path}>
            {f.path.split("/").filter(Boolean).pop() ?? f.path}
          </span>
          <button
            type="button"
            className="attach-remove"
            aria-label={`移除附件 ${i + 1}`}
            onClick={() => onRemove(i)}
          >
            <CloseIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** F-12-5 diff 行内评论条带：待发评论徽标 + 展开/删除/单独发送 */
export function DiffCommentsBar({
  count,
  comments,
  open,
  onToggle,
  onRemove,
  onSend,
}: {
  count: number;
  comments: DiffComment[];
  open: boolean;
  onToggle: () => void;
  onRemove: (idx: number) => void;
  onSend: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="diff-comments-bar">
      <button
        type="button"
        aria-expanded={open}
        className="diff-comments-toggle"
        style={{ transitionDuration: "var(--motion-fast)" }}
        onClick={onToggle}
      >
        {count} 条 diff 评论
      </button>
      {open && (
        <div className="diff-comments-list">
          {comments.map((c, i) => (
            <div key={i} className="diff-comment-item" title={`${c.path}:${c.line} · ${c.lineText}`}>
              <span className="diff-comment-loc">
                {c.path.split("/").filter(Boolean).pop()}
                {c.line > 0 ? `:${c.line}` : ""}
              </span>
              <span className="diff-comment-text">{c.comment}</span>
              <button
                type="button"
                aria-label={`删除评论 ${i + 1}`}
                onClick={() => onRemove(i)}
                className="diff-comment-remove"
              >
                <CloseIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        className="diff-comments-send"
        style={{ transitionDuration: "var(--motion-fast)" }}
        onClick={onSend}
      >
        发送评论
      </button>
    </div>
  );
}

/** F-12-1 编辑态横幅：发送后从该条重新对话（独立条带，位于输入框上方） */
export function EditBanner({
  target,
  onCancel,
}: {
  target: { index: number; original: string } | null;
  onCancel: () => void;
}) {
  if (!target) return null;
  return (
    <div className="edit-banner" data-testid="edit-banner">
      <span>正在编辑第 {target.index + 1} 条消息，发送后将从此处重新对话</span>
      <button
        type="button"
        aria-label="取消编辑"
        onClick={onCancel}
        style={{ transitionDuration: "var(--motion-fast)" }}
      >
        取消（Esc）
      </button>
    </div>
  );
}
