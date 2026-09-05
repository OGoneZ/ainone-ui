// 块渲染：text / thought / tool 三分支（P4 F-4-1/F-4-2）。自 ChatPanel 拆出（P13 C3）。

import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import type { BlockMsg } from "@/acp/message-log";
import type { ToolContent } from "@/acp/session-core";
import type { DiffComment } from "@/chat/logic/diffComments";
import { MarkdownView } from "./MarkdownView";
import { DiffView } from "./DiffView";
import { ToolTextView } from "./ToolTextView";
import {
  ChevronRightIcon,

  ThinkingIcon,
  TerminalIcon,
  ToolIcon,
} from "@/components/ui/icons";

function ThoughtView({ text, ms, live }: { text: string; ms?: number; live: boolean }) {
  const [open, setOpen] = useState(live);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    // 流式结束（live true→false）自动折叠
    if (!live) setOpen(false);
  }, [live]);
  // 实时计时（AC-P7-5-1）：思考中每秒跳动；reduced-motion 不影响计时（只关动画）
  useEffect(() => {
    if (!live) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const isThinking = ms === undefined && live;
  const summary = ms !== undefined ? `已思考 ${(ms / 1000).toFixed(0)} 秒` : `思考中… ${elapsed}s`;
  return (
    <div
      className="my-1.5"
      data-live={live ? "true" : "false"}
      style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.7 }}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 hover:bg-[var(--bg-hover)]"
        style={{ color: isThinking ? "var(--warning)" : "var(--text-secondary)" }}
        onClick={() => setOpen((v) => !v)}
      >
        {/* chevron 0.2s 旋转（AC-P7-5-3） */}
        <span
          className="inline-flex transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)", transitionTimingFunction: "var(--ease-out-soft)" }}
        >
          <ChevronRightIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
        </span>
        <ThinkingIcon
          className={isThinking ? "animate-pulse" : ""}
          style={{ width: 13, height: 13, strokeWidth: 1.75 }}
        />
        <span>{summary}</span>
        {/* 思考中 pulse 省略号（AC-P7-5-1） */}
        {isThinking && (
          <span className="animate-pulse" aria-hidden="true">
            …
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            backgroundColor: "var(--thought-bg)",
            borderRadius: "var(--radius-sm)",
            padding: "8px 12px",
            marginLeft: "20px",
            marginTop: "2px",
          }}
        >
          {/* P11 F-R8（DEC-25）：thinking 展开体走 markdown 渲染（thinking 同样可能
              含代码围栏/公式/列表）；小字号沿用外层 13px。不用 PhotoProvider
              （AC-R8-3：thinking 是过程性内容，批注选区明确降级不开放）。 */}
          <Streamdown
            mode={live ? "streaming" : "static"}
            parseIncompleteMarkdown={live}
            plugins={{ code, math }}
            shikiTheme={["github-light", "github-dark"]}
          >
            {text}
          </Streamdown>
        </div>
      )}
    </div>
  );
}

function ToolBlock({
  title,
  status,
  content,
  diffComments,
  onAddDiffComment,
}: {
  toolCallId: string;
  title: string;
  status: string;
  content: ToolContent[];
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    // F-16-1（DEC-48）：data-status 驱动状态色点睛（CSS 按 status 着色）
    <div className="tool" data-status={status}>
      <div className="tool-head" onClick={() => setOpen((v) => !v)} title={title}>
        <span className="caret inline-flex transition-transform" style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)" }}>
          <ChevronRightIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
        </span>
        <ToolIcon
          style={{
            width: 14,
            height: 14,
            strokeWidth: 1.75,
            flexShrink: 0,
            display: "inline-block",
            verticalAlign: "middle",
          }}
        />
        <span>{title}</span>
        <span className="status">{status}</span>
      </div>
      {open && content.length > 0 && (
        <div className="tool-body">
          {content.map((c, i) => (
            <ToolContentView key={i} content={c} diffComments={diffComments} onAddDiffComment={onAddDiffComment} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolContentView({
  content,
  diffComments,
  onAddDiffComment,
}: {
  content: ToolContent;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  switch (content.kind) {
    case "text":
      return <ToolTextView text={content.text} />;
    case "diff":
      return (
        <DiffView
          path={content.diff.path}
          oldText={content.diff.oldText}
          newText={content.diff.newText}
          diffComments={diffComments}
          onAddDiffComment={onAddDiffComment}
        />
      );
    case "terminal":
      return (
        <div className="tool-terminal inline-flex items-center gap-1">
          <TerminalIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
          终端 {content.terminal.terminalId}
        </div>
      );
  }
}

export function BlockView({
  block,
  live,
  onSelect,
  diffComments,
  onAddDiffComment,
}: {
  block: BlockMsg;
  live: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  switch (block.kind) {
    case "text":
      return <MarkdownView text={block.text} live={live} onSelect={onSelect} />;
    case "thought":
      return <ThoughtView text={block.text} ms={block.ms} live={live} />;
    case "tool":
      return (
        <ToolBlock
          toolCallId={block.toolCallId}
          title={block.title}
          status={block.status}
          content={block.content}
          diffComments={diffComments}
          onAddDiffComment={onAddDiffComment}
        />
      );
  }
}
