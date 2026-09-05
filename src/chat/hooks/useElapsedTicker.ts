// 实时秒表（P16b）：从起点时间戳起每秒重渲染一次，返回「已流逝整秒」。
//
// 用途：思考中跳动（ThoughtView）、工具运行中耗时、turn 总耗时。
// 起点为 0/undefined → 不计时（返回 0，不发 interval）。
// 惰性取值：getNow 默认 Date.now；测试可注入。

import { useEffect, useState } from "react";

export function useElapsedTicker(startTs: number | undefined, getNow: () => number = Date.now): number {
  const [, force] = useState(0);
  useEffect(() => {
    if (!startTs) return;
    // 立即触发一次对齐（起点刚设置时同步显示 0s，之后每秒 +1）
    force((n) => n + 1);
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startTs]);
  return startTs ? Math.max(0, Math.floor((getNow() - startTs) / 1000)) : 0;
}
