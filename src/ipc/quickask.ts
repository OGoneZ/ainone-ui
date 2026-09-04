// 快问模型前端封装（P8 · F-8-7）：读写 Rust 的 quickask.json。
// apiKey 不回传明文（config_get 只给 has_api_key）；保存时留空 = 保留既有密钥。

import { invoke } from "@tauri-apps/api/core";

export interface QuickAskConfigView {
  base_url: string;
  model: string;
  timeout_ms: number;
  has_api_key: boolean;
}

export interface QuickAskConfigInput {
  base_url: string;
  model: string;
  timeout_ms: number;
  api_key: string;
}

export async function quickAskConfigGet(): Promise<QuickAskConfigView> {
  return invoke<QuickAskConfigView>("quickask_config_get");
}

export async function quickAskConfigSave(input: QuickAskConfigInput): Promise<void> {
  await invoke("quickask_config_save", { input });
}

/** 逐字请求快问（Rust 侧发起，密钥不落 WebView）。返回解释文本或抛错。 */
export async function quickAsk(text: string): Promise<string> {
  return invoke<string>("quick_ask", { text });
}
