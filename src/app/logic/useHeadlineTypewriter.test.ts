// @vitest-environment jsdom
// useHeadlineTypewriter 测试：打完停住（不循环删除）、reduced-motion 显全文。
// 意图：宣传语是品牌文案，打字机只做首次入场效果——若回归成循环重打
// （像 chat 的 useTypewriter），首页标语会周期性消失，品牌观感受损。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHeadlineTypewriter } from "./useHeadlineTypewriter";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useHeadlineTypewriter", () => {
  it("逐字推进，打完整句后停住（多推进也不回退）", () => {
    const { result } = renderHook(() => useHeadlineTypewriter("ABC"));
    expect(result.current).toBe("");
    act(() => void vi.advanceTimersByTime(90));
    expect(result.current).toBe("A");
    act(() => void vi.advanceTimersByTime(90));
    expect(result.current).toBe("AB");
    act(() => void vi.advanceTimersByTime(90));
    expect(result.current).toBe("ABC");
    // 打完后定时器已清，久等不回退（循环重打即回归）
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toBe("ABC");
  });

  it("prefers-reduced-motion：跳过打字直接显全文", () => {
    const spy = vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q }) as MediaQueryList,
    );
    const { result } = renderHook(() => useHeadlineTypewriter("ABC"));
    expect(result.current).toBe("ABC");
    spy.mockRestore();
  });
});
