// 全局 session 搜索（P11 · F-11-2）纯逻辑。零依赖，可单测。
//
// 数据源 = sessions_list 全量（Rust sessions.json）；标题即「首条消息前 40 字」，
// 搜标题≈搜话题。前端拉全量后 fuzzy 过滤（DEC-25 fuzzysort 封装）。
// 空查询 = 最近 mtime 前 N 条（默认 20）。

import { filterPathsFuzzy } from "@/chat/logic/fuzzy";

/** 与 ipc/sessions.ts SessionEntry 对齐的最小字段（避免引 Tauri 依赖） */
export interface SearchableSession {
  session_id: string;
  adapter_id: string;
  title: string;
  cwd: string;
  mtime_ms: number;
}

const RECENT_LIMIT = 20;

/** fuzzy 过滤 + 排序；空查询返回最近 mtime 前 20 条 */
export function filterSessions<T extends SearchableSession>(entries: T[], query: string): T[] {
  const q = query.trim();
  if (q.length === 0) {
    return [...entries].sort((a, b) => b.mtime_ms - a.mtime_ms).slice(0, RECENT_LIMIT);
  }
  // 主文本 = title，辅文本 = cwd（合并搜索：任一命中即保留，title 命中排前）
  const byTitle = filterPathsFuzzy(
    entries.map((e) => e.title),
    q,
  );
  const titleSet = new Set(byTitle);
  const byCwd = filterPathsFuzzy(
    entries.filter((e) => !titleSet.has(e.title)).map((e) => e.cwd || ""),
    q,
  );
  const cwdTitles = new Set(byCwd);
  return entries.filter((e) => titleSet.has(e.title) || cwdTitles.has(e.cwd || ""));
}

/** 相对时间文案（供搜索结果条目展示） */
export function relativeTime(mtimeMs: number, now = Date.now()): string {
  const diff = now - mtimeMs;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(mtimeMs).toLocaleDateString();
}
