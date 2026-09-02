// 语音转写前端封装（P9 · F-9-5）：调用 Rust asr_transcribe。
// 录音用 Web Audio API 在浏览器侧完成，字节数组交给 Rust 上传。

import { invoke } from "@tauri-apps/api/core";

/** 上传音频字节做转写，返回转写文本。 */
export async function asrTranscribe(data: Uint8Array, filename: string): Promise<string> {
  return invoke<string>("asr_transcribe", { data: Array.from(data), filename });
}
