// 适配器前端封装：从 Rust 读写适配器注册表，并做可用性检测。

import { invoke, Channel } from "@tauri-apps/api/core";

export interface Adapter {
  id: string;
  name: string;
  program: string;
  args: string[];
  cwd: string;
  /** 头像品牌色（hex），缺失用首字母灰色占位（F-4-1） */
  logo: string | null;
}

/** 三态（Rust AdapterState）：ready=可用 / installable=可懒装 / absent=真未装 */
export type AdapterState = "ready" | "installable" | "absent";

/** 懒装桥元信息（Rust BridgeInfo，camelCase 序列化；非桥程序为 null） */
export interface BridgeInfo {
  pkg: string;
  version: string;
  /** harness 本体 CLI 程序名（absent 文案点名「先装 X」用） */
  cliProgram: string;
  /** harness 本体 CLI 是否在增强 PATH */
  cliAvailable: boolean;
  /** bun/npm 安装运行时是否在 */
  runtimeAvailable: boolean;
}

export interface AdapterWithStatus extends Adapter {
  /** 三态判定（UI 门控的唯一依据） */
  state: AdapterState;
  /** 兼容字段：state === "ready" */
  available: boolean;
  /** 程序解析到的绝对路径（找不到为 null；托管桥命中时是入口 JS 路径） */
  resolvedPath: string | null;
  /** 命中来源（home/nvm/version_manager/platform_default/process_path/ManagedBridge） */
  source: string | null;
  bridge: BridgeInfo | null;
}

/** 列出全部适配器（含每个 program 的三态判定） */
export async function listAdapters(): Promise<AdapterWithStatus[]> {
  const adapters = await invoke<Adapter[]>("adapters_list");
  return Promise.all(adapters.map(refreshAdapterStatus));
}

/** 对单条适配器重跑可用性检测（编辑 program 后刷新用） */
export async function refreshAdapterStatus(a: Adapter): Promise<AdapterWithStatus> {
  const status = await invoke<{
    available: boolean;
    state: AdapterState;
    resolvedPath: string | null;
    source: string | null;
    bridge: BridgeInfo | null;
  }>("adapter_status", { program: a.program });
  return {
    ...a,
    state: status.state,
    available: status.available,
    resolvedPath: status.resolvedPath,
    source: status.source,
    bridge: status.bridge,
  };
}

/**
 * 懒装桥：触发安装（幂等），安装器逐行输出经回调转发（P28 进度流）。
 * resolve = 安装成功；reject = 失败（错误串可直接展示）。
 */
export async function installBridge(
  program: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const ch = new Channel<{ event: string; payload?: unknown }>();
  ch.onmessage = (msg) => {
    if (msg.event === "progress" && typeof msg.payload === "string") {
      onLine?.(msg.payload);
    }
  };
  await invoke("bridge_install", { program, onEvent: ch });
}

/** 覆盖保存全部适配器 */
export async function saveAdapters(adapters: Adapter[]): Promise<void> {
  await invoke("adapters_save", { adapters });
}

/** 默认工作目录（$SHELL 启动目录回退） */
export async function defaultCwd(): Promise<string> {
  return invoke<string>("default_cwd");
}
