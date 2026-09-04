// 工作区文件树纯逻辑（P9 · F-9-4）：排除清单过滤 + 路径拼接 + diff 路径收集。
// 零依赖，可单测。
//
// 排除大目录（node_modules/.git/target/dist/build）——硬编码清单（DEC-18）。

import type { ChatMsg } from "@/acp/message-log";

export const EXCLUDED_DIRS = ["node_modules", ".git", "target", "dist", "build"];

/** 排除清单过滤（目录才需过滤；文件保留） */
export function shouldExcludeDir(name: string): boolean {
  return EXCLUDED_DIRS.includes(name);
}

/** 排除某目录实体（仅目录命中清单才排除） */
export function filterExcluded(entries: Array<{ name: string; is_dir: boolean }>): Array<{ name: string; is_dir: boolean }> {
  return entries.filter((e) => !(e.is_dir && shouldExcludeDir(e.name)));
}

/** 拼接子目录绝对路径（父路径末尾去斜杠 + /子名） */
export function joinDirPath(parent: string, name: string): string {
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

/** 从消息列表收集被 diff 修改过的绝对路径（F-9-4「M」徽标数据源） */
export function collectModifiedPaths(messages: ChatMsg[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.blocks) {
      if (b.kind !== "tool") continue;
      for (const c of b.content) {
        if (c.kind === "diff" && c.diff.path) out.add(c.diff.path);
      }
    }
  }
  return out;
}
