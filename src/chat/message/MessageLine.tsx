// 消息行渲染：user 右气泡 / assistant 左（全宽）+ 头像 + hover 复制（F-7-4）。
// P11 F-R7（AC-R7-1）：React.memo 包裹——流式新 chunk 只更新末条消息，
// 历史消息 props 引用不变（store 保证非末条 block 引用稳定）→ 跳过重渲染，
// 也就跳过 Streamdown 对长文本的全量重解析。导出供测试。
// 自 ChatPanel 拆出（P13 C3）：props 签名逐字保持，memo 语义不变。

import { memo, useState, useEffect } from "react";
import type { ChatMsg } from "@/store/sessionStore";
import type { StreamRate } from "@/chat/hooks/streamRate";
import type { ToolContent } from "@/acp/session-core";
import type { AdapterWithStatus } from "@/ipc/adapters";
import type { DiffComment } from "@/chat/logic/diffComments";
import type { RenderItem } from "@/chat/logic/activity";
import { buildActivityGroups, buildStreamingItems } from "@/chat/logic/activity";
import { groupDefaultOpen } from "@/chat/logic/disclosure";
import { useElapsedTicker } from "@/chat/hooks/useElapsedTicker";
import { aggregateFileChanges } from "@/chat/logic/fileChanges";
import { AgentAvatar } from "@/components/AgentAvatar";
import { formatBinding } from "@/app/logic/keymap";
import { useKeymapStore } from "@/store/keymapStore";
import {
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  EditIcon,
  EyeIcon,
  ForkIcon,
  RateIcon,
  RewindIcon,
  ToolIcon,
} from "@/components/ui/icons";
import { toast } from "sonner";
import { BlockView } from "./BlockView";
import { DiffView } from "./DiffView";

/** P25：活动卡头尾部的快捷键提示「（Ctrl+O 展开全部）」——淡色小字，键名实时取键位表 */
function ActivityToggleHint() {
  const bindings = useKeymapStore((s) => s.bindingsOf("pane.activity-toggle-all"));
  if (bindings.length === 0) return null;
  return <span className="activity-kbd-hint">（{formatBinding(bindings[0])} 展开全部）</span>;
}

export const MessageLine = memo(function MessageLine({
  msg,
  adapter,
  busy,
  isLast,
  lastEventAt,
  turnStartedAt,
  turnEndedAt,
  rateRef,
  ownerTabKey,
  onSelect,
  onFork,
  onRewind,
  onEdit,
  diffComments,
  onAddDiffComment,
  activityOverride,
  onActivityOverrideClear,
}: {
  msg: ChatMsg;
  adapter: AdapterWithStatus;
  busy: boolean;
  isLast: boolean;
  /** P30：当前 turn 最近一次协议事件时间戳（store）——静默感知数据源 */
  lastEventAt?: number;
  /** turn 总计时起点（store）——运行中轮次的墙钟计时数据源 */
  turnStartedAt?: number;
  /** turn 总耗时常驻：正常结束时的终点时间戳——结束后冻结为起点→终点墙钟差 */
  turnEndedAt?: number;
  /** P37 R3：速率器登记引用（末条消息专属）——TurnElapsed 右侧速率徽标数据源 */
  rateRef?: { current: import("@/chat/hooks/streamRate").StreamRate | null };
  /** P36 R3：所属窗格 tabKey——工具卡「预览文件」事件的归属标识（缺省不带） */
  ownerTabKey?: string;
  onSelect?: (text: string, e: React.MouseEvent) => void;
  onFork?: () => void;
  onRewind?: () => void;
  /** F-12-1 编辑重试：仅 user 消息传入 */
  onEdit?: () => void;
  /** F-12-5 diff 行内评论：待发评论集（已评论行标记用）+ 收集回调 */
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
  /** P25：Ctrl+O 全局展开/折叠覆写（null = 无覆写，各卡用局部默认态） */
  activityOverride?: boolean | null;
  /** P25：用户手动点击单卡时回调——清除全局覆写，回到局部态 */
  onActivityOverrideClear?: () => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="group flex flex-col items-end my-1.5">
        <div className="user-bubble max-w-[75%] px-3.5 py-2.5" style={{ backgroundColor: "var(--message-user-bg)", color: "#fff", borderRadius: "var(--radius-lg)", borderBottomRightRadius: "4px" }}>
          <span className="whitespace-pre-wrap break-words">{msg.text}</span>
        </div>
        {/* F-15-4：编辑/回溯移到气泡下方 hover 浮现的 icon-only 小钮行（DEC-44） */}
        <div className="mt-0.5 mr-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            aria-label="复制消息"
            title="复制消息"
            className="msg-action-btn"
            onClick={() => {
              navigator.clipboard?.writeText(msg.text).then(
                () => toast.success("已复制"),
                () => toast.error("复制失败"),
              );
            }}
          >
            <CopyIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
          </button>
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
  // P30：流式中（busy && isLast）尾部已完成的 tool 块暂不入组——completed 是即时判定的，
  // 无条件入组会把刚带 diff 的写块瞬间收进折叠卡，边沿自动展开失去意义（AC-3.2 失效）。
  // 非流式（历史回填/turn 结束后）保持原分组语义。
  const streaming = busy && isLast;
  const renderItems = streaming ? buildStreamingItems(msg.blocks) : buildActivityGroups(msg.blocks);
  // P32 AC-2.4：渲染项稳定键——块迁移（独立↔组卡）时 ToolBlock 实例不被卸载重挂，
  // open state / userToggledRef 得以跨分组存活（位置索引 key 是重挂丢 state 的根因）。
  // tool 块用 toolCallId（协议保证 turn 内唯一）；thought/text 段在 turn 内只追加不重排，
  // 段序键 + kind 前缀稳定（turn.ts 相邻同类块合并语义保证）；组卡用首成员块键派生。
  const itemKey = (item: RenderItem, i: number): string => {
    if (item.type === "block") {
      const b = item.block;
      if (b.kind === "tool") return `tool-${b.toolCallId}`;
      return `${b.kind}-${i}`;
    }
    const first = item.blocks[0];
    return first.kind === "tool" ? `group-tool-${first.toolCallId}` : `group-${first.kind}-${i}`;
  };
  return (
    <div className="group flex gap-2.5 my-2.5">
      <AgentAvatar adapterId={adapter.id} name={adapter.name} brandColor={adapter.logo} size={32} className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        {renderItems.map((item, i) =>
          item.type === "block" ? (
            <BlockView
              key={itemKey(item, i)}
              block={item.block}
              /* P32 AC-1.1/1.3：live 与「渲染树位置」解耦——只看数据（流式 turn 中且 ms 未落），
                 thought 后跟 tool 时不再被误判非 live 而闪收。text 块沿用「最后一个渲染项」判定
                 （streaming 模式 Markdown 只对增长中的尾段有意义）。 */
              live={
                busy && isLast && item.block.kind === "thought" && item.block.ms === undefined
                  ? true
                  : busy && isLast && i === renderItems.length - 1 && item.block.kind === "text"
              }
              onSelect={onSelect}
              diffComments={diffComments}
              onAddDiffComment={onAddDiffComment}
              activityOverride={activityOverride}
              onActivityOverrideClear={onActivityOverrideClear}
              ownerTabKey={ownerTabKey}
            />
          ) : (
            <ActivityGroupCard key={itemKey(item, i)} item={item} live={busy && isLast} onSelect={onSelect} diffComments={diffComments} onAddDiffComment={onAddDiffComment} activityOverride={activityOverride} onActivityOverrideClear={onActivityOverrideClear} ownerTabKey={ownerTabKey} />
          ),
        )}
        {/* p22e：turn 总耗时并入活动组卡实时走秒；纯 text 轮次不显示计时。
            P30：纯 text 轮次的静默感知也随 TurnElapsed 一并移除——文本轮事件密集，
            静默提示仅在工具轮有意义；工具轮静默由 p22e 活动卡 + lastEventAt 的
            TurnElapsed（下方保留）承担。
            turn 总耗时：运行中从 turnStartedAt 走秒（runtime 实时值，仅末条）。
            P38：结束后读消息级 turnMs/rateTokPerS（随 JSONL 持久化）——每条
            assistant 消息独立判断，历史轮重开照常显示冻结值。 */}
        {busy && isLast && lastEventAt ? (
          <TurnElapsed lastEventAt={lastEventAt} turnStartedAt={turnStartedAt} turnEndedAt={turnEndedAt} rateRef={rateRef} />
        ) : !busy && msg.role === "assistant" && msg.turnMs !== undefined ? (
          <TurnElapsedTurnEnded turnMs={msg.turnMs} rateTokPerS={msg.rateTokPerS} />
        ) : null}
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
  activityOverride,
  onActivityOverrideClear,
  ownerTabKey,
}: {
  item: Extract<RenderItem, { type: "activity_group" }>;
  /** 当前 turn 运行中且是末条消息——running 组卡只在此时走秒（历史消息异常无 ms 的 thought 不走秒） */
  live: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
  /** P25：Ctrl+O 全局覆写（null = 无覆写） */
  activityOverride?: boolean | null;
  /** P25：手动点击单卡 → 清除全局覆写 */
  onActivityOverrideClear?: () => void;
  /** P36 R3：所属窗格 tabKey（预览文件事件归属） */
  ownerTabKey?: string;
}) {
  // P32 AC-2.6：组内含 diff → 组默认展开（写操作收组后仍可见）；其余折叠。
  // 初始值只在挂载时计算，之后纯手动/覆写驱动——流式重渲染不会强开已手动收起的组。
  const [localOpen, setLocalOpen] = useState(groupDefaultOpen(item.blocks));
  // P25：全局覆写优先；null 回局部态。手动点击时若覆写存在则清除覆写
  const open = activityOverride ?? localOpen;
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
  // P30 AC-2.4：折叠态就透出改动规模——「改了什么」不该藏在展开态里（徽标行见 JSX）
  return (
    <div className="activity-group my-1.5">
      <button
        type="button"
        aria-expanded={open}
        className="activity-head inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
        onClick={() => {
          if (activityOverride !== null && activityOverride !== undefined) {
            // P25：覆写生效时点单卡 → 清除覆写回到局部态（局部保持 false=折叠）
            onActivityOverrideClear?.();
            setLocalOpen(false);
          } else {
            setLocalOpen((v) => !v);
          }
        }}
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
        {fileChanges.length > 0 && (
          <span className="activity-filechanges" title={fileChanges.map((f) => f.path).join("\n")}>
            ·{" "}
            <span style={{ color: "var(--success)" }}>+{fileChanges.reduce((s, f) => s + f.added, 0)}</span>{" "}
            <span style={{ color: "var(--danger)" }}>−{fileChanges.reduce((s, f) => s + f.removed, 0)}</span>{" "}
            {fileChanges.length} 个文件
          </span>
        )}
        {/* P25：折叠态淡色提示「Ctrl+O 展开全部」（键名实时取键位表，改绑后同步） */}
        {!open && <ActivityToggleHint />}
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
                <FileChangeRow key={f.path} change={f} diffs={diffs} diffComments={diffComments} onAddDiffComment={onAddDiffComment} ownerTabKey={ownerTabKey} />
              ))}
            </div>
          )}
          {/* P32 AC-2.4：组内块也用稳定键——组展开态切换时块实例存活，ToolBlock 的
              展开态/userToggledRef 不被重置（组卡 open 收起再展开不折腾块级状态） */}
          {item.blocks.map((b) => (
            <BlockView
              key={b.kind === "tool" ? `tool-${b.toolCallId}` : `${b.kind}-${b.kind === "thought" ? b.text.slice(0, 16) : b.text.slice(0, 16)}`}
              block={b}
              live={false}
              onSelect={onSelect}
              diffComments={diffComments}
              onAddDiffComment={onAddDiffComment}
              activityOverride={activityOverride}
              onActivityOverrideClear={onActivityOverrideClear}
              ownerTabKey={ownerTabKey}
            />
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
  ownerTabKey,
}: {
  change: { path: string; added: number; removed: number };
  diffs: Array<Extract<ToolContent, { kind: "diff" }>>;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
  /** P36 R3：所属窗格 tabKey（预览文件事件归属） */
  ownerTabKey?: string;
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
      <button
        type="button"
        className="tool-preview-btn"
        aria-label={`预览 ${change.path}`}
        title={`预览文件 ${change.path}`}
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("ainone:open-file", { detail: { path: change.path, tabKey: ownerTabKey } }),
          );
        }}
      >
        <EyeIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
        {/* P36 用户反馈：纯图标不可发现——hover 显现时带文字标签 */}
        <span className="tool-preview-btn-label">点击预览</span>
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
/** P30 AC-3.4：静默感知——距最近协议事件 ≥30s 时提示「可能在运行长任务」。
 *  p22e 已把总耗时并入活动组卡实时走秒，本组件只承担静默提示，不重复显示总耗时。 */
const SILENT_THRESHOLD_S = 30;

/** 秒数 → h/m/s 自适应格式：不足 1 分钟「42 秒」，不足 1 小时「3 分 5 秒」，更长「1 时 2 分 3 秒」 */
function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} 时`);
  if (h > 0 || m > 0) parts.push(`${m} 分`);
  parts.push(`${s} 秒`);
  return parts.join(" ");
}

function TurnElapsed({ lastEventAt, turnStartedAt, turnEndedAt, rateRef }: { lastEventAt: number; turnStartedAt?: number; turnEndedAt?: number; rateRef?: { current: StreamRate | null } }) {
  const silent = useElapsedTicker(lastEventAt);
  // turn 总耗时：从 turn 发出时刻起走秒（墙钟）；已封口（turnEndedAt）则冻结终点不再走
  const ticking = useElapsedTicker(turnStartedAt && !turnEndedAt ? turnStartedAt : undefined);
  const frozen =
    turnStartedAt && turnEndedAt ? Math.max(0, Math.round((turnEndedAt - turnStartedAt) / 1000)) : null;
  const total = ticking || (frozen ?? 0);
  return (
    <div className="turn-elapsed" data-testid="turn-elapsed" style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px", display: "flex", alignItems: "center", gap: 4 }}>
      {turnStartedAt ? (
        <span data-testid="turn-total" className="inline-flex items-center gap-1">
          <ClockIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
          用时 {formatElapsed(total)}
        </span>
      ) : null}
      {/* P37 R3：输出速率徽标——总时钟右侧（TurnElapsed 只在 busy && isLast 渲染，
          live 恒为 true；收口后由 TurnElapsedTurnEnded 的 live=false 分支显示冻结值） */}
      <StreamRateBadge rateRef={rateRef} live={true} />
      {silent >= SILENT_THRESHOLD_S && (
        <span data-testid="silent-hint" style={{ color: "var(--warning)" }}>
          · 静默 {silent} 秒（可能在运行长任务或子代理）
        </span>
      )}
    </div>
  );
}

/** turn 结束后的常驻总耗时（冻结值，不走秒不消失）。
 *  P38：数据源改为消息级 turnMs/rateTokPerS（随 JSONL 持久化）——每条 assistant
 *  消息独立渲染，历史会话重开照常显示；rateTokPerS 缺省（纯 tool turn/旧日志）不显示徽标。 */
function TurnElapsedTurnEnded({ turnMs, rateTokPerS }: { turnMs: number; rateTokPerS?: number }) {
  const seconds = Math.max(0, Math.round(turnMs / 1000));
  const color = rateTokPerS !== undefined ? (rateTokPerS < 15 ? "var(--danger)" : rateTokPerS < 30 ? "var(--warning)" : "var(--success)") : undefined;
  return (
    <div className="turn-elapsed" data-testid="turn-elapsed-ended" style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px", display: "flex", alignItems: "center", gap: 4 }}>
      <span data-testid="turn-total" className="inline-flex items-center gap-1">
        <ClockIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
        用时 {formatElapsed(seconds)}
      </span>
      {/* P37 R3：收口后冻结的平均速率（与总耗时常驻语义对齐）；P38：消息级持久值 */}
      {rateTokPerS !== undefined && (
        <span data-testid="stream-rate" data-live="false" className="inline-flex items-center gap-1" style={{ color }}>
          <RateIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
          {rateTokPerS < 10 ? rateTokPerS.toFixed(1) : Math.round(rateTokPerS)} tok/s
        </span>
      )}
    </div>
  );
}

/** P37 R3：输出速率徽标——速率图标 + `N tok/s`，总时钟右侧。
 *  数据流：rateRef.current.display()（到达侧估算/终值冻结），不进 zustand store
 *  （P32 R2 教训：每秒变的值进 App 级订阅会击穿浅比较全树重渲染）。局部 1s
 *  interval 重读（与 useElapsedTicker 同频），仅挂载时运行——非末条不渲染本组件。
 *  分档着色（pi-token-speed 阈值）：<15 danger / 15-30 warning / ≥30 success。 */
function StreamRateBadge({ rateRef, live }: { rateRef?: { current: StreamRate | null }; live: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!rateRef?.current) return null;
  const v = rateRef.current.display(Date.now());
  if (v === null || v <= 0) return null;
  const color =
    v < 15 ? "var(--danger)" : v < 30 ? "var(--warning)" : "var(--success)";
  return (
    <span
      data-testid="stream-rate"
      data-live={live ? "true" : "false"}
      className="inline-flex items-center gap-1"
      style={{ color }}
      title={live ? "当前输出速率（估算值）" : "本轮平均输出速率"}
    >
      <RateIcon style={{ width: 12, height: 12, strokeWidth: 1.75, flexShrink: 0 }} />
      {v < 10 ? v.toFixed(1) : Math.round(v)} tok/s
    </span>
  );
}
