// 命令队列纯逻辑（P9 · F-9-3）。零依赖，可单测。
//
// 语义：运行中/空闲时都可将指令排入待执行队列，而非立即打断。
// 容量上限默认 10；超出给明确反馈（不静默丢弃）。

export interface QueueItem {
  id: string;
  text: string;
}

export const QUEUE_CAPACITY = 10;

export type EnqueueResult = { ok: true; items: QueueItem[] } | { ok: false; items: QueueItem[]; reason: "full" };

/** 追加一条指令；容量满 → 返回 ok:false + reason:"full"（不丢弃既有队列） */
export function enqueue(items: QueueItem[], item: QueueItem, cap = QUEUE_CAPACITY): EnqueueResult {
  if (items.length >= cap) return { ok: false, items, reason: "full" };
  return { ok: true, items: [...items, item] };
}

/** 按 id 删除；找不到原样返回 */
export function removeItem(items: QueueItem[], id: string): QueueItem[] {
  return items.filter((i) => i.id !== id);
}

/** 重排：把 from 移到 to（出界安全返回原数组） */
export function reorder(items: QueueItem[], from: number, to: number): QueueItem[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const copy = items.slice();
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  return copy;
}

export type DequeueResult = { item: QueueItem; items: QueueItem[] } | null;

/** 消费队首：空队列返回 null */
export function next(items: QueueItem[]): DequeueResult {
  if (items.length === 0) return null;
  return { item: items[0], items: items.slice(1) };
}
