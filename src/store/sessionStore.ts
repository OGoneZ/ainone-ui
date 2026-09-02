// 全局会话运行时 store（zustand）—— plan-v2 F-4-8。
//
// 把原本锁在 ChatPanel 内的 messages/busy/pending 状态外提为按 tabKey 索引的
// 运行时记录，使「非活跃 Tab 的运行状态」也能被侧栏/状态指示读取（P6 铺垫），
// 同时让切换 Tab 不丢失消息（消息常驻 store，另有 JSONL 日志兜底持久化）。
//
// 两个独立字段：
//   - runtime: 按 tabKey 的会话运行时（不复用 sessionId，因并行 Tab 可复用同一会话）
//   - commands: 按 adapterId 的 slash 命令缓存（F-4-7），来自 ACP available_commands_update，
//     用 persist 持久化到 localStorage，供新会话空态时先用缓存

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChatMsg } from "../acp/message-log";

export interface CommandWord {
  name: string;
  description: string;
  hint?: string;
}

export interface RuntimeState {
  adapterId: string;
  sessionId: string | null;
  messages: ChatMsg[];
  busy: boolean;
  /** 当前等待用户批准的权限请求标题（null = 无） */
  pending: string | null;
  /** 是否已发出首条消息（用于写会话索引） */
  prompted: boolean;
}

interface SessionStore {
  runtime: Record<string, RuntimeState>;
  commands: Record<string, CommandWord[]>;

  /** 确保某 tabKey 存在运行时记录（幂等） */
  ensure: (key: string, adapterId: string) => void;
  /** 移除某 tabKey 的运行时记录 */
  drop: (key: string) => void;
  /** 绑定会话 id（session/new 或 load 后） */
  bindSession: (key: string, sessionId: string) => void;
  /** 函数式更新消息列表 */
  updateMessages: (key: string, fn: (m: ChatMsg[]) => ChatMsg[]) => void;
  /** 更新 busy/pending/prompted 等标量 */
  patch: (key: string, p: Partial<Omit<RuntimeState, "messages">>) => void;
  /** 覆盖某 adapter 的命令缓存（available_commands_update 到达时） */
  setCommands: (adapterId: string, words: CommandWord[]) => void;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set) => ({
      runtime: {},
      commands: {},

      ensure: (key, adapterId) =>
        set((s) => {
          if (s.runtime[key]) return {};
          return {
            runtime: {
              ...s.runtime,
              [key]: {
                adapterId,
                sessionId: null,
                messages: [],
                busy: false,
                pending: null,
                prompted: false,
              },
            },
          };
        }),

      drop: (key) =>
        set((s) => {
          if (!s.runtime[key]) return {};
          const runtime = { ...s.runtime };
          delete runtime[key];
          return { runtime };
        }),

      bindSession: (key, sessionId) =>
        set((s) => {
          const cur = s.runtime[key];
          if (!cur) return {};
          return { runtime: { ...s.runtime, [key]: { ...cur, sessionId } } };
        }),

      updateMessages: (key, fn) =>
        set((s) => {
          const cur = s.runtime[key];
          if (!cur) return {};
          return { runtime: { ...s.runtime, [key]: { ...cur, messages: fn(cur.messages) } } };
        }),

      patch: (key, p) =>
        set((s) => {
          const cur = s.runtime[key];
          if (!cur) return {};
          return { runtime: { ...s.runtime, [key]: { ...cur, ...p } } };
        }),

      setCommands: (adapterId, words) =>
        set((s) => ({ commands: { ...s.commands, [adapterId]: words } })),
    }),
    {
      name: "ainone-session-store",
      // 只持久化命令缓存；运行时（含消息）不入 localStorage（消息走 JSONL 日志）
      partialize: (s) => ({ commands: s.commands }),
    },
  ),
);
