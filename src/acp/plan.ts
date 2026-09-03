// 计划栏的纯派生逻辑（P9 · F-9-1）。零依赖，可单测。
//
// 数据源（DEC-16）：ACP `plan` block（全量替换语义）。每条 PlanEntry:
//   { content, priority: high|medium|low, status: pending|in_progress|completed }
// 每次收到 `plan` 整体覆盖旧计划。

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status: PlanStatus;
}

/** 已知 status 集合（未知值归 pending，防 harness 未来加状态炸 UI） */
const KNOWN_STATUS: Set<string> = new Set(["pending", "in_progress", "completed"]);

/** 从 plan update 提取条目；空 entries / 未知 status 安全。 */
export function extractPlan(
  u?: { entries?: Array<{ content?: unknown; priority?: unknown; status?: unknown }> } | null,
): PlanEntry[] {
  const entries = u?.entries;
  if (!Array.isArray(entries)) return [];
  const out: PlanEntry[] = [];
  for (const e of entries) {
    if (typeof e?.content !== "string") continue;
    const status = KNOWN_STATUS.has(String(e.status)) ? (e.status as PlanStatus) : "pending";
    const priority =
      e.priority === "high" || e.priority === "medium" || e.priority === "low"
        ? e.priority
        : undefined;
    out.push({ content: e.content, priority, status });
  }
  return out;
}

/** 统计已完成 / 总数（折叠态摘要）。 */
export function planProgress(entries: PlanEntry[]): { done: number; total: number } {
  const total = entries.length;
  const done = entries.filter((e) => e.status === "completed").length;
  return { done, total };
}
