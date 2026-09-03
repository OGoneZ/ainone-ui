// slash 命令补全纯逻辑（F-4-7，P11 F-11-1 升级为模糊匹配）。零依赖，可单测。
//
// 行为：输入框以 `/` 开头时进入命令补全态。
//   - 只有 `/` → 列出全部命令（原序）
//   - `/` 后跟文本 → fuzzyScore 模糊匹配（fzf/zoxide 风格：子序列 + 打分排序，DEC-25）
// 选中后回填 `/<name> `（含尾随空格），光标由 UI 移到命令后供补参数；
// 命令始终作为普通文本发给 harness 解释（不本地执行）。

import type { CommandWord } from "../store/sessionStore";
import { filterFuzzy } from "./fuzzy";

/** 是否处于命令补全态 */
export function isSlashInput(input: string): boolean {
  return input.startsWith("/");
}

/** 过滤出匹配当前输入的命令列表（fuzzy 打分降序；空查询保持原序） */
export function filterCommands(words: CommandWord[], input: string): CommandWord[] {
  if (!input.startsWith("/")) return [];
  const q = input.slice(1).trim();
  if (q.length === 0) return words;
  return filterFuzzy(words, (w) => w.name, q).map(({ item }) => item);
}

/** 选中某命令后的回填文本（含 `/` 与尾随空格） */
export function completeCommand(word: CommandWord): string {
  return `/${word.name} `;
}
