// `@` 文件选取联想纯逻辑（P11 · F-11-3）。零 Tauri 依赖，可单测。
//
// 语义（DEC-28）：输入框词首键入 `@` → 弹文件联想菜单；数据源 = cwd 递归目录索引
// （懒加载，上限 500 条防大仓卡顿）；选中 → 光标处插入 `@file:/abs/path ` 并进附件胶囊。
// `@` 只在「词首」（行首或空白字符之后）触发，邮箱 a@b 不触发。
//
// 模糊过滤复用 fuzzysort 封装（DEC-25 修订）。

import { filterPathsFuzzy } from "./fuzzy";

export interface AtFileEntry {
  /** 相对 cwd 路径（展示与过滤用），如 src/acp/fuzzy.ts */
  rel: string;
  /** 绝对路径（插入用），如 /Users/x/dev/ainone-ui/src/acp/fuzzy.ts */
  abs: string;
  isDir: boolean;
}

export interface AtToken {
  query: string;
  /** `@` 起点在文本中的下标 */
  start: number;
  /** token 结束下标（光标处） */
  end: number;
}

const MAX_FILES = 500;

/**
 * 检测光标处是否处于 `@` 文件 token 内。
 * caret 为光标位置（textarea.selectionStart）。词首判定：`@` 前是文本起点或空白。
 */
export function detectAtToken(text: string, caret: number): AtToken | null {
  // 从光标向前找最近的空白（token 内不允许空白）
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const seg = text.slice(start, caret);
  const at = seg.indexOf("@");
  if (at !== 0) return null; // `@` 必须是 token 首字符（词首），a@b 不触发
  return { query: seg.slice(1), start, end: caret };
}

/**
 * 目录树扁平化为 AtFileEntry 列表（递归，上限 500）。
 * tree 约定：「目录 key（根为 cwd 本身，子目录为相对路径）→ 子项列表」——
 * 与 ChatPanel 的懒加载缓存形状一致（根键 = cwd）。
 */
export function flattenWorkspaceFiles(
  cwd: string,
  tree: Record<string, Array<{ name: string; is_dir: boolean }>>,
): AtFileEntry[] {
  return collect(cwd, tree, "");
}

/** 内部递归：base 为相对路径（"" = 根） */
function collect(
  cwd: string,
  tree: Record<string, Array<{ name: string; is_dir: boolean }>>,
  base: string,
  out: AtFileEntry[] = [],
): AtFileEntry[] {
  const key = base === "" ? cwd : base;
  const entries = tree[key] ?? [];
  for (const e of entries) {
    const rel = base === "" ? e.name : `${base}/${e.name}`;
    const abs = `${cwd.replace(/\/+$/, "")}/${rel}`;
    out.push({ rel, abs, isDir: e.is_dir });
    if (out.length >= MAX_FILES) return out;
    if (e.is_dir) collect(cwd, tree, rel, out);
    if (out.length >= MAX_FILES) return out;
  }
  return out;
}

/** fuzzy 过滤文件列表（按 rel 路径打分）；目录排在文件前 */
export function filterAtFiles(files: AtFileEntry[], query: string): AtFileEntry[] {
  if (files.length === 0) return [];
  if (query.trim().length === 0) return files.slice(0, MAX_FILES);
  const ordered = filterPathsFuzzy(files.map((f) => f.rel), query)
    .map((rel) => files.find((f) => f.rel === rel)!)
    .sort((a, b) => Number(b.isDir) - Number(a.isDir));
  return ordered;
}

/** 选中文件后的替换拼装：把 [token.start, token.end) 替换为 `@file:<abs> ` */
export function applyAtToken(text: string, token: AtToken, file: AtFileEntry): string {
  return text.slice(0, token.start) + `@file:${file.abs} ` + text.slice(token.end);
}
