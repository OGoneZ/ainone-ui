// 本地消息日志：纯序列化/解析逻辑，零 Tauri 依赖（DEC-10 可单测）。
//
// 设计（plan-v2 F-4-3 / DEC-9 / DEC-10）：
//   - 每会话一份 JSONL，一行一条消息（JSON.stringify 会把文本内换行转义，
//     故按行切分安全）
//   - 本地日志是「单一真源」：恢复会话 = session/load（agent 上下文）+ 读日志回填 UI
//   - fs 操作经 LogStore 注入，本模块只做纯逻辑，vitest 直接覆盖
//
// 注意：ToolContent 来自 session-core（type-only，不引入运行时依赖）；本模块只做
//   序列化/解析纯逻辑，vitest 直接覆盖。

import type { ToolContent } from "./session-core";

export type ChatMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "thought"; text: string }
  | { role: "tool"; toolCallId: string; title: string; status: string; content: ToolContent[] };

export interface LogStore {
  /** 读回当前日志全量文本（可能为空串） */
  readAll(): Promise<string>;
  /** 追加一行（不含换行符；调用方负责保证单行） */
  appendLine(line: string): Promise<void>;
}

const ROLES = new Set(["user", "assistant", "thought", "tool"]);

function isChatMsg(o: unknown): o is ChatMsg {
  if (typeof o !== "object" || o === null) return false;
  const m = o as Record<string, unknown>;
  if (typeof m.role !== "string" || !ROLES.has(m.role)) return false;
  if (m.role === "tool") {
    return (
      typeof m.toolCallId === "string" &&
      typeof m.title === "string" &&
      typeof m.status === "string" &&
      Array.isArray(m.content)
    );
  }
  return typeof m.text === "string";
}

export function serializeMessage(msg: ChatMsg): string {
  return JSON.stringify(msg);
}

/** 解析单行；空行 / JSON 损坏 / 形状不合法 → null（降级跳过，不阻塞续聊） */
export function parseLine(line: string): ChatMsg | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    return isChatMsg(o) ? o : null;
  } catch {
    return null;
  }
}

/** 解析全量日志文本：逐行 parse，损坏行跳过 */
export function parseLog(raw: string): ChatMsg[] {
  return raw
    .split("\n")
    .map(parseLine)
    .filter((m): m is ChatMsg => m !== null);
}

/** 追加一批消息（每条一行） */
export async function appendMessages(store: LogStore, msgs: ChatMsg[]): Promise<void> {
  for (const m of msgs) {
    await store.appendLine(serializeMessage(m));
  }
}
