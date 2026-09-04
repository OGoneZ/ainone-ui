// 适配器前端封装：从 Rust 读写适配器注册表，并做可用性检测。

import { invoke } from "@tauri-apps/api/core";

export interface Adapter {
  id: string;
  name: string;
  program: string;
  args: string[];
  cwd: string;
  /** 头像品牌色（hex），缺失用首字母灰色占位（F-4-1） */
  logo: string | null;
}

export interface AdapterWithStatus extends Adapter {
  available: boolean;
  /** 程序解析到的绝对路径（找不到为 null） */
  resolvedPath: string | null;
  /** 命中来源（home/nvm/version_manager/platform_default/process_path） */
  source: string | null;
}

/** 列出全部适配器（含每个 program 是否在增强 PATH 中） */
export async function listAdapters(): Promise<AdapterWithStatus[]> {
  const adapters = await invoke<Adapter[]>("adapters_list");
  return Promise.all(adapters.map(refreshAdapterStatus));
}

/** 对单条适配器重跑可用性检测（编辑 program 后刷新用） */
export async function refreshAdapterStatus(a: Adapter): Promise<AdapterWithStatus> {
  const status = await invoke<{ available: boolean; resolved_path: string | null; source: string | null }>(
    "adapter_status",
    { program: a.program },
  );
  return { ...a, available: status.available, resolvedPath: status.resolved_path, source: status.source };
}

/** 覆盖保存全部适配器 */
export async function saveAdapters(adapters: Adapter[]): Promise<void> {
  await invoke("adapters_save", { adapters });
}

/** 默认工作目录（$SHELL 启动目录回退） */
export async function defaultCwd(): Promise<string> {
  return invoke<string>("default_cwd");
}
