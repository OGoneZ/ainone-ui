// 工作区前端封装：读写 Rust 的 workspaces.json。

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface Workspace {
  id: string;
  name: string;
  cwd: string;
  created_ms: number;
}

export async function workspacesList(): Promise<Workspace[]> {
  return invoke<Workspace[]>("workspaces_list");
}

export async function workspacesUpsert(w: Workspace): Promise<string> {
  return invoke<string>("workspaces_upsert", { workspace: w });
}

export async function workspacesRemove(id: string): Promise<void> {
  await invoke("workspaces_remove", { id });
}

/** 打开本地目录选择对话框（F-5-3），返回所选目录或 null */
export async function pickDirectory(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}
