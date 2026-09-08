// 块渲染：text / thought / tool 三分支（P4 F-4-1/F-4-2）。自 ChatPanel 拆出（P13 C3）。

import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import type { BlockMsg } from "@/acp/message-log";
import type { ToolContent } from "@/acp/session-core";
import { kindIcon, toolSubtitle } from "@/acp/toolDisplay";
import type { DiffComment } from "@/chat/logic/diffComments";
import { shouldAutoOpen } from "@/chat/logic/disclosure";
import { MarkdownView } from "./MarkdownView";
import { DiffView } from "./DiffView";
import { ToolTextView } from "./ToolTextView";
import {
  ChevronRightIcon,

  ThinkingIcon,
  TerminalIcon,
} from "@/components/ui/icons";
import { useElapsedTicker } from "@/chat/hooks/useElapsedTicker";

/** P30：工具 status → 中文文案（failed 为协议失败终态，error 为本地历史值） */
const TOOL_STATUS_LABEL: Record<string, string> = {
  pending: "等待",
  in_progress: "运行中",
  completed: "完成",
  failed: "失败",
  error: "失败",
};

function ThoughtView({
  text,
  ms,
  live,
  activityOverride,
  onActivityOverrideClear,
}: {
  text: string;
  ms?: number;
  live: boolean;
  activityOverride?: boolean | null;
  onActivityOverrideClear?: () => void;
}) {
  const [localOpen, setLocalOpen] = useState(live);
  const [thoughtStart, setThoughtStart] = useState<number | null>(null);
  // P32 AC-1.4：用户流式中手动收起/展开后不再被自动逻辑反复翻转。
  // seal（live→false）时的自动折叠仍执行——与折叠行语义一致，幂等无抖动。
  const userToggledRef = useRef(false);
  useEffect(() => {
    // 流式结束（live true→false）自动折叠——仅在无全局覆写时生效
    if (!live && (activityOverride ?? null) === null) setLocalOpen(false);
  }, [live, activityOverride]);
  // P32 AC-1.1：live 期间（含 thought 后已接 tool 的场景——live 与渲染位置解耦）
  // 重新变为 live 且用户未手动操作过 → 回到展开（新思考段开流）。已手动操作则尊重。
  useEffect(() => {
    if (live && !userToggledRef.current) setLocalOpen(true);
  }, [live]);
  // 实时计时（AC-P7-5-1 / P16b）：思考中每秒跳动——起点在 live 起时落定，
  // 用墙钟差而非 interval 计数（与总耗时同一时钟语义）
  useEffect(() => {
    if (!live || thoughtStart !== null) return;
    setThoughtStart(Date.now());
  }, [live, thoughtStart]);
  const elapsed = useElapsedTicker(thoughtStart ?? undefined);
  const isThinking = ms === undefined && live;
  const summary = ms !== undefined ? `已思考 ${(ms / 1000).toFixed(0)} 秒` : `思考中… ${elapsed}s`;
  // P25：全局覆写优先（新流入的 thought 也受控）；null 回局部态。
  // P32 AC-1.4：用户手动操作（覆写态下点击单卡）同样标记——回局部态后不再被自动翻转。
  const open = activityOverride ?? localOpen;
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
        onClick={() => {
          if (activityOverride !== null && activityOverride !== undefined) {
            onActivityOverrideClear?.();
            userToggledRef.current = true;
            setLocalOpen(false);
          } else {
            userToggledRef.current = true; // P32 AC-1.4：手动操作后不再自动干预
            setLocalOpen((v) => !v);
          }
        }}
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
  startTs,
  ms,
  content,
  toolKind,
  rawInput,
  diffComments,
  onAddDiffComment,
  activityOverride,
  onActivityOverrideClear,
}: {
  toolCallId: string;
  title: string;
  status: string;
  /** P30：协议 ToolKind（read/edit/execute/…）+ 原始入参（参数副标题）；旧日志缺省 */
  toolKind?: string;
  rawInput?: unknown;
  startTs?: number;
  ms?: number;
  content: ToolContent[];
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
  activityOverride?: boolean | null;
  onActivityOverrideClear?: () => void;
}) {
  // P25：全局覆写优先；null 回局部态。
  // P32 AC-2.2/2.3：折叠策略收敛到 disclosure 纯函数——含 diff 默认展开、「无 diff→
  // 有 diff」边沿自动展开、用户手动操作后永不自动干预。P32 S2：组件实例跨分组迁移
  // 存活（MessageLine 稳定键），open/userToggledRef 不再被重挂重置——「手动收起后
  // 被强开」的复发路径已从根上消除。
  const isDiff = content.some((c) => c.kind === "diff");
  const [localOpen, setLocalOpen] = useState(isDiff);
  const userToggledRef = useRef(false);
  const prevHasDiffRef = useRef(isDiff);
  useEffect(() => {
    // 边沿判定：上一帧无 diff、本帧有 diff（初始挂载 prevHasDiffRef 已同值，不触发）
    const becameDiff = shouldAutoOpen(prevHasDiffRef.current, isDiff);
    prevHasDiffRef.current = isDiff;
    if (becameDiff && !userToggledRef.current) {
      userToggledRef.current = true; // 边沿置位后不再自动干预（已展开即用户可见状态）
      setLocalOpen(true);
    }
  }, [isDiff]);
  const open = activityOverride ?? localOpen;
  // P16b：运行中（pending/in_progress）→ 实时秒表；终态 → 封口的 ms
  const running = status === "pending" || status === "in_progress";
  const elapsed = useElapsedTicker(running ? startTs : undefined);
  const timeLabel = running
    ? `${elapsed}s`
    : ms !== undefined && ms > 0
      ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
      : null;
  // P30 AC-2.3：kind 驱动图标（缺省回退扳手）+ rawInput 提炼参数副标题
  const KindIcon = kindIcon(toolKind);
  const subtitle = toolSubtitle(rawInput);
  return (
    // F-16-1（DEC-48）：data-status 驱动状态色点睛（CSS 按 status 着色）
    <div className="tool" data-status={status}>
      <div
        className="tool-head"
        onClick={() => {
          userToggledRef.current = true;
          if (activityOverride !== null && activityOverride !== undefined) {
            onActivityOverrideClear?.();
            setLocalOpen(false);
          } else {
            setLocalOpen((v) => !v);
          }
        }}
        title={title}
      >
        <span className="caret inline-flex transition-transform" style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)" }}>
          <ChevronRightIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
        </span>
        <KindIcon
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
        {subtitle && (
          <span className="tool-subtitle" title={subtitle}>
            {subtitle}
          </span>
        )}
        {timeLabel && <span className="tool-elapsed">{timeLabel}</span>}
        <span className="status">{TOOL_STATUS_LABEL[status] ?? status}</span>
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
  activityOverride,
  onActivityOverrideClear,
}: {
  block: BlockMsg;
  live: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
  activityOverride?: boolean | null;
  onActivityOverrideClear?: () => void;
}) {
  switch (block.kind) {
    case "text":
      return <MarkdownView text={block.text} live={live} onSelect={onSelect} />;
    case "thought":
      return (
        <ThoughtView
          text={block.text}
          ms={block.ms}
          live={live}
          activityOverride={activityOverride}
          onActivityOverrideClear={onActivityOverrideClear}
        />
      );
    case "tool":
      return (
        <ToolBlock
          toolCallId={block.toolCallId}
          title={block.title}
          status={block.status}
          toolKind={block.toolKind}
          rawInput={block.rawInput}
          startTs={block.startTs}
          ms={block.ms}
          content={block.content}
          diffComments={diffComments}
          onAddDiffComment={onAddDiffComment}
          activityOverride={activityOverride}
          onActivityOverrideClear={onActivityOverrideClear}
        />
      );
  }
}
