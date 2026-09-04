// 空闲回收判定单测：穷举 空闲/忙/阈值关闭/从未活动/临界 边界（AC-P8-5）。

import { describe, it, expect } from "vitest";
import { shouldRecycleSession } from "./recycle";

const THRESHOLD = 5 * 60 * 1000; // 5 分钟

describe("shouldRecycleSession", () => {
  it("空闲超阈值 → 回收", () => {
    expect(shouldRecycleSession(1_000, 1_000 + THRESHOLD, THRESHOLD, false)).toBe(true);
    expect(shouldRecycleSession(1_000, 1_000 + THRESHOLD + 999, THRESHOLD, false)).toBe(true);
  });

  it("空闲未到阈值 → 不回收", () => {
    expect(shouldRecycleSession(1_000, 1_000 + THRESHOLD - 1, THRESHOLD, false)).toBe(false);
    expect(shouldRecycleSession(1_000, 1_000 + 1, THRESHOLD, false)).toBe(false);
  });

  it("临界恰等于阈值 → 回收", () => {
    expect(shouldRecycleSession(1_000, 1_000 + THRESHOLD, THRESHOLD, false)).toBe(true);
  });

  it("有运行中 turn（忙）→ 绝不回收，即使远超阈值", () => {
    expect(shouldRecycleSession(1_000, 1_000 + THRESHOLD * 10, THRESHOLD, true)).toBe(false);
  });

  it("阈值关闭（≤0）→ 永不回收", () => {
    expect(shouldRecycleSession(1_000, 1_000 + THRESHOLD * 10, 0, false)).toBe(false);
    expect(shouldRecycleSession(1_000, 1_000 + THRESHOLD * 10, -1, false)).toBe(false);
  });

  it("从未活动（lastActivityMs ≤ 0）→ 不回收", () => {
    expect(shouldRecycleSession(0, THRESHOLD * 10, THRESHOLD, false)).toBe(false);
    expect(shouldRecycleSession(-5, THRESHOLD * 10, THRESHOLD, false)).toBe(false);
  });
});
