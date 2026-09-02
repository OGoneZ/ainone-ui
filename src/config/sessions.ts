// 会话索引前端封装：读写 Rust 的 sessions.json（记录可恢复的会话）。

import { invoke } from "@tauri-apps/api/core";

export interface SessionEntry {
  session_id: string;
  adapter_id: string;
  title: string;
  cwd: string;
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
