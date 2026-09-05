// git 元数据前端封装（P15 · F-15-6）：调用 Rust git_current_branch。

import { invoke } from "@tauri-apps/api/core";

/** 读 cwd 的当前 git 分支名；非 git 仓库 / git 不可用 → null（调用方显示「—」） */
export async function gitCurrentBranch(cwd: string): Promise<string | null> {
  try {
    return await invoke<string | null>("git_current_branch", { cwd });
  } catch {
    return null;
  }
}
