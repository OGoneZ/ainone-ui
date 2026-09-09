// 空闲回收判定单测：穷举 空闲/忙/阈值关闭/从未活动/临界/可见豁免 边界（AC-P8-5）。

import { describe, it, expect } from "vitest";
import { shouldRecycleSession, RECYCLE_THRESHOLD_MS, VISIBLE_THRESHOLD_MS } from "./recycle";

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

  // —— P38：可见 tab 回收阈值放宽到 30 分钟 ——

  it("可见 tab：超过 5 分钟但未到 30 分钟 → 不回收（用户可能在阅读回复）", () => {
    // 业务调用方传的 threshold 是 max(5min, 30min)=30min，这里锁纯函数语义：
    // visible=true 且 threshold 仍为 5min 时，函数自身也兜底放宽到 VISIBLE_THRESHOLD_MS
    expect(
      shouldRecycleSession(1_000, 1_000 + RECYCLE_THRESHOLD_MS + 1, THRESHOLD, false, true),
    ).toBe(false);
    expect(
      shouldRecycleSession(1_000, 1_000 + VISIBLE_THRESHOLD_MS - 1, THRESHOLD, false, true),
    ).toBe(false);
  });

  it("可见 tab：超过 30 分钟 → 回收", () => {
    expect(
      shouldRecycleSession(1_000, 1_000 + VISIBLE_THRESHOLD_MS, THRESHOLD, false, true),
    ).toBe(true);
  });

  it("可见 tab：忙时绝不回收（busy 优先级高于可见豁免）", () => {
    expect(
      shouldRecycleSession(1_000, 1_000 + VISIBLE_THRESHOLD_MS * 10, THRESHOLD, true, true),
    ).toBe(false);
  });

  it("可见 tab：调用方已传 30min 阈值时行为一致（Math.max 兜底不产生偏差）", () => {
    const t30 = Math.max(RECYCLE_THRESHOLD_MS, VISIBLE_THRESHOLD_MS);
    expect(shouldRecycleSession(1_000, 1_000 + t30, t30, false, true)).toBe(true);
    expect(shouldRecycleSession(1_000, 1_000 + t30 - 1, t30, false, true)).toBe(false);
  });

  it("后台 tab：不受可见阈值影响，照旧 5 分钟回收", () => {
    expect(
      shouldRecycleSession(1_000, 1_000 + RECYCLE_THRESHOLD_MS, RECYCLE_THRESHOLD_MS, false, false),
    ).toBe(true);
  });
});
