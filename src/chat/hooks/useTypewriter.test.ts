// @vitest-environment jsdom
// useTypewriter 单测（P32 R3）：暂停语义是本测试的核心意图——
// 打字机是纯装饰性动效，绝不能在后台窗格 / 用户输入时继续烧渲染预算。
// enabled=false 必须真的停（无 interval 触发），enabled 恢复后继续。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTypewriter } from "./useTypewriter";

const FULL = "总结当前目录的结构";

beforeEach(() => {
  vi.useFakeTimers();
  // matchMedia 存在但不命中 reduced-motion（jsdom 默认无 matchMedia）
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useTypewriter", () => {
  it("enabled=true：80ms/字推进，打完循环回 0", () => {
    const { result } = renderHook(() => useTypewriter(FULL, true));
    expect(result.current).toBe("");
    act(() => vi.advanceTimersByTime(80 * 3));
    expect(result.current).toBe(FULL.slice(0, 3));
    // 再推一个完整周期（打完 + 回 0 + 重新打 1 字）→ 应为第 1 个字
    act(() => vi.advanceTimersByTime(80 * (FULL.length - 3 + 1 + 1)));
    expect(result.current).toBe(FULL.slice(0, 1));
  });

  it("P32 核心：enabled=false 时 interval 不启动——100 个 tick 后仍为空", () => {
    const { result } = renderHook(() => useTypewriter(FULL, false));
    act(() => vi.advanceTimersByTime(80 * 100));
    expect(result.current).toBe("");
  });

  it("P32 核心：enabled 翻转 true→false 冻结；false→true 重新开始打字（新窗格新展示）", () => {
    const { result, rerender } = renderHook(({ enabled }) => useTypewriter(FULL, enabled), {
      initialProps: { enabled: true },
    });
    act(() => vi.advanceTimersByTime(80 * 2));
    expect(result.current).toBe(FULL.slice(0, 2));

    // 暂停：冻结在当前进度（不清零、不继续）
    rerender({ enabled: false });
    act(() => vi.advanceTimersByTime(80 * 50));
    expect(result.current).toBe(FULL.slice(0, 2));

    // 恢复：重置进度重新打（切回窗格 = 新一轮建议展示，与 full 变化同一语义）
    rerender({ enabled: true });
    act(() => vi.advanceTimersByTime(80 * 1));
    expect(result.current).toBe(FULL.slice(0, 1));
  });

  it("full 文案变化时重置进度重新打（旧语义保留）", () => {
    const { result, rerender } = renderHook(({ full }) => useTypewriter(full, true), {
      initialProps: { full: "abc" },
    });
    act(() => vi.advanceTimersByTime(80 * 2));
    rerender({ full: "defg" });
    act(() => vi.advanceTimersByTime(80 * 1));
    expect(result.current).toBe("d");
  });
});
