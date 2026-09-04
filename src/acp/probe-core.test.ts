// probe-core 单测：三态注入（正常握手 / 进程秒退 / 永不响应超时）。
// 测试的是「两级错误分级」语义——UI 文案依赖它区分「装没装」与「能不能握手」。

import { describe, it, expect } from "vitest";
import { probeInitialize } from "./probe-core";
import type { Streams } from "./session-core";

/** 构造一对内存 streams：stdout 回放指定 JSONL，stderr 忽略 */
function fakeStreams(lines: string[]): Streams {
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + "\n"));
      c.close();
    },
  });
  return {
    stdin: new WritableStream<Uint8Array>(),
    stdout,
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
  };
}

describe("probeInitialize", () => {
  it("正常握手：返回 agentInfo 与 protocolVersion", async () => {
    // SDK 的 JSON-RPC id 从 0 起（实测 stdin 首行 id:0），fake 响应须用同 id
    const result = await probeInitialize({
      streams: fakeStreams([
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "fake-agent", title: "Fake", version: "1.2.3" },
          },
        }),
      ]),
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentInfo.name).toBe("fake-agent");
      expect(result.agentInfo.version).toBe("1.2.3");
      expect(result.protocolVersion).toBe(1);
    }
  });

  it("进程秒退：level=spawn，错误带 stderr 尾迹", async () => {
    let closedResolve: (v: { code: number | null }) => void = () => {};
    const closed = new Promise<{ code: number | null }>((r) => (closedResolve = r));
    // closed 立即触发（模拟 spawn 后秒退）
    closedResolve({ code: 1 });
    const result = await probeInitialize({
      streams: fakeStreams([]),
      closed,
      stderrTail: () => "error: bun runtime must be >= 1.3.14",
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.level).toBe("spawn");
      expect(result.message).toContain("退出码 1");
      expect(result.message).toContain("bun runtime");
    }
  });

  it("永不响应：超时 → level=handshake", async () => {
    // stdout 永远沉默 → initialize 挂起直至超时
    const result = await probeInitialize({
      streams: {
        stdin: new WritableStream<Uint8Array>(),
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
      },
      timeoutMs: 150,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.level).toBe("handshake");
      expect(result.message).toContain("超时");
    }
  });
});
