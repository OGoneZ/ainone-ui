// 快问模型前端封装（P8 · F-8-7）：读写 Rust 的 quickask.json。
// apiKey 不回传明文（config_get 只给 has_api_key）；保存时留空 = 保留既有密钥。

import { invoke, Channel } from "@tauri-apps/api/core";

/** 内置默认解释提示词（P35 R2 修订）：设置页「解释提示词」框无自定义值时
 *  预填此全文，用户可逐字编辑或整段重写。运行时事实源是 Rust
 *  quickask::QUICK_ASK_SYSTEM_PROMPT——两侧文本需保持同步，改动须同改。 */
export const QUICK_ASK_DEFAULT_PROMPT =
  "你是一个简洁的解释助手。用户会选中一段术语、代码、报错或句子。请用与选中内容相同的语言，简短清晰地解释：先用一句话给出定义或结论，再用 markdown 列表给出 2-4 个要点，必要时给一个简短示例。使用 markdown 格式。不要开场白，不要复述问题。";

export interface QuickAskConfigView {
  base_url: string;
  model: string;
  timeout_ms: number;
  has_api_key: boolean;
  /** "openai" | "anthropic"（P22 双协议） */
  protocol: string;
  /** "" = 手动；"auto:claude-code" / "auto:codex" = 从 harness settings 自动探测（P22） */
  source: string;
  /** P35 R2：自定义解释提示词（"" = 用内置默认） */
  system_prompt: string;
}

export interface QuickAskConfigInput {
  base_url: string;
  model: string;
  timeout_ms: number;
  api_key: string;
  /** P35 R2：空 = 恢复内置默认提示词 */
  system_prompt: string;
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
