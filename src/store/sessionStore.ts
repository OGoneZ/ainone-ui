// 全局会话运行时 store（zustand）—— plan-v2 F-4-8。
//
// 把原本锁在 ChatPanel 内的 messages/busy/pending 状态外提为按 tabKey 索引的
// 运行时记录，使「非活跃 Tab 的运行状态」也能被侧栏/状态指示读取（P6 铺垫），
// 同时让切换 Tab 不丢失消息（消息常驻 store，另有 JSONL 日志兜底持久化）。
//
// 消息模型（与 message-log.ts 一致，plan-v2 F-4-1）：
//   - user 消息 = 独立气泡（右对齐）
//   - assistant 消息 = 一个 turn，内部 blocks 顺序渲染（左对齐 + harness 头像）
//   - 流式增量通过 appendUser / updateLastAssistant 落到某个又简洁又正确的消息
//
// 两个独立字段：
//   - runtime: 按 tabKey 的会话运行时（不复用 sessionId，因并行 Tab 可复用同一会话）
//   - commands: 按 adapterId 的 slash 命令缓存（F-4-7），persist 到 localStorage

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChatMsg, BlockMsg } from "../acp/message-log";
import type { AskQuestion } from "../chat/logic/askCard";

export type { ChatMsg, BlockMsg };

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
  /** F-8-4 元数据：上下文占用（usage_update 采集），无则为 null */
  usage: { used: number; size: number; cost: number | null } | null;
  /** F-8-4 元数据：provider 路由（providers/list 采集），无则为 null */
  meta: { apiType?: string; baseUrl?: string } | null;
  /** F-9-1 计划：当前 turn 的 plan 条目（全量替换，turn 结束清除） */
  plan: { content: string; status: string; priority?: string }[] | null;
  /** F-12-2 结构化提问：当前等待回答的提问卡（null = 无） */
  ask: AskState | null;
}

/** F-12-2 提问卡状态 */
export interface AskState {
  questions: AskQuestion[];
  mode: string;
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
  /** 更新采集到的 usage（F-8-4） */
  setUsage: (key: string, usage: { used: number; size: number; cost: number | null }) => void;
  /** 更新采集到的 provider 路由（F-8-4） */
  setMeta: (key: string, meta: { apiType?: string; baseUrl?: string } | null) => void;
  /** 更新当前 turn 的 plan（F-9-1 全量替换） */
  setPlan: (key: string, plan: { content: string; status: string; priority?: string }[] | null) => void;
  /** 整体覆盖消息列表（用于 readLog 回填） */
  setMessages: (key: string, messages: ChatMsg[]) => void;
  /** 追加一条 user 消息（新气泡） */
  appendUser: (key: string, text: string) => void;
  /** 对最后一个 assistant turn 的 blocks 做函数式更新；无则在末尾新起一个 assistant */
  updateLastAssistant: (key: string, fn: (blocks: BlockMsg[]) => BlockMsg[]) => void;
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
                usage: null,
                meta: null,
                plan: null,
                ask: null,
              },
            },
          };
        }),

      setUsage: (key, usage) =>
        set((s) => {
          const cur = s.runtime[key];
          if (!cur) return {};
          return { runtime: { ...s.runtime, [key]: { ...cur, usage } } };
        }),

      setMeta: (key, meta) =>
        set((s) => {
          const cur = s.runtime[key];
          if (!cur) return {};
          return { runtime: { ...s.runtime, [key]: { ...cur, meta } } };
        }),

      setPlan: (key, plan) =>
        set((s) => {
          const cur = s.runtime[key];
          if (!cur) return {};
          return { runtime: { ...s.runtime, [key]: { ...cur, plan } } };
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

      setMessages: (key, messages) =>
        set((s) => {
          const cur = s.runtime[key];
          if (!cur) return {};
          return { runtime: { ...s.runtime, [key]: { ...cur, messages } } };
        }),

      appendUser: (key, text) =>
        set((s) => {
          const cur = s.runtime[key];
          if (!cur) return {};
          return {
            runtime: {
              ...s.runtime,
              [key]: { ...cur, messages: [...cur.messages, { role: "user", text }] },
            },
          };
        }),

      updateLastAssistant: (key, fn) =>
        set((s) => {
          const cur = s.runtime[key];
          if (!cur) return {};
          const msgs = cur.messages;
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant") {
            const next: ChatMsg[] = msgs.slice(0, -1);
            next.push({ role: "assistant", blocks: fn(last.blocks) });
            return { runtime: { ...s.runtime, [key]: { ...cur, messages: next } } };
          }
          // 无 assistant turn（如流式刚开始）→ 新起一个
          return {
            runtime: {
              ...s.runtime,
              [key]: { ...cur, messages: [...msgs, { role: "assistant", blocks: fn([]) }] },
            },
          };
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
