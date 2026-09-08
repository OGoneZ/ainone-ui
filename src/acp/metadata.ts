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

/** P29：模型 ID 去上下文后缀（"saver/glm-5.3-flash[1m]" → "saver/glm-5.3-flash"；与 Rust strip_model_suffix 对齐） */
export function stripModelSuffix(model: string | null): string | null {
  if (!model) return null;
  return model.trim().replace(/\[1m\]$/, "") || null;
}

/** P29 R3：从会话配置选项提取当前模型（category="model" 的 select 项 currentValue）。
 *  ACP 官方稳定通道（Session Config Options RFD 已 stabilized）；omp/pi 实测提供。 */
export function extractSessionModel(
  configOptions: Array<{ category?: string | null; type: string; currentValue?: string | boolean }> | null | undefined,
): string | null {
  if (!configOptions) return null;
  for (const opt of configOptions) {
    if (opt.category === "model" && opt.type === "select" && typeof opt.currentValue === "string" && opt.currentValue) {
      return stripModelSuffix(opt.currentValue);
    }
  }
  return null;
}

/** 上下文占用百分比（0-100）；size 为 0 时返回 0 防除零。 */
export function usagePercent(info: UsageInfo): number {
  if (info.size <= 0) return 0;
  return Math.min(100, Math.round((info.used / info.size) * 100));
}

/** F-12-6a 进度条三态着色（DEC-39）：<80% ok / 80-99% warn / >=100% danger */
export type UsageTier = "ok" | "warn" | "danger";

export function usageTier(info: UsageInfo): UsageTier {
  if (info.size <= 0) return "ok";
  const pct = (info.used / info.size) * 100;
  if (pct >= 100) return "danger";
  if (pct >= 80) return "warn";
  return "ok";
}
