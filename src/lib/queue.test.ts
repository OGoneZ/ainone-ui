// 命令队列纯函数单测：容量边界 / 空队列 / 重排出界 / 消费取序（AC-P9-13）。

import { describe, it, expect } from "vitest";
import { enqueue, removeItem, reorder, next, QUEUE_CAPACITY, type QueueItem } from "./queue";

const item = (id: string, text = id): QueueItem => ({ id, text });

describe("enqueue", () => {
  it("正常追加到队尾", () => {
    const r = enqueue([item("a")], item("b"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("容量满 → 返回 full，不丢弃既有队列", () => {
    const full = Array.from({ length: QUEUE_CAPACITY }, (_, i) => item(`i${i}`));
    const r = enqueue(full, item("overflow"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("full");
      expect(r.items).toHaveLength(QUEUE_CAPACITY);
    }
  });

  it("恰在容量边界 → 允许入队", () => {
    const near = Array.from({ length: QUEUE_CAPACITY - 1 }, (_, i) => item(`i${i}`));
    const r = enqueue(near, item("last"));
    expect(r.ok).toBe(true);
  });
});

describe("removeItem", () => {
  it("按 id 删除；找不到原样返回", () => {
    const items = [item("a"), item("b")];
    expect(removeItem(items, "a").map((i) => i.id)).toEqual(["b"]);
    expect(removeItem(items, "zzz")).toHaveLength(2);
  });
});

describe("reorder", () => {
  it("把 from 移到 to", () => {
    const items = [item("a"), item("b"), item("c")];
    expect(reorder(items, 0, 2).map((i) => i.id)).toEqual(["b", "c", "a"]);
    expect(reorder(items, 2, 0).map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("出界 → 原数组返回（内容不变）", () => {
    const items = [item("a"), item("b")];
    expect(reorder(items, -1, 0).map((i) => i.id)).toEqual(["a", "b"]);
    expect(reorder(items, 0, 5).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("next", () => {
  it("空队列 → null", () => {
    expect(next([])).toBeNull();
  });

  it("消费队首（FIFO 取序）", () => {
    const r = next([item("a"), item("b")]);
    expect(r?.item.id).toBe("a");
    expect(r?.items.map((i) => i.id)).toEqual(["b"]);
  });
});
