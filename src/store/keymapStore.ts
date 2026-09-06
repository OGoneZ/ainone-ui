// P25 键位 store：只持久化用户改绑的覆盖（overrides），默认键位表在 keymap.ts。
//
// 纯逻辑（match/detectConflict/parse）在 logic/keymap.ts，本 store 只做状态编排。
// 持久化走 zustand persist（参照 queueStore），name = ainone-keymap。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  DEFAULT_DEFS,
  parseOverrides,
  serializeOverrides,
  type Binding,
  type ShortcutDef,
  type ShortcutId,
} from "@/app/logic/keymap";

interface KeymapStore {
  /** 用户改绑（id → 绑定数组；未改绑的 id 不出现，走 DEFAULT_DEFS） */
  overrides: Partial<Record<ShortcutId, Binding[]>>;
  /** 改绑某动作（整体替换该 id 的绑定数组） */
  setBinding: (id: ShortcutId, bindings: Binding[]) => void;
  /** 恢复全部默认键位 */
  resetAll: () => void;
  /** 某动作当前生效的绑定（覆盖优先，回默认表） */
  bindingsOf: (id: ShortcutId) => Binding[];
  /** 默认定义表（帮助弹窗渲染用，透传） */
  defs: ShortcutDef[];
}

export const useKeymapStore = create<KeymapStore>()(
  persist(
    (set, get) => ({
      overrides: {},

      setBinding: (id, bindings) =>
        set((s) => ({ overrides: { ...s.overrides, [id]: bindings } })),

      resetAll: () => set({ overrides: {} }),

      bindingsOf: (id) => {
        const o = get().overrides[id];
        if (o) return o;
        return DEFAULT_DEFS.find((d) => d.id === id)?.defaults ?? [];
      },

      defs: DEFAULT_DEFS,
    }),
    {
      name: "ainone-keymap",
      // 只存 overrides；读入时容错解析（坏结构 → 空，回默认键位）
      partialize: (s) => ({ overrides: s.overrides }),
      merge: (persisted, current) => {
        const raw = (persisted as { overrides?: unknown } | undefined)?.overrides;
        const parsed =
          typeof raw === "string"
            ? parseOverrides(raw)
            : raw && typeof raw === "object"
              ? parseOverrides(serializeOverrides(raw as Partial<Record<ShortcutId, Binding[]>>))
              : null;
        return { ...current, overrides: parsed ?? {} };
      },
    },
  ),
);
