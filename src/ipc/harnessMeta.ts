// P29：harness 本机配置元数据 IPC 封装（Rust harness_meta.rs 的前端镜像）。
//
// 密钥纪律：Rust 只回传 api_key_present 布尔，明文 key 永不进 WebView。

import { invoke } from "@tauri-apps/api/core";

export interface HarnessMeta {
  base_url: string | null;
  model: string | null;
  /** 配置里存在 API key（明文不回传） */
  api_key_present: boolean;
}

export interface WriteOutcome {
  path: string;
  backup: string;
}

export type HarnessWriteTarget = "claude-code" | "codex" | "omp" | "opencode";

/** 读静态配置元数据；文件缺失 → null（UI 降级） */
export async function fetchHarnessMeta(adapterId: string): Promise<HarnessMeta | null> {
  return invoke<HarnessMeta | null>("harness_meta", { adapterId });
}

/** 定点写回 model / baseUrl（写前自动备份 .ainone-bak） */
export async function writeHarnessSettings(
  adapterId: string,
  patch: { model?: string; baseUrl?: string },
): Promise<WriteOutcome> {
  return invoke<WriteOutcome>("harness_settings_write", {
    adapterId,
    model: patch.model ?? null,
    baseUrl: patch.baseUrl ?? null,
  });
}

/** P29 R5：探测网关支持的模型列表（GET {base}/v1/models；key Rust 侧自取不进 WebView）。
 *  apiKey 可选：设置页表单显式直传（非空优先），空/缺省回落 Rust 本机配置自取。
 *  失败抛结构化错误 { kind, message }。 */
export async function probeModels(
  adapterId: string,
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  return invoke<string[]>("models_probe", { adapterId, baseUrl, apiKey: apiKey ?? null });
}

/** 该 harness 是否支持配置写回（决定元数据面板模型/URL 行是否可点编辑）。
 *  P32b：opencode 加入（Rust 侧 JSON 定点改写 provider.ainone 结构）。
 *  pi 仍不做定点替换（真实无验证过的写回语义，配置代写链路负责）。 */
export function supportsWrite(adapterId: string): boolean {
  return ["claude-code", "codex", "omp", "opencode"].includes(adapterId);
}
