// F-7-6 打字机 placeholder：80ms/字循环打出；prefers-reduced-motion 直接显全文（AC-P7-6-1/6）。
// 去手搓评估（P13 §5）：~15 行、无边界 bug 史，不值得引入依赖——保留。
//
// P32 R3 暂停语义：enabled=false（非激活窗格 / 输入框已有内容）时停掉 interval
// 冻结输出。旧实现无条件每 80ms 重渲染一次宿主组件——N 个 tab 就是 N×12.5 次/s
// 纯浪费渲染，与 tab 是否可见、用户是否在打字无关。

import { useEffect, useState } from "react";

export function useTypewriter(full: string, enabled = true): string {
  const [n, setN] = useState(0);
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (reduced) {
      setN(full.length);
      return;
    }
    if (!enabled) return; // 冻结：不启 interval，保留当前进度
    setN(0);
    const t = setInterval(() => setN((i) => (i >= full.length ? 0 : i + 1)), 80);
    return () => clearInterval(t);
  }, [full, reduced, enabled]);
  if (reduced) return full;
  return full.slice(0, n);
}
