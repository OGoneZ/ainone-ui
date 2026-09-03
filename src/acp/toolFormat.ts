// P11 F-R6 工具输出格式化纯逻辑：JSON 判定与 pretty 化。
// 判定必须保守：只有「整段文本是合法 JSON 值（对象/数组）」才格式化，
// 普通日志文本（哪怕含 { }）一律走原样路径，避免误伤。

/** 整段文本是否为合法 JSON 对象/数组（标量不算，避免 "42" 之类被误格式化） */
export function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  // 长度护栏：超大文本解析开销大且 UI 意义有限
  if (t.length > 200_000) return false;
  try {
    const v: unknown = JSON.parse(t);
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

/** pretty-print JSON；非法或超限返回 null（调用方回退原样路径） */
export function prettyJson(text: string, indent = 2): string | null {
  if (!looksLikeJson(text)) return null;
  try {
    return JSON.stringify(JSON.parse(text.trim()), null, indent);
  } catch {
    return null;
  }
}
