// 消息行渲染：user 右气泡 / assistant 左（全宽）+ 头像 + hover 复制（F-7-4）。
// P11 F-R7（AC-R7-1）：React.memo 包裹——流式新 chunk 只更新末条消息，
// 历史消息 props 引用不变（store 保证非末条 block 引用稳定）→ 跳过重渲染，
// 也就跳过 Streamdown 对长文本的全量重解析。导出供测试。
// 自 ChatPanel 拆出（P13 C3）：props 签名逐字保持，memo 语义不变。

import { memo, useState } from "react";
import type { ChatMsg } from "@/store/sessionStore";
import type { ToolContent } from "@/acp/session-core";
import type { AdapterWithStatus } from "@/ipc/adapters";
import type { DiffComment } from "@/chat/logic/diffComments";
import type { RenderItem } from "@/chat/logic/activity";
import { buildActivityGroups } from "@/chat/logic/activity";
import { useElapsedTicker } from "@/chat/hooks/useElapsedTicker";
import { aggregateFileChanges } from "@/chat/logic/fileChanges";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  ForkIcon,
  RewindIcon,
  ToolIcon,
} from "@/components/ui/icons";
import { toast } from "sonner";
import { BlockView } from "./BlockView";
import { DiffView } from "./DiffView";

export const MessageLine = memo(function MessageLine({
  msg,
  adapter,
  busy,
  isLast,
  onSelect,
  onFork,
  onRewind,
  onEdit,
  diffComments,
  onAddDiffComment,
}: {
  msg: ChatMsg;
  adapter: AdapterWithStatus;
  busy: boolean;
  isLast: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
  onFork?: () => void;
  onRewind?: () => void;
  /** F-12-1 编辑重试：仅 user 消息传入 */
  onEdit?: () => void;
  /** F-12-5 diff 行内评论：待发评论集（已评论行标记用）+ 收集回调 */
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="group flex flex-col items-end my-1.5">
        <div className="user-bubble max-w-[75%] px-3.5 py-2.5" style={{ backgroundColor: "var(--message-user-bg)", color: "#fff", borderRadius: "var(--radius-lg)", borderBottomRightRadius: "4px" }}>
          <span className="whitespace-pre-wrap break-words">{msg.text}</span>
        </div>
        {/* F-15-4：编辑/回溯移到气泡下方 hover 浮现的 icon-only 小钮行（DEC-44） */}
        <div className="mt-0.5 mr-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {onEdit && (
            <button
              type="button"
              aria-label="编辑并重发"
              title="编辑并重发"
              className="msg-action-btn"
              onClick={onEdit}
            >
              <EditIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
            </button>
          )}
          {onRewind && (
            <button
              type="button"
              aria-label="回溯到这里"
              title="回溯到这里"
              className="msg-action-btn"
              onClick={onRewind}
            >
              <RewindIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
            </button>
          )}
        </div>
      </div>
    );
  }
  // F-12-3 活动组：连续已完成 thought/tool 聚合为一张卡（DEC-36）
  // 流式末条 turn 的运行中块不入组（isSettled 判定 + live 判定在渲染项内处理）
  const renderItems = buildActivityGroups(msg.blocks);
  return (
    <div className="group flex gap-2.5 my-2.5">
      <AgentAvatar adapterId={adapter.id} name={adapter.name} brandColor={adapter.logo} size={32} className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        {renderItems.map((item, i) =>
          item.type === "block" ? (
            <BlockView
              key={i}
              block={item.block}
              live={busy && isLast && i === renderItems.length - 1 && (item.block.kind === "thought" ? item.block.ms === undefined : item.block.kind === "text")}
              onSelect={onSelect}
              diffComments={diffComments}
              onAddDiffComment={onAddDiffComment}
            />
          ) : (
            <ActivityGroupCard key={i} item={item} live={busy && isLast} onSelect={onSelect} diffComments={diffComments} onAddDiffComment={onAddDiffComment} />
          ),
        )}
        {/* p22e：turn 总耗时并入活动组卡实时走秒（原单独 ⏱ 行删除）；纯 text 轮次不显示计时 */}
        {/* hover 浮现操作行（F-8-5 分叉 + F-7-4 复制；F-15-4 icon-only 小圆钮） */}
        <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {onFork && (
            <button
              type="button"
              aria-label="从这里分叉"
              title="从这里分叉"
              className="msg-action-btn"
              onClick={onFork}
            >
              <ForkIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
            </button>
          )}
          <button
            type="button"
            aria-label="复制回复"
            title="复制回复"
            className="msg-action-btn"
            onClick={() => {
              const text = msg.blocks
                .map((b) => (b.kind === "text" ? b.text : b.kind === "thought" ? b.text : ""))
                .filter(Boolean)
                .join("\n");
              navigator.clipboard?.writeText(text).then(
                () => toast.success("已复制"),
                () => toast.error("复制失败"),
              );
            }}
          >
            <CopyIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
          </button>
        </div>
      </div>
    </div>
  );
});

/** F-12-3 活动组卡：折叠态摘要 + 展开态时间线（含 F-12-4 文件变更子卡） */
function ActivityGroupCard({
  item,
  live,
  onSelect,
  diffComments,
  onAddDiffComment,
}: {
  item: Extract<RenderItem, { type: "activity_group" }>;
  /** 当前 turn 运行中且是末条消息——running 组卡只在此时走秒（历史消息异常无 ms 的 thought 不走秒） */
  live: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  const [open, setOpen] = useState(false);
  // p22e 实时总耗时：墙钟口径——运行中从组首块 startTs 起持续走秒（不管内部各段耗时），
  // 组内最后一块封口后冻结为「起点→终点」的墙钟差。旧日志无 startTs → 回退 ms 之和。
  const wallLive = item.running && live && item.firstStartTs !== undefined;
  const liveElapsed = useElapsedTicker(wallLive ? item.firstStartTs : undefined);
  const frozenSeconds =
    item.firstStartTs !== undefined && item.endAt !== undefined
      ? Math.max(0, Math.round((item.endAt - item.firstStartTs) / 1000))
      : null;
  // 显示优先级：实时秒 > 墙钟冻结值 > 旧口径 ms 之和（无 startTs 的历史数据）
  const seconds = wallLive
    ? String(liveElapsed)
    : frozenSeconds !== null
      ? String(frozenSeconds)
      : (item.ms / 1000).toFixed(0);
  const parts: string[] = [];
  if (item.thoughts > 0) parts.push(`思考 ${item.thoughts} 次`);
  if (item.tools > 0) parts.push(`工具 ${item.tools} 个`);
  const summary = parts.join(" · ") || "活动";
  // F-12-4 文件变更聚合：组内 tool 块的 diff content 按路径去重
  const diffs = item.blocks.flatMap((b) =>
    b.kind === "tool" ? b.content.filter((c): c is Extract<typeof c, { kind: "diff" }> => c.kind === "diff") : [],
  );
  const fileChanges = aggregateFileChanges(
    diffs.map((d) => ({ path: d.diff.path, oldText: d.diff.oldText, newText: d.diff.newText })),
  );
  return (
    <div className="activity-group my-1.5">
      <button
        type="button"
        aria-expanded={open}
        className="activity-head inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="inline-flex transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)", transitionTimingFunction: "var(--ease-out-soft)" }}
        >
          <ChevronRightIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
        </span>
        <ToolIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
        <span>{summary}</span>
        {seconds !== "0" && <span>· 用时 {seconds} 秒</span>}
      </button>
      {open && (
        <div
          className="activity-body"
          style={{
            borderLeft: "2px solid var(--border)",
            marginLeft: "10px",
            paddingLeft: "12px",
            marginTop: "4px",
          }}
        >
          {fileChanges.length > 0 && (
            <div className="file-changes my-1.5 rounded-md px-2.5 py-2" style={{ backgroundColor: "var(--bg-2)" }}>
              <div className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                文件变更
              </div>
              {fileChanges.map((f) => (
                <FileChangeRow key={f.path} change={f} diffs={diffs} diffComments={diffComments} onAddDiffComment={onAddDiffComment} />
              ))}
            </div>
          )}
          {item.blocks.map((b, i) => (
            <BlockView key={i} block={b} live={false} onSelect={onSelect} diffComments={diffComments} onAddDiffComment={onAddDiffComment} />
          ))}
        </div>
      )}
    </div>
  );
}

/** F-12-4 文件变更行：路径 + 增删徽标，点击展开该文件 diff */
function FileChangeRow({
  change,
  diffs,
  diffComments,
  onAddDiffComment,
}: {
  change: { path: string; added: number; removed: number };
  diffs: Array<Extract<ToolContent, { kind: "diff" }>>;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = change.path.split("/").filter(Boolean).pop() ?? change.path;
  const own = diffs.filter((d) => d.diff.path === change.path);
  return (
    <div className="file-change-row">
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--text-primary)", transitionDuration: "var(--motion-fast)" }}
        onClick={() => setOpen((v) => !v)}
      >
        <span title={change.path}>{name}</span>
        {change.added > 0 && <span style={{ color: "var(--success)" }}>+{change.added}</span>}
        {change.removed > 0 && <span style={{ color: "var(--danger)" }}>−{change.removed}</span>}
      </button>
      {open && (
        <div className="mt-1">
          {own.map((d, i) => (
            <DiffView
              key={i}
              path={d.diff.path}
              oldText={d.diff.oldText}
              newText={d.diff.newText}
              diffComments={diffComments}
              onAddDiffComment={onAddDiffComment}
            />
          ))}
        </div>
      )}
    </div>
  );
}
