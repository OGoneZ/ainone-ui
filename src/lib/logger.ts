// 前端统一日志：把散落的 console.* 收口到 @tauri-apps/plugin-log，让前端日志与
// Rust 日志落进同一份日志文件（macOS ~/Library/Logs/com.zhubaoduo.ainone-ui/ainone-ui.log）。
//
// 用法：import { logger } from "./logger"; logger.info("spawn", { adapterId, program });
//   logger.debug / info / warn / error 四级；error 会附带 Error 栈。
//   debug 用于可忽略的细节，info 用于关键链路节点，warn 用于可恢复异常，error 用于故障。

import { attachConsole, debug, info, warn, error, trace } from "@tauri-apps/plugin-log";

// 结构化可视化：对象用 JSON 序列化，避免 [object Object]
function fmt(...args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
}

// Error/对象分轨：JSON.stringify(new Error("x")) 恒为 "{}"（message/stack 不可枚举），
// React onCaughtError 转发的错误对象曾全被序列化成空串，崩溃无从排查。
// Error 优先 name: message + stack；普通对象仍走 JSON。
export function fmtValue(v: unknown): string {
  if (v instanceof Error) {
    return v.stack || `${v.name}: ${v.message}`;
  }
  return safeStringify(v);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function tag(scope: string, msg: string): string {
  return `[${scope}] ${msg}`;
}

export const logger = {
  trace: (scope: string, ...args: unknown[]) => trace(tag(scope, fmt(...args))),
  debug: (scope: string, ...args: unknown[]) => debug(tag(scope, fmt(...args))),
  info: (scope: string, ...args: unknown[]) => info(tag(scope, fmt(...args))),
  warn: (scope: string, ...args: unknown[]) => warn(tag(scope, fmt(...args))),
  error: (scope: string, ...args: unknown[]) => error(tag(scope, fmt(...args))),
};

/** 把全局 console.* 转发到 log 插件（四次调用收敛，dev 下仍打印到浏览器控制台） */
export function installConsoleForward(): void {
  const map: Array<["log" | "debug" | "info" | "warn" | "error", (m: string) => Promise<void>]> = [
    ["log", trace],
    ["debug", debug],
    ["info", info],
    ["warn", warn],
    ["error", error],
  ];
  for (const [fn, sink] of map) {
    const original = console[fn].bind(console);
    console[fn] = (...args: unknown[]) => {
      original(...args);
      void sink(args.map((a) => (typeof a === "string" ? a : fmtValue(a))).join(" "));
    };
  }
}

/** 在 main.tsx 顶部调用：把 Rust 日志同步到浏览器控制台（LogDir 已落盘，这里只转发到 devtools） */
export async function attach(): Promise<void> {
  try {
    await attachConsole();
  } catch {
    // attachConsole 失败（如非 Tauri 环境）不致命
  }
}

/** React 19 root 级 onCaughtError/onUncaughtError 接线（main.tsx 调用）：
 *  渲染期/未捕获异常带完整 Error（message+stack）落盘——ErrorBoundary 兜住后
 *  不能只在 UI 显示一句「出错了」，日志必须能定位根因。 */

/** 统一的 React 错误格式化（main.tsx 的 onCaughtError/onUncaughtError 复用） */
export function formatReactError(error: unknown, info?: unknown): string {
  const where = typeof info === "string" ? info : fmtValue(info);
  return `React ${error instanceof Error ? "caught" : "uncaught"}: ${fmtValue(error)}${where ? `\n${where}` : ""}`;
}
