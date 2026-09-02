// truncateToMessageIndex 单测：N=0 / 中间 / 越界 / 负数（AC-P8-27）。

import { describe, it, expect } from "vitest";
import { truncateToMessageIndex, indexOfUserMessage } from "./rewind";
import type { ChatMsg } from "./message-log";

function msgs(n: number): ChatMsg[] {
  const arr: ChatMsg[] = [];
  for (let i = 0; i < n; i++) arr.push({ role: "user", text: `u${i}` });
  return arr;
}

describe("truncateToMessageIndex", () => {
  it("N=0 → 空数组", () => {
    expect(truncateToMessageIndex(msgs(3), 0)).toEqual([]);
  });

  it("中间 index → 截断到 index 之前", () => {
    const r = truncateToMessageIndex(msgs(5), 2);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ role: "user", text: "u0" });
  });

  it("越界（index >= length）→ 全部保留", () => {
    expect(truncateToMessageIndex(msgs(3), 5)).toHaveLength(3);
    expect(truncateToMessageIndex(msgs(3), 3)).toHaveLength(3);
  });

  it("负数 → 空数组", () => {
    expect(truncateToMessageIndex(msgs(3), -1)).toEqual([]);
  });
});

describe("indexOfUserMessage", () => {
  const arr: ChatMsg[] = [
    { role: "user", text: "a" },
    { role: "assistant", blocks: [] },
    { role: "user", text: "b" },
    { role: "assistant", blocks: [] },
  ];

  it("命中第 N 条用户消息的实际下标", () => {
    expect(indexOfUserMessage(arr, 0)).toBe(0);
    expect(indexOfUserMessage(arr, 1)).toBe(2);
  });

  it("越界 → -1", () => {
    expect(indexOfUserMessage(arr, 2)).toBe(-1);
  });
});
