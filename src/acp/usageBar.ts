// F-12-6a 上下文用量进度条：三态着色阈值判定（DEC-39）。
// <80% 正常 / 80–99% 琥珀 / ≥100% 红。纯函数可单测。

export type UsageTier = "ok" | "warn" | "danger";

export function usageTier(used: number, size: number): UsageTier {
  if (size <= 0) return "ok";
  const pct = (used / size) * 100;
  if (pct >= 100) return "danger";
  if (pct >= 80) return "warn";
  return "ok";
}

export function usagePercent(used: number, size: number): number {
  if (size <= 0) return 0;
  return Math.min(100, (used / size) * 100);
}
