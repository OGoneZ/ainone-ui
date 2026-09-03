// F-12-3 工具活动组：把一轮回复内连续的「已完成」thought/tool 块聚合为一张卡（DEC-36）。
// 规则：
//   - 连续段 = 相邻的 thought + tool 块（不含 text）
//   - 段内所有 tool 块必须已完成（status 不是 pending/in_progress）才整段入组
//   - text 块、运行中块 → 独立渲染项，并截断分组
// 零 React 依赖，vitest 直接覆盖。

import type { BlockMsg } from "./message-log";

/** 渲染项：原块透传 或 聚合组 */
export type RenderItem =
  | { type: "block"; block: BlockMsg }
  | { type: "activity_group"; thoughts: number; tools: number; ms: number; blocks: BlockMsg[] };

function isSettled(tool: BlockMsg & { kind: "tool" }): boolean {
  return tool.status !== "pending" && tool.status !== "in_progress";
}

/** 单块是否可入组（thought 恒可；tool 需已完成） */
function groupable(b: BlockMsg): boolean {
  if (b.kind === "thought") return true;
  if (b.kind === "tool") return isSettled(b);
  return false;
}

export function buildActivityGroups(blocks: BlockMsg[]): RenderItem[] {
  const out: RenderItem[] = [];
  let group: BlockMsg[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const thoughts = group.filter((b) => b.kind === "thought").length;
    const tools = group.filter((b) => b.kind === "tool").length;
    const ms = group.reduce((s, b) => (b.kind === "thought" ? s + (b.ms ?? 0) : s), 0);
    out.push({ type: "activity_group", thoughts, tools, ms, blocks: group });
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
