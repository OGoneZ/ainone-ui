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

/** F-21-3 拖拽几何：指针落在目标条目中心 50% 区（x ∈ [25%,75%]）= 合并意图，
 *  边缘带 = 排序插入意图。防误触：仅悬停计时不区分「想排序停在条目上」与「想合并」，
 *  中心带判定把排序意图还给边缘。坐标系 clientX 相对 rect。
 */
export function isInCenterBand(pointerX: number, rect: { left: number; width: number }): boolean {
  if (rect.width <= 0) return false;
  const rel = (pointerX - rect.left) / rect.width;
  // 浮点容差：中点 150 相对 [100,200] 是 0.25/0.75 的精确界，需 1e-9 级容差
  return rel >= 0.25 - 1e-9 && rel <= 0.75 + 1e-9;
}

/**
 * 合并（P16 · F-16-3，DEC-50）：拖拽条目 A 到条目 B 上 → 两文本按原队列顺序
 * 空行拼接，位置取两者较前者。找不到 id 时原样返回（不静默变形）。
 */
export function mergeItems(items: QueueItem[], dragId: string, overId: string): QueueItem[] {
  const from = items.findIndex((i) => i.id === dragId);
  const to = items.findIndex((i) => i.id === overId);
  if (from < 0 || to < 0 || from === to) return items;
  const [first, second] = from < to ? [items[from], items[to]] : [items[to], items[from]];
  const merged: QueueItem = {
    id: from < to ? dragId : overId, // 保留较前条目的 id（保持身份连续）
    text: `${first.text}\n\n${second.text}`,
  };
  const copy = items.filter((i) => i.id !== dragId && i.id !== overId);
  copy.splice(Math.min(from, to), 0, merged);
  return copy;
}
