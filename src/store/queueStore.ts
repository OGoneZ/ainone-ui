// 命令队列 store（P9 · F-9-3）：按 tabKey 持久化待执行指令队列。
//
// 纯逻辑（enqueue/remove/reorder/next）在 queue.ts，本 store 只做状态编排 + 持久化。
// 跨重启不丢（persist 到 localStorage）。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { QueueItem } from "./queue";

interface QueueStore {
  /** tabKey → 待执行指令队列 */
  queues: Record<string, QueueItem[]>;
  /** 追加指令（容量满时返回 false，不静默丢弃） */
  enqueue: (key: string, item: QueueItem) => boolean;
  /** 按 id 删除 */
  remove: (key: string, id: string) => void;
  /** 编辑指令文本 */
  edit: (key: string, id: string, text: string) => void;
  /** 上移/下移（delta = -1 / +1） */
  move: (key: string, id: string, delta: number) => void;
  /** 拖拽重排：把 fromId 移到 toId 的位置（之后） */
  reorder: (key: string, fromId: string, toId: string) => void;
  /** 消费队首，返回被消费的指令（空队列返回 null） */
  dequeue: (key: string) => QueueItem | null;
  /** 清空某 tabKey 队列 */
  clear: (key: string) => void;
}

const CAPACITY = 10;

export const useQueueStore = create<QueueStore>()(
  persist(
    (set, get) => ({
      queues: {},

      enqueue: (key, item) => {
        const cur = get().queues[key] ?? [];
        if (cur.length >= CAPACITY) return false;
        set((s) => ({ queues: { ...s.queues, [key]: [...cur, item] } }));
        return true;
      },

      remove: (key, id) =>
        set((s) => ({
          queues: { ...s.queues, [key]: (s.queues[key] ?? []).filter((i) => i.id !== id) },
        })),

      edit: (key, id, text) =>
        set((s) => ({
          queues: {
            ...s.queues,
            [key]: (s.queues[key] ?? []).map((i) => (i.id === id ? { ...i, text } : i)),
          },
        })),

      move: (key, id, delta) =>
        set((s) => {
          const arr = [...(s.queues[key] ?? [])];
          const idx = arr.findIndex((i) => i.id === id);
          const to = idx + delta;
          if (idx < 0 || to < 0 || to >= arr.length) return {};
          const [moved] = arr.splice(idx, 1);
          arr.splice(to, 0, moved);
          return { queues: { ...s.queues, [key]: arr } };
        }),

      reorder: (key, fromId, toId) =>
        set((s) => {
          const arr = [...(s.queues[key] ?? [])];
          const from = arr.findIndex((i) => i.id === fromId);
          const to = arr.findIndex((i) => i.id === toId);
          if (from < 0 || to < 0 || from === to) return {};
          const [moved] = arr.splice(from, 1);
          arr.splice(to, 0, moved);
          return { queues: { ...s.queues, [key]: arr } };
        }),

      dequeue: (key) => {
        const cur = get().queues[key] ?? [];
        if (cur.length === 0) return null;
        const [head, ...rest] = cur;
        set((s) => ({ queues: { ...s.queues, [key]: rest } }));
        return head;
      },

      clear: (key) =>
        set((s) => {
          const queues = { ...s.queues };
          delete queues[key];
          return { queues };
        }),
    }),
    {
      name: "ainone-command-queue",
      // H4：tabKey（tab-N）是内存递增、重启归零复用——持久化的队列会在下一个
      // 应用生命周期挂到无关新会话上（首次 turn 结束自动发出）。持久化语义
      // 无法安全表达「跨重启归属」，因此每次启动从空队列开始：只保留会话内
      // 持久化（切 Tab 不丢），跨重启的队列本就该随会话断开而失效。
      skipHydration: true,
    },
  ),
);
