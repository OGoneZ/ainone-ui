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
import { buildActivityGroups, buildStreamingItems } from "@/chat/logic/activity";
import { useElapsedTicker } from "@/chat/hooks/useElapsedTicker";
import { aggregateFileChanges } from "@/chat/logic/fileChanges";
import { AgentAvatar } from "@/components/AgentAvatar";
import { formatBinding } from "@/app/logic/keymap";
import { useKeymapStore } from "@/store/keymapStore";
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
  return (
    <div className="group flex gap-2.5 my-2.5">
      <AgentAvatar adapterId={adapter.id} name={adapter.name} brandColor={adapter.logo} size={32} className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        {renderItems.map((item, i) =>
          item.type === "block" ? (
            <BlockView
              key={i}
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
            />
          ) : (
            <ActivityGroupCard key={i} item={item} live={busy && isLast} onSelect={onSelect} diffComments={diffComments} onAddDiffComment={onAddDiffComment} activityOverride={activityOverride} onActivityOverrideClear={onActivityOverrideClear} />
          ),
        )}
        {/* p22e：turn 总耗时并入活动组卡实时走秒；纯 text 轮次不显示计时。
            P30：纯 text 轮次的静默感知也随 TurnElapsed 一并移除——文本轮事件密集，
            静默提示仅在工具轮有意义；工具轮静默由 p22e 活动卡 + lastEventAt 的
            TurnElapsed（下方保留）承担。 */}
        {busy && isLast && lastEventAt ? <TurnElapsed lastEventAt={lastEventAt} /> : null}
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
}) {
  const [localOpen, setLocalOpen] = useState(false);
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
                <FileChangeRow key={f.path} change={f} diffs={diffs} diffComments={diffComments} onAddDiffComment={onAddDiffComment} />
              ))}
            </div>
          )}
          {item.blocks.map((b, i) => (
            <BlockView key={i} block={b} live={false} onSelect={onSelect} diffComments={diffComments} onAddDiffComment={onAddDiffComment} activityOverride={activityOverride} onActivityOverrideClear={onActivityOverrideClear} />
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
/** P30 AC-3.4：静默感知——距最近协议事件 ≥30s 时提示「可能在运行长任务」。
 *  p22e 已把总耗时并入活动组卡实时走秒，本组件只承担静默提示，不重复显示总耗时。 */
const SILENT_THRESHOLD_S = 30;

function TurnElapsed({ lastEventAt }: { lastEventAt: number }) {
  const silent = useElapsedTicker(lastEventAt);
  return (
    <div className="turn-elapsed" data-testid="turn-elapsed" style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
      {silent >= SILENT_THRESHOLD_S && (
        <span data-testid="silent-hint" style={{ color: "var(--warning)" }}>
          · 静默 {silent} 秒（可能在运行长任务或子代理）
        </span>
      )}
    </div>
  );
}
