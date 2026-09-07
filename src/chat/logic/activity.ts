// F-12-3 工具活动组：把一轮回复内连续的「已完成」thought/tool 块聚合为一张卡（DEC-36）。
// 规则：
//   - 连续段 = 相邻的 thought + tool 块（不含 text）
//   - 段内所有 tool 块必须已完成（status 不是 pending/in_progress）才整段入组
//   - text 块、运行中块 → 独立渲染项，并截断分组
// 零 React 依赖，vitest 直接覆盖。
//
// p22e 实时总耗时（用户需求：不要「结束后算加法」，要「从第一块起持续走秒」）：
//   - firstStartTs：组内第一块 startTs（墙钟起点；thought/tool 事件落定即持久化）
//   - running：组尾块仍未封口（tool pending/in_progress，或 thought 无 ms=流式中）
//   - endAt：冻结时刻 = 最后封口块 startTs+ms（墙钟终点；任一块缺 startTs → undefined）
//   - ms 保留旧语义（各块 ms 之和），旧日志无 startTs 时渲染层回退用。

import type { BlockMsg } from "@/acp/message-log";

/** 渲染项：原块透传 或 聚合组 */
export type RenderItem =
  | { type: "block"; block: BlockMsg }
  | {
      type: "activity_group";
      thoughts: number;
      tools: number;
      ms: number;
      blocks: BlockMsg[];
      firstStartTs?: number;
      running: boolean;
      endAt?: number;
    };

function isSettled(tool: BlockMsg & { kind: "tool" }): boolean {
  // P30：协议失败终态是 failed（error 为本地历史值），两者都算已结算
  return tool.status !== "pending" && tool.status !== "in_progress";
}

/** 单块是否可入组（thought 恒可；tool 需已完成） */
function groupable(b: BlockMsg): boolean {
  if (b.kind === "thought") return true;
  if (b.kind === "tool") return isSettled(b);
  return false;
}

/** 组尾块是否未封口（p22e running 判定）：运行中 tool，或无 ms 的流式 thought */
function tailRunning(blocks: BlockMsg[]): boolean {
  const last = blocks[blocks.length - 1];
  if (!last) return false;
  if (last.kind === "tool") return !isSettled(last);
  if (last.kind === "thought") return last.ms === undefined;
  return false;
}

export function buildActivityGroups(blocks: BlockMsg[]): RenderItem[] {
  const out: RenderItem[] = [];
  let group: BlockMsg[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const thoughts = group.filter((b) => b.kind === "thought").length;
    const tools = group.filter((b) => b.kind === "tool").length;
    // F-16-2（DEC-49）：组耗时 = 思考 + 工具全段（thought.ms + tool.ms，缺省 0）
    const ms = group.reduce(
      (s, b) => (b.kind === "thought" || b.kind === "tool" ? s + (b.ms ?? 0) : s),
      0,
    );
    // p22e 实时总耗时字段：起点 = 第一块 startTs；终点 = 最后封口块 startTs+ms
    const first = group[0];
    const firstStartTs =
      first.kind === "thought" || first.kind === "tool" ? first.startTs : undefined;
    const last = group[group.length - 1];
    const endAt =
      last.kind === "tool"
        ? isSettled(last) && last.startTs !== undefined && last.ms !== undefined
          ? last.startTs + last.ms
          : undefined
        : last.kind === "thought" && last.startTs !== undefined && last.ms !== undefined
          ? last.startTs + last.ms
          : undefined;
    out.push({
      type: "activity_group",
      thoughts,
      tools,
      ms,
      blocks: group,
      firstStartTs,
      running: tailRunning(group),
      ...(endAt !== undefined ? { endAt } : {}),
    });
    group = [];
  };

  for (const b of blocks) {
    if (groupable(b)) {
      group.push(b);
      continue;
    }
    flush();
    out.push({ type: "block", block: b });
  }
  flush();
  return out;
}

/**
 * P30：流式中的分组——尾部一段（最后一个 text/工具边界之后）保持独立渲染，
 * 已完成的 tool 块不即时收组。理由：completed 是即时判定，流式中途把刚带 diff
 * 的写块收进折叠卡会让「写操作默认展开」落空（MessageLine busy&&isLast 时调用）。
 * 规则：从末尾向前找最后一个「不可组块」（text/运行中 tool）为界，界后全部独立；
 * 界前的连续段仍按 buildActivityGroups 分组（turn 前段活动收组，视觉紧凑）。
 * turn 结束（busy=false）后由调用方切回 buildActivityGroups 全量收组。
 */
export function buildStreamingItems(blocks: BlockMsg[]): RenderItem[] {
  // 末尾不可组块（含 text）之后不可能再有内容——找最后一个 groupable 段的边界
  let boundary = blocks.length;
  while (boundary > 0 && groupable(blocks[boundary - 1])) boundary -= 1;
  // boundary = 首个「从尾部连续 groupable 段」的起点；若整段全 groupable（纯工具序列流式）
  // 则 boundary === 0，界后为空 —— 此时保守不入组（全部独立），等 turn 结束统一收
  if (boundary === 0) {
    return blocks.map((block): RenderItem => ({ type: "block", block }));
  }
  return [
    ...buildActivityGroups(blocks.slice(0, boundary)),
    ...blocks.slice(boundary).map((block): RenderItem => ({ type: "block", block })),
  ];
}
