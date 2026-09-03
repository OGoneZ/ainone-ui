// F-12-6a 上下文用量进度条（DEC-39）：常驻输入框左下，三态着色。
// 数据源 = store.runtime[t].usage（usage_update 已有链路，无新采集）；
// 无数据（harness 未上报）→ 不渲染。与元数据侧栏共存，不重复大块信息。

import { Progress } from "./ui/progress";
import { usagePercent, usageTier, type UsageInfo, type UsageTier as Tier } from "../acp/metadata";

const tierColor: Record<Tier, string> = {
  ok: "var(--primary)",
  warn: "var(--warning)",
  danger: "var(--danger)",
};

export function UsageBar({ usage }: { usage: UsageInfo | null }) {
  if (!usage || usage.size <= 0) return null;
  const pct = usagePercent(usage);
  const tier = usageTier(usage);
  return (
    <div
      className="usage-bar"
      data-testid="usage-bar"
      data-tier={tier}
      title={`已用 ${pct}% · ${usage.used.toLocaleString()}/${usage.size.toLocaleString()} tokens`}
    >
      <Progress
        value={pct}
        aria-label="上下文占用"
        className="h-1 w-[120px]"
        style={{ ["--usage-color" as string]: tierColor[tier] }}
      />
    </div>
  );
}
