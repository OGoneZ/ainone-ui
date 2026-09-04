// F-7-6 打字机 placeholder：80ms/字循环打出；prefers-reduced-motion 直接显全文（AC-P7-6-1/6）。
// 去手搓评估（P13 §5）：~15 行、无边界 bug 史，不值得引入依赖——保留。

import { useEffect, useState } from "react";

export function useTypewriter(full: string): string {
  const [n, setN] = useState(0);
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (reduced) {
      setN(full.length);
      return;
    }
    setN(0);
    const t = setInterval(() => setN((i) => (i >= full.length ? 0 : i + 1)), 80);
    return () => clearInterval(t);
  }, [full, reduced]);
  if (reduced) return full;
  return full.slice(0, n);
}
