// F-12-4 文件变更聚合：diff 行数统计 + 同路径合并（DEC-37）。
// 行数用社区金标准 `diff`（diffLines）计算——手写只在行数差场景准确，
// 中间插入/删除块会算错；diff@9 周下载 1.4 亿、零依赖。

import { diffLines } from "diff";

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

/** 单个 diff 的增删行数；oldText 缺失/空 = 新文件（全记 added） */
export function countDiffLines(
  oldText: string | null | undefined,
  newText: string,
): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const hunks = diffLines(oldText ?? "", newText ?? "");
  for (const h of hunks) {
    if (h.added) added += h.count ?? 0;
    else if (h.removed) removed += h.count ?? 0;
  }
  return { added, removed };
}

/** 把一批 diff content 聚合为按路径去重的文件变更列表（保持首次出现顺序） */
export function aggregateFileChanges(
  diffs: Array<{ path: string; oldText?: string | null; newText: string }>,
): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const d of diffs) {
    const { added, removed } = countDiffLines(d.oldText, d.newText);
    const prev = byPath.get(d.path);
    if (prev) {
      prev.added += added;
      prev.removed += removed;
    } else {
      byPath.set(d.path, { path: d.path, added, removed });
    }
  }
  return [...byPath.values()];
}
