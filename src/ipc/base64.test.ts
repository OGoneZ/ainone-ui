// P32 R8：IPC base64 编解码防回归（TS 侧）。
// 意图：Tauri v2 Channel 无二进制支持，旧实现 Vec<u8> → JSON number[]（每字节
// 序列化 ~4 字符，前端 Uint8Array.from 逐个构造）。base64 后 ~1.33 字符/字节。
// 本测试锁定：解码函数与 Rust b64()（STANDARD padding）往返一致 + 多字节语义。

import { describe, it, expect } from "vitest";
import { base64ToBytes } from "./base64";

describe("base64ToBytes（P32 R8）", () => {
  it("标准 base64（带 padding）往返一致——与 Rust base64::engine::STANDARD 对齐", () => {
    expect(Array.from(base64ToBytes("AQI="))).toEqual([1, 2]);
    expect(Array.from(base64ToBytes("aGVsbG8="))).toEqual(
      Array.from(new TextEncoder().encode("hello")),
    );
  });

  it("空串 → 空字节数组（Rust b64(&[]) = \"\"）", () => {
    expect(base64ToBytes("").length).toBe(0);
  });

  it("4KB PTY chunk 边界：1024 字节全值域往返", () => {
    // 4KB chunk 是 terminal.rs 读线程的 buffer 粒度
    const src = new Uint8Array(4096);
    for (let i = 0; i < src.length; i++) src[i] = i % 256;
    // 用浏览器一致的 btoa 构造 base64（测试环境无 Rust，等价 STANDARD）
    const b64 = bytesToBase64(src);
    const out = base64ToBytes(b64);
    expect(out.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) expect(out[i]).toBe(src[i]);
  });

  it("多字节 UTF-8 文本经编码往返后 TextDecoder 还原一致（pty.ts 语义）", () => {
    const text = "终端输出包含中文与 emoji 🚀 混排";
    const bytes = new TextEncoder().encode(text);
    const out = new TextDecoder().decode(base64ToBytes(bytesToBase64(bytes)));
    expect(out).toBe(text);
  });
});

/** 测试用 btoa 封装（与生产 atob 对偶；jsdom 原生支持） */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
