// 模糊匹配（P11 · F-11-1）。封装 fuzzysort v4（DEC-25 修订：社区成熟方案）。
//
// 选型（金标准：成熟/稳定/轻量优先，不重复造轮子）：
//   - fuzzysort：0 依赖、<1KB gzip、周下载 ~10M、TypeScript 内建类型、
//     v4.0.2（2026-08 仍在发布）；专为「命令面板/文件路径」类模糊搜索设计，
//     连续/词首/起始位置评分内置，正是 fzf/zoxide 的交互手感。
//   - 否决自研 ~60 行评分器（首版实现后被替换）与 fuse.js（6.8KB+，面向自然
//     语言字段搜索，对路径/命令名评分不佳）、microfuzz（社区较小）。
//
// 本模块只做两层薄封装：命令列表过滤（slash）与文件路径过滤（@），供两处复用。

import fuzzysort from "fuzzysort";
import type { CommandWord } from "../store/sessionStore";

export interface FuzzyHit<T> {
  item: T;
  score: number;
}

/** 空查询时返回的空 hit 常量（score 0，保持原序） */
const ZERO = { score: 0 };

/** 通用：对 items 按 textOf 抽取文本做 fuzzy 匹配，降序返回（无匹配剔除；空查询原序全返）。
 *  threshold: -Infinity = 不设截止（v4 默认 0.5 会把弱子序列命中整条丢弃，
 *  而文件路径/命令名的弱命中仍有导航价值；排序交给 score 本身）。 */
export function filterFuzzy<T>(items: T[], textOf: (item: T) => string, query: string): Array<FuzzyHit<T>> {
  const q = query.trim();
  if (q.length === 0) return items.map((item) => ({ item, ...ZERO }));
  const results = fuzzysort.go(q, items, {
    key: (it: T) => textOf(it),
    threshold: -Infinity,
    limit: 1000,
  });
  return results.map((r) => ({ item: r.obj, score: r.score }));
}

/** slash 命令列表过滤（F-11-1） */
export function filterCommandsFuzzy(words: CommandWord[], query: string): CommandWord[] {
  return filterFuzzy(words, (w) => w.name, query).map((h) => h.item);
}

/** 文件路径列表过滤（F-11-3） */
export function filterPathsFuzzy(paths: string[], query: string): string[] {
  return filterFuzzy(paths, (p) => p, query).map((h) => h.item);
}
