// 首页宣传语打字机：一次性逐字打出后停住（区别于 chat/hooks/useTypewriter 的
// 循环删除重打——宣传语是品牌文案，打完常驻，光标闪烁交给 CSS）；
// prefers-reduced-motion 直接显全文（与 useTypewriter 同一降级惯例）。

import { useEffect, useState } from "react";

export function useHeadlineTypewriter(full: string): string {
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [n, setN] = useState(reduced ? full.length : 0);
  useEffect(() => {
    if (reduced) {
      setN(full.length);
      return;
    }
    setN(0);
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setN(i);
      if (i >= full.length) clearInterval(t); // 打完停住，不循环
    }, 90);
    return () => clearInterval(t);
  }, [full, reduced]);
  if (reduced) return full;
  return full.slice(0, n);
}
