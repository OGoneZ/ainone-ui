// diff 渲染：逐行 del/add/ctx + F-12-5 行内评论入口。自 ChatPanel 拆出（P13 C3）。

import { CommentIcon } from "@/components/ui/icons";
import type { DiffComment } from "@/chat/logic/diffComments";

export function DiffView({
  path,
  oldText,
  newText,
  diffComments,
  onAddDiffComment,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
  /** F-12-5 行内评论：待发评论集（已评论行标记）+ 收集回调；缺省 = 不启用评论入口 */
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  const oldLines = (oldText ?? "").split("\n");
  const newLines = newText.split("\n");
  const rows: { type: "del" | "add" | "ctx"; line: string; /** 该行在 newText 中的 1 基行号；del 行 0 */ newLine: number }[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  let newLineNo = 0;
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      if (n !== undefined) newLineNo += 1;
      rows.push({ type: "ctx", line: o ?? "", newLine: n !== undefined ? newLineNo : 0 });
    } else {
      if (o !== undefined) rows.push({ type: "del", line: o, newLine: 0 });
      if (n !== undefined) {
        newLineNo += 1;
        rows.push({ type: "add", line: n, newLine: newLineNo });
      }
    }
  }
  const commented = (ln: number, lineText: string) =>
    diffComments?.some((c) => c.path === path && c.line === ln && c.lineText === lineText) ?? false;
  return (
    <div className="diff">
      <div className="diff-path">{path}</div>
      {rows.map((r, i) => (
        <div key={i} className={`diff-line group/diff ${r.type}`} data-commented={commented(r.newLine, r.line) ? "true" : "false"}>
          <span className="diff-sign">{r.type === "add" ? "+" : r.type === "del" ? "-" : " "}</span>
          {r.line}
          {/* F-12-5：hover 行尾浮现评论入口（del 行无新行号，不支持评论） */}
          {onAddDiffComment && r.newLine > 0 && (
            <button
              type="button"
              aria-label={`评论 ${path}:${r.newLine}`}
              className="diff-comment-btn ml-auto inline-flex items-center rounded px-1 text-[11px] opacity-0 transition-opacity group-hover/diff:opacity-100 hover:bg-[var(--bg-hover)]"
              style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
              onClick={() => {
                const comment = window.prompt(`评论 ${path}:${r.newLine}`);
                if (comment && comment.trim()) {
                  onAddDiffComment({ path, line: r.newLine, lineText: r.line, comment: comment.trim() });
                }
              }}
            >
              <CommentIcon style={{ width: 11, height: 11, strokeWidth: 1.75 }} />
              评论
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
