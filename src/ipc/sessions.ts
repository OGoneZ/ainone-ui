// 会话索引前端封装：读写 Rust 的 sessions.json（记录可恢复的会话）。
// 另含本地消息日志（plan-v2 F-4-3）的 invoke 封装：log_read / log_append。

import { invoke } from "@tauri-apps/api/core";

export interface SessionEntry {
  session_id: string;
  adapter_id: string;
  title: string;
  cwd: string;
  /** 所属工作区 id（null = 未归组） */
  workspace_id: string | null;
  mtime_ms: number;
}

export async function sessionsList(): Promise<SessionEntry[]> {
  return invoke<SessionEntry[]>("sessions_list");
}

export async function sessionsUpsert(entry: SessionEntry): Promise<void> {
  await invoke("sessions_upsert", { entry });
}

export async function sessionsRemove(sessionId: string): Promise<void> {
  await invoke("sessions_remove", { sessionId });
}

/** 读回某会话的日志全量文本（不存在返回空串） */
export async function logRead(sessionId: string): Promise<string> {
  return invoke<string>("log_read", { sessionId });
}

/** 追加多行（每行已序列化、不含换行符）到会话日志 */
export async function logAppend(sessionId: string, lines: string[]): Promise<void> {
  await invoke("log_append", { sessionId, lines });
}

/** F-8-6 回溯：把会话日志截断到前 N 行（之后消息丢弃） */
export async function logTruncate(sessionId: string, keepLines: number): Promise<void> {
  await invoke("log_truncate", { sessionId, keepLines });
}

/** F-11-5 分叉跳转：把父会话日志复制为新 sessionId 的日志（目标覆盖） */
export async function logCopy(fromSessionId: string, toSessionId: string): Promise<void> {
  await invoke("log_copy", { fromSessionId, toSessionId });
}
