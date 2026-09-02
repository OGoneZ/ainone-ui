// 工作区文件树前端封装（P9 · F-9-4）：调用 Rust workspace_list_dir。

import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export async function workspaceListDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("workspace_list_dir", { path });
}
