// 元数据侧栏的纯派生逻辑（P8 · F-8-4）。零依赖，可单测。
//
// 数据源（plan-p8.md §2 / DEC-13）：
//   - 上下文占用 / token / 成本 → usage_update（已实测）
//   - 「当前模型」→ adapter 启动参数 args 里的 --model（ACP 协议不提供模型名）

export interface UsageInfo {
  /** 已用 token（上下文占用） */
  used: number;
  /** 上下文窗口总 token */
  size: number;
  /** 累计成本金额（无则 null） */
  cost: number | null;
}

/** 从 usage_update 提取 {used, size, cost}；空值/缺 cost 安全。 */
export function extractUsage(
  u?: { used?: number; size?: number; cost?: { amount?: number } | null } | null,
): UsageInfo {
  const used = typeof u?.used === "number" ? u.used : 0;
  const size = typeof u?.size === "number" ? u.size : 0;
  const cost = typeof u?.cost?.amount === "number" ? u.cost.amount : null;
  return { used, size, cost };
}

/** 从 adapter args 提取 --model 的值（DEC-13）；无则 null。 */
export function extractModel(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

/** 上下文占用百分比（0-100）；size 为 0 时返回 0 防除零。 */
export function usagePercent(info: UsageInfo): number {
  if (info.size <= 0) return 0;
  return Math.min(100, Math.round((info.used / info.size) * 100));
}
