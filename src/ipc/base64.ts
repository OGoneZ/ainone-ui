// P32 R8：base64 解码共享工具。
// Tauri v2 事件通道（Channel）无二进制支持，Rust 侧把 stdout/stderr/PTY 数据
// base64 编码为字符串再推送（体积 ~1.33x，number[] 为 ~4x）。bridge.ts 与
// pty.ts 共用本解码器；atob 原生还原，O(n) 写入 TypedArray。

/** 标准 base64（带 padding，对齐 Rust base64::engine::general_purpose::STANDARD）→ 字节 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
