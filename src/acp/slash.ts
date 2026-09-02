// slash 命令补全纯逻辑（F-4-7）。零依赖，可单测。
//
// 行为：输入框以 `/` 开头时进入命令补全态。
//   - 只有 `/` → 列出全部命令
//   - `/` 后跟子串 → 按命令名过滤（前缀优先，其次包含）
// 选中后回填 `/<name> `（含尾随空格），光标由 UI 移到命令后供补参数；
// 命令始终作为普通文本发给 harness 解释（不本地执行）。

import type { CommandWord } from "../store/sessionStore";

/** 是否处于命令补全态 */
export function isSlashInput(input: string): boolean {
  return input.startsWith("/");
}

/** 过滤出匹配当前输入的命令列表（按 前缀命中 → 包含命中 排序） */
export function filterCommands(words: CommandWord[], input: string): CommandWord[] {
  if (!input.startsWith("/")) return [];
  const q = input.slice(1).trim().toLowerCase();
  if (q.length === 0) return words;
  const prefix: CommandWord[] = [];
  const includes: CommandWord[] = [];
  for (const w of words) {
    const name = w.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(w);
    else if (name.includes(q)) includes.push(w);
  }
  return [...prefix, ...includes];
}

/** 选中某命令后的回填文本（含 `/` 与尾随空格） */
export function completeCommand(word: CommandWord): string {
  return `/${word.name} `;
}
