// 终端会话运行时状态（P23）：按 tabKey 索引的轻量 store。
//
// 为什么独立于 sessionStore：RuntimeState 深度耦合 ChatMsg 消息模型
// （messages/busy/perm/plan），终端没有这些概念，只有「是否退出」一个状态。
// 无 persist——终端生命周期与 Tab 一致，重启即空（与布局不持久化对齐）。

import { create } from "zustand";

export interface TerminalRuntime {
  /** shell 已退出（xterm 顶部显示状态条 + 重新打开按钮） */
  exited: boolean;
  exitCode: number | null;
}

interface TerminalStore {
  runtime: Record<string, TerminalRuntime>;
  ensure: (key: string) => void;
  markExited: (key: string, code: number | null) => void;
  revive: (key: string) => void;
  drop: (key: string) => void;
}

export const useTerminalStore = create<TerminalStore>()((set) => ({
  runtime: {},

  ensure: (key) =>
    set((s) => {
      if (s.runtime[key]) return {};
      return { runtime: { ...s.runtime, [key]: { exited: false, exitCode: null } } };
    }),

  markExited: (key, code) =>
    set((s) => {
      const cur = s.runtime[key];
      if (!cur) return {};
      return { runtime: { ...s.runtime, [key]: { ...cur, exited: true, exitCode: code } } };
    }),

  revive: (key) =>
    set((s) => {
      const cur = s.runtime[key];
      if (!cur || !cur.exited) return {};
      return { runtime: { ...s.runtime, [key]: { ...cur, exited: false, exitCode: null } } };
    }),

  drop: (key) =>
    set((s) => {
      if (!s.runtime[key]) return {};
      const runtime = { ...s.runtime };
      delete runtime[key];
      return { runtime };
    }),
}));
