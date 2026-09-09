// diff 渲染：逐行 del/add/ctx + F-12-5 行内评论入口。自 ChatPanel 拆出（P13 C3）。
//
// P36 修复（用户实测：点评论卡住）：评论输入原用 window.prompt——同步阻塞 API，
// WKWebView（wry）不实现同步 prompt，点击后 UI 无响应。
// P36 修订（用户反馈：居中大弹窗遮罩破坏沉浸感）：改行尾 Popover 小悬浮窗——
// 贴着评论按钮弹出（side="left"），无遮罩，点外/Esc 关闭，左侧行仍可滚动浏览。

import { useState } from "react";
import { CommentIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  // 评论输入浮层状态（P36：window.prompt 卡死 → 行尾 Popover 小悬浮窗）
  const [promptLine, setPromptLine] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const submit = (line: number, lineText: string) => {
    const text = draft.trim();
    if (!text || !onAddDiffComment) return;
    onAddDiffComment({ path, line, lineText, comment: text });
    setPromptLine(null);
    setDraft("");
  };
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
          {/* F-12-5：hover 行尾浮现评论入口（del 行无新行号，不支持评论）。
              P36：点开行尾 Popover 小悬浮窗（无遮罩不挡消息区） */}
          {onAddDiffComment && r.newLine > 0 && (
            <Popover open={promptLine === r.newLine} onOpenChange={(o) => setPromptLine(o ? r.newLine : null)}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`评论 ${path}:${r.newLine}`}
                  className="diff-comment-btn ml-auto inline-flex items-center rounded px-1 text-[11px] opacity-0 transition-opacity group-hover/diff:opacity-100 hover:bg-[var(--bg-hover)]"
                  style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
                >
                  <CommentIcon style={{ width: 11, height: 11, strokeWidth: 1.75 }} />
                  评论
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="left"
                align="end"
                sideOffset={6}
                className="w-80 p-2.5"
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                <div className="text-[11px] mb-1.5" style={{ color: "var(--text-secondary)" }}>
                  评论 {path}:{r.newLine}
                  <span className="ml-1.5" style={{ opacity: 0.7 }}>{r.line}</span>
                </div>
                <textarea
                  autoFocus
                  rows={2}
                  className="w-full resize-none rounded-md border border-[var(--bg-3)] bg-[var(--bg-1)] px-2.5 py-1.5 text-sm leading-relaxed outline-none focus:border-[var(--primary)]"
                  placeholder="输入评论，随消息发给模型…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter 提交、Shift+Enter 换行（与主流输入框一致）
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submit(r.newLine, r.line);
                    }
                  }}
                />
                <div className="mt-2 flex justify-end gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => setPromptLine(null)}>
                    取消
                  </Button>
                  <Button size="sm" disabled={!draft.trim()} onClick={() => submit(r.newLine, r.line)}>
                    添加
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      ))}
    </div>
  );
}
