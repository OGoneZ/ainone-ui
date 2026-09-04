// 空态欢迎页纯逻辑（F-6-3）。零依赖，可单测。
//
//   - welcomeGreeting：按小时给出时间段问候（早上好/下午好/晚上好）
//   - suggestionsFor：按 adapter 给出差异化建议 prompt

import type { AdapterWithStatus } from "../ipc/adapters";

/** 按小时（0-23）返回问候语 */
export function welcomeGreeting(hour: number): string {
  if (hour < 5) return "夜深了";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** 通用建议 + adapter 差异化前缀 */
export function suggestionsFor(adapter: AdapterWithStatus): string[] {
  const base = [
    "帮我看看这个项目是做什么的",
    "总结当前目录的结构",
    "写一个 Hello World",
  ];
  return [`和 ${adapter.name} 一起开始吧：`, ...base];
}

/** F-7-6 打字机 placeholder 文案：取差异化建议的第一条实质项 */
export function typewriterHint(adapter: AdapterWithStatus): string {
  const all = suggestionsFor(adapter);
  return all.find((s) => !s.startsWith("和 ")) ?? all[0];
}
