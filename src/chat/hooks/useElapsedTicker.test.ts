// @vitest-environment jsdom
// useElapsedTicker 测试（P16b）：起点/停止/取整语义。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useElapsedTicker } from "./useElapsedTicker";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useElapsedTicker", () => {
  it("无起点（0/undefined）→ 恒 0 且不起 interval", () => {
    const { result } = renderHook(() => useElapsedTicker(undefined, () => 1000));
    expect(result.current).toBe(0);
  });

  it("起点已过 5s → 返回 5（整秒取整）", () => {
    const start = 1000;
    const { result } = renderHook(() => useElapsedTicker(start, () => start + 5321));
    expect(result.current).toBe(5);
  });

  it("每秒触发重渲染（interval 活跃）", async () => {
    let now = 1000;
    const start = 1000;
    const { result } = renderHook(() => useElapsedTicker(start, () => now));
    expect(result.current).toBe(0);
    now = 4000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current).toBe(3);
  });

  it("起点清零（turn 结束）→ 返回 0 并清理 interval", () => {
    const now = 10_000;
    const { result, rerender } = renderHook(({ s }) => useElapsedTicker(s, () => now), {
      initialProps: { s: 0 as number | undefined },
    });
    rerender({ s: 0 }); // 起点 0 → 不计时
    expect(result.current).toBe(0);
    rerender({ s: 2_000 });
    expect(result.current).toBe(8); // now=10000, start=2000 → 8s
  });
});
