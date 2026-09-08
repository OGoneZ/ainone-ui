// P32 系统集成 IPC 封装：系统通知发送。
// 触发决策（shouldNotify）在 chat/logic/notify.ts——这里只管 invoke。

import { invoke } from "@tauri-apps/api/core";

/** 发一条系统通知（Rust 插件路径；失败静默——系统未授权时日志有 warn） */
export async function notifySend(title: string, body: string): Promise<void> {
  try {
    await invoke("notify_send", { title, body });
  } catch {
    // 通知失败绝不影响主流程（如 macOS 授权被拒），吞掉仅留痕
  }
}
