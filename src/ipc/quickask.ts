// 快问模型前端封装（P8 · F-8-7）：读写 Rust 的 quickask.json。
// apiKey 不回传明文（config_get 只给 has_api_key）；保存时留空 = 保留既有密钥。

import { invoke, Channel } from "@tauri-apps/api/core";

export interface QuickAskConfigView {
  base_url: string;
  model: string;
  timeout_ms: number;
  has_api_key: boolean;
  /** "openai" | "anthropic"（P22 双协议） */
  protocol: string;
  /** "" = 手动；"auto:claude-code" / "auto:codex" = 从 harness settings 自动探测（P22） */
  source: string;
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

/** 逐字请求快问（Rust 侧发起，密钥不落 WebView）。SSE 流式：
 *  增量文本经 channel 逐块推给 onDelta，整体完成后 resolve 完整文本或 reject。 */
export async function quickAsk(
  text: string,
  onDelta?: (delta: string) => void,
): Promise<string> {
  let buf = "";
  const channel = new Channel<{ event: "delta" | "done"; payload?: string }>();
  channel.onmessage = (msg) => {
    if (msg.event === "delta" && typeof msg.payload === "string") {
      buf += msg.payload;
      onDelta?.(msg.payload);
    }
  };
  const out = await invoke<string>("quick_ask", { text, onEvent: channel });
  // Rust 在流结束后 resolve 完整文本；channel 增量仅作 UI 流式渲染
  return out;
}
