// 命令队列纯函数单测：容量边界 / 空队列 / 重排出界 / 消费取序（AC-P9-13）/
// 拖拽合并（P16 F-16-3，AC-P16-8）。

import { describe, it, expect } from "vitest";
import { enqueue, removeItem, reorder, next, mergeItems, QUEUE_CAPACITY, type QueueItem } from "./queue";

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

describe("mergeItems（P16 F-16-3 拖拽合并，DEC-50）", () => {
  it("向下拖：A 合入 B → 文本按原顺序拼接，位置取较前者，保留 A 的 id", () => {
    const items = [item("a", "任务一"), item("b", "任务二"), item("c", "任务三")];
    const r = mergeItems(items, "a", "b");
    expect(r.map((i) => i.id)).toEqual(["a", "c"]);
    expect(r[0].text).toBe("任务一\n\n任务二");
  });

  it("向上拖：B 拖到 A 上 → 文本仍是 A 在前，位置取 A，保留 A 的 id", () => {
    const items = [item("a", "任务一"), item("b", "任务二"), item("c", "任务三")];
    const r = mergeItems(items, "b", "a");
    expect(r.map((i) => i.id)).toEqual(["a", "c"]);
    expect(r[0].text).toBe("任务一\n\n任务二");
  });

  it("跨位合并：C 拖到 A 上 → 位置取 A（队首）", () => {
    const items = [item("a", "甲"), item("b", "乙"), item("c", "丙")];
    const r = mergeItems(items, "c", "a");
    expect(r.map((i) => i.id)).toEqual(["a", "b"]);
    expect(r[0].text).toBe("甲\n\n丙");
  });

  it("自己合到自己 / id 不存在 → 原样返回", () => {
    const items = [item("a"), item("b")];
    expect(mergeItems(items, "a", "a")).toEqual(items);
    expect(mergeItems(items, "zzz", "a")).toEqual(items);
    expect(mergeItems(items, "a", "zzz")).toEqual(items);
  });

  it("合并后长度减一（两条变一条，作为一次消息发送）", () => {
    const items = [item("a", "甲"), item("b", "乙")];
    expect(mergeItems(items, "a", "b")).toHaveLength(1);
  });
});
