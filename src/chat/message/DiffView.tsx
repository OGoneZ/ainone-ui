// diff 渲染：逐行 del/add/ctx + F-12-5 行内评论入口。自 ChatPanel 拆出（P13 C3）。
//
// P36 修复（用户实测：点评论卡住）：评论输入原用 window.prompt——同步阻塞 API，
// WKWebView（wry）不实现同步 prompt，点击后 UI 无响应。改为 Radix Dialog + 受控
// input（与 ChatPanel 回溯确认框同范式），异步不阻塞。

import { useState } from "react";
import { CommentIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  // 评论输入弹窗状态（P36：window.prompt 在 WKWebView 卡死 → Dialog 受控输入）
  const [promptTarget, setPromptTarget] = useState<{ line: number; lineText: string } | null>(null);
  const [draft, setDraft] = useState("");
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
                setDraft("");
                setPromptTarget({ line: r.newLine, lineText: r.line });
              }}
            >
              <CommentIcon style={{ width: 11, height: 11, strokeWidth: 1.75 }} />
              评论
            </button>
          )}
        </div>
      ))}

      {/* P36：评论输入弹窗（替代 window.prompt——WKWebView 不支持同步 prompt） */}
      {onAddDiffComment && (
      <Dialog
        open={promptTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPromptTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              评论 {path}
              {promptTarget ? `:${promptTarget.line}` : ""}
            </DialogTitle>
          </DialogHeader>
          {promptTarget && (
            <p className="perm-code" style={{ opacity: 0.75 }}>
              {promptTarget.lineText}
            </p>
          )}
          <input
            autoFocus
            className="w-full rounded-md border border-[var(--bg-3)] bg-[var(--bg-1)] px-3 py-2 text-sm outline-none focus:border-[var(--primary)]"
            placeholder="输入评论内容…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && promptTarget && draft.trim()) {
                onAddDiffComment({ path, line: promptTarget.line, lineText: promptTarget.lineText, comment: draft.trim() });
                setPromptTarget(null);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromptTarget(null)}>
              取消
            </Button>
            <Button
              disabled={!draft.trim()}
              onClick={() => {
                if (!promptTarget || !draft.trim()) return;
                onAddDiffComment({ path, line: promptTarget.line, lineText: promptTarget.lineText, comment: draft.trim() });
                setPromptTarget(null);
              }}
            >
              添加评论
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      )}
    </div>
  );
}
