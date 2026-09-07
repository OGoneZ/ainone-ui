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

/** 四态（P29 扩展）：ready=可用 / installable=可懒装 / cli_installable=CLI 可一键装 / absent=真未装 */
export type AdapterState = "ready" | "installable" | "cli_installable" | "absent";

/** 认证态（Rust AuthState，P29）：subscription=订阅登录 / api=API 配置 / none=未配置 */
export type AuthState = "subscription" | "api" | "none";

/** 认证态信息（P29） */
export interface AuthInfo {
  state: AuthState;
  /** 文案细节（如「已登录订阅」「API 已配置」；none 时为空串） */
  detail: string;
}

/** CLI 一键安装元信息（Rust CliInstallInfo，P29；CLI 已在或非登记程序为 null） */
export interface CliInstallInfo {
  /** 显示名（错误文案点名用） */
  display: string;
  /** 存在可用安装候选（bun/npm 缺失时 false → 按钮禁用） */
  installable: boolean;
}

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
  /** 四态判定（UI 门控的唯一依据） */
  state: AdapterState;
  /** 兼容字段：state === "ready" */
  available: boolean;
  /** 程序解析到的绝对路径（找不到为 null；托管桥命中时是入口 JS 路径） */
  resolvedPath: string | null;
  /** 命中来源（home/nvm/version_manager/platform_default/process_path/ManagedBridge） */
  source: string | null;
  bridge: BridgeInfo | null;
  /** P29：CLI 一键安装元信息（CLI 已在或非登记程序为 null） */
  cli: CliInstallInfo | null;
  /** P29：认证态 */
  auth: AuthInfo;
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
    cli: CliInstallInfo | null;
    auth: AuthInfo;
  }>("adapter_status", { program: a.program });
  return {
    ...a,
    state: status.state,
    available: status.available,
    resolvedPath: status.resolvedPath,
    source: status.source,
    bridge: status.bridge,
    cli: status.cli,
    auth: status.auth,
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

/**
 * CLI 本体一键安装（P29）：触发安装（幂等），安装器逐行输出经回调转发。
 * 与装桥解耦：失败不清理，重开应用按真实状态判定可断点续补。
 */
export async function installCli(
  program: string,
  onLine?: (line: string) => void,
): Promise<void> {
  const ch = new Channel<{ event: string; payload?: unknown }>();
  ch.onmessage = (msg) => {
    if (msg.event === "progress" && typeof msg.payload === "string") {
      onLine?.(msg.payload);
    }
  };
  await invoke("cli_install", { program, onEvent: ch });
}

/** 配置代写：读回显（P29） */
export interface HarnessConfigView {
  endpoint: string;
  hasApiKey: boolean;
  model: string;
  sourceFile: string;
  present: boolean;
}

/** 配置代写：保存输入（apiKey 留空 = 保留既有） */
export interface HarnessConfigInput {
  program: string;
  endpoint: string;
  apiKey: string;
  model: string;
}

export async function harnessConfigRead(adapterId: string): Promise<HarnessConfigView> {
  return invoke<HarnessConfigView>("harness_config_read", { adapterId });
}

/** resolve = 写入的文件绝对路径（UI 展示「已写入 …」） */
export async function harnessConfigSave(input: HarnessConfigInput): Promise<string> {
  return invoke<string>("harness_config_save", { input });
}

/** 覆盖保存全部适配器 */
export async function saveAdapters(adapters: Adapter[]): Promise<void> {
  await invoke("adapters_save", { adapters });
}

/** 默认工作目录（$SHELL 启动目录回退） */
export async function defaultCwd(): Promise<string> {
  return invoke<string>("default_cwd");
}
