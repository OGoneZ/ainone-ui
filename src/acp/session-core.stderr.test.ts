// P32 R4：stderr 批量转发防回归。
// 意图：harness 的 stderr 是诊断用途，不是热路径——逐块 console.warn 在
// installConsoleForward 下每块走一次 plugin-log IPC + 落盘，啰嗦 harness
// （debug 级输出）会变成 IPC 风暴。批量后 console 调用次数只与时间窗口数
// 相关，与 chunk 数解耦；且拼接文本与逐块顺序解码一致（多字节不断裂）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createStderrBatcher } from "./session-core";

const enc = new TextEncoder();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createStderrBatcher（P32 R4 stderr 批量转发）", () => {
  it("同窗口内 1000 个 chunk → 只回调一次，文本完整保序", () => {
    const calls: string[] = [];
    const push = createStderrBatcher((t) => calls.push(t), 500);

    for (let i = 0; i < 1000; i++) push(enc.encode(`line ${i}\n`));
    expect(calls.length).toBe(0); // 窗口未到不转发

    vi.advanceTimersByTime(500);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("line 0\n");
    expect(calls[0]).toContain("line 999\n");
    expect(calls[0].split("\n").filter(Boolean).length).toBe(1000); // 保序不丢
  });

  it("多窗口：每窗口一次回调，调用次数与窗口数挂钩而非 chunk 数", () => {
    const calls: string[] = [];
    const push = createStderrBatcher((t) => calls.push(t), 100);

    // 3 个窗口 × 各 50 chunk
    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 50; i++) push(enc.encode("x"));
      vi.advanceTimersByTime(100);
    }
    expect(calls.length).toBe(3);
    expect(calls.join("").length).toBe(150);
  });

  it("多字节跨 chunk 不断裂：UTF-8 字节流劈开推送，拼接与原文一致", () => {
    const calls: string[] = [];
    const push = createStderrBatcher((t) => calls.push(t), 500);

    const text = "错误信息包含中文与 emoji 🚀 混排";
    const bytes = enc.encode(text);
    // 按 3 字节一组推入——必然把多字节字符从中间劈开
    for (let i = 0; i < bytes.length; i += 3) {
      push(bytes.subarray(i, Math.min(i + 3, bytes.length)));
    }
    push(undefined); // EOF 清尾
    expect(calls.join("")).toBe(text);
  });

  it("EOF 清尾：窗口未满的残余也落日志（不丢最后半行）", () => {
    const calls: string[] = [];
    const push = createStderrBatcher((t) => calls.push(t), 500);

    push(enc.encode("最后半行没有换行符"));
    push(undefined); // EOF，窗口未到期
    expect(calls).toEqual(["最后半行没有换行符"]);
  });

  it("EOF 清尾后 decoder 状态归位：后续新会话 chunk 不残留替换符", () => {
    const calls: string[] = [];
    const push = createStderrBatcher((t) => calls.push(t), 500);

    // 前一段以劈开的多字节字符收尾 → EOF 清尾补齐；下一段正常
    push(enc.encode("第一段"));
    push(undefined);
    push(enc.encode("第二段"));
    vi.advanceTimersByTime(500);
    expect(calls.join("")).toBe("第一段第二段");
    expect(calls.join("")).not.toContain("�");
  });

  it("空窗口 flush 是 no-op（EOF 时无内容不产生空调用）", () => {
    const calls: string[] = [];
    const push = createStderrBatcher((t) => calls.push(t), 500);
    push(undefined);
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);
  });
});
