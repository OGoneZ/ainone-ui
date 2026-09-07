// P10 分屏编排纯逻辑（F-10-3）。零依赖，可单测。
//
// 快捷键分屏语义（DEC-23，p20n 调整）：Ctrl+Shift+D 左右切分、Ctrl+Shift+E 上下切分、
// Ctrl+D 关闭当前窗格的当前 tab（原 Ctrl+D 分屏与系统/输入法冲突且不灵敏）；
// 新窗格 = 同 harness + 同 cwd 的新会话（WARP 终端语义）。
// 只有「编辑器区获得焦点（非输入框）」时响应，避免拦截对话输入。
//
// Model 投影：flexlayout Model 是布局 + tab 集合的单一真源，本文件把 Model
// 的 tab 节点（用鸭子类型，不直接依赖 flexlayout runtime，纯函数可 node 单测）
// 投影回业务 Tab 数组与 activeKey。

import type { Tab } from "./tabs";
import { DEFAULT_DEFS, type Binding, type ShortcutId } from "./keymap";

export type SplitAxis = "row" | "col";

/** P25：从键位表取某 id 的绑定（自定义覆盖 → 默认），取不到给空表（永不匹配） */
export function bindingsOf(
  id: ShortcutId,
  overrides?: Partial<Record<ShortcutId, Binding[]>>,
): Binding[] {
  const def = DEFAULT_DEFS.find((d) => d.id === id);
  if (!def) return [];
  return overrides?.[id] ?? def.defaults;
}

/** P25：把 App 传入的键位覆盖投影为 layout 判定所需的快捷键定义子集 */
export interface LayoutBindings {
  splitRow?: Binding[];
  splitCol?: Binding[];
  close?: Binding[];
  focusArrows?: Binding[];
}

/** P25：从 defs+overrides 取 layout 判定所需绑定（缺省 = 默认表，现有测试零改动） */
export function layoutBindings(overrides?: Partial<Record<ShortcutId, Binding[]>>): LayoutBindings {
  const pick = (id: ShortcutId): Binding[] | undefined =>
    overrides && overrides[id] ? (bindingsOf(id, overrides) as Binding[]) : undefined;
  return {
    splitRow: pick("pane.split-row"),
    splitCol: pick("pane.split-col"),
    close: pick("pane.close-tab"),
    focusArrows: pick("pane.focus-n"),
  };
}

/** 旧式按键形参（现测试与现调用方）与 P25 绑定形参的二选一 */
type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey?: boolean; altKey?: boolean };

/** P25：按绑定表匹配（code 优先；旧事件可能没有 code，回退 key → code 推断） */
function matchesAny(e: KeyLike, bindings: Binding[] | undefined, fallback: (e: KeyLike) => boolean): boolean {
  if (!bindings || bindings.length === 0) return fallback(e);
  const code = inferredCode(e);
  if (!code) return fallback(e);
  return bindings.some((b) => b.code === code);
}

/** e.key → e.code 推断（字母/方向键/命名键，仅覆盖现有判定涉及的键） */
function inferredCode(e: KeyLike): string | null {
  const k = (e.key ?? "").toLowerCase();
  if (/^[a-z]$/.test(k)) return `Key${k.toUpperCase()}`;
  const named: Record<string, string> = {
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    escape: "Escape",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
    enter: "Enter",
    " ": "Space",
  };
  return named[k] ?? null;
}

/** 焦点是否落在可编辑控件内（textarea/input/contenteditable 时不拦截快捷键） */
export function inEditable(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (tag === "textarea" || tag === "input") return true;
  return (el as HTMLElement).isContentEditable === true;
}

/** 解析键盘事件是否为分屏快捷键；不是则返回 null。
 *  p20n：Ctrl/Cmd+Shift+D 左右、Ctrl/Cmd+Shift+E 上下（裸 Ctrl+D 让位给「关闭」）。
 *  P25：可传入键位绑定（layoutBindings 投影），缺省沿用默认表——现有测试零改动。 */
export function splitShortcut(e: KeyLike, bindings?: LayoutBindings): SplitAxis | null {
  if (!e.shiftKey) return null;
  if (!e.ctrlKey && !e.metaKey) return null;
  if (matchesAny(e, bindings?.splitRow, (ev) => (ev.key ?? "").toLowerCase() === "d")) return "row";
  if (matchesAny(e, bindings?.splitCol, (ev) => (ev.key ?? "").toLowerCase() === "e")) return "col";
  return null;
}

/** 解析键盘事件是否为「关闭当前窗格的当前 tab」快捷键（p20n：Ctrl/Cmd+D）。
 *  P25：可传入键位绑定，缺省沿用默认表。 */
export function closeTabShortcut(e: KeyLike, bindings?: LayoutBindings): boolean {
  if (e.shiftKey) return false;
  if (!e.ctrlKey && !e.metaKey) return false;
  return matchesAny(e, bindings?.close, (ev) => (ev.key ?? "").toLowerCase() === "d");
}

/** 焦点方向（Ctrl+方向键在分屏窗格间移动） */
export type FocusDir = "up" | "down" | "left" | "right";

/** 解析键盘事件是否为窗格焦点切换快捷键；不是则返回 null。
 *  macOS 用 Cmd（平台惯例，VS Code 同款），其他平台 Ctrl。
 *  P25：可传入键位绑定（focus-n 的绑定代表「方向键+主修饰」族），缺省沿用默认表。
 *  绑定表路径下以「主修饰（ctrl/meta）+ 方向 code」匹配；alt 仍排除。 */
export function focusArrowShortcut(e: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}, bindings?: LayoutBindings): FocusDir | null {
  const k = (e.key ?? "").toLowerCase();
  if (k !== "arrowup" && k !== "arrowdown" && k !== "arrowleft" && k !== "arrowright") return null;
  if (e.altKey) return null;
  // macOS（UA 判定）：Cmd+方向键；其余平台（含 node 测试环境）Ctrl+方向键。
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Macintosh");
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const custom = bindings?.focusArrows;
  if (custom && custom.length > 0) {
    // P25 绑定表路径：主修饰以绑定为准（ctrl|meta 等价），方向按 code 对应
    const code = inferredCode(e);
    const wantMod = Boolean(custom[0].ctrl) || Boolean(custom[0].meta);
    if (!code || (Boolean(e.ctrlKey) || Boolean(e.metaKey)) !== wantMod) return null;
    const map: Record<string, FocusDir> = {
      ArrowUp: "up",
      ArrowDown: "down",
      ArrowLeft: "left",
      ArrowRight: "right",
    };
    return map[code] ?? null;
  }
  if (!mod) return null;
  return k === "arrowup" ? "up" : k === "arrowdown" ? "down" : k === "arrowleft" ? "left" : "right";
}

/** tabset 的屏幕几何（鸭子类型，真实 TabSetNode 有 getRect()） */
export interface TabsetRectLike {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 焦点移动的几何判定（WARP/VS Code 语义）：沿方向找「与当前窗格中心同轴上
 * 重叠最大」的邻窗格。投影重叠（垂直于移动方向的轴）要求 >0，主轴距离取正。
 * 无候选（边缘方向）→ null，调用方保持焦点不变。
 */
export function pickFocusTarget(
  cur: TabsetRectLike,
  all: TabsetRectLike[],
  dir: FocusDir,
): string | null {
  const vertical = dir === "up" || dir === "down";
  const sign = dir === "down" || dir === "right" ? 1 : -1;
  let best: { id: string; score: number } | null = null;
  for (const r of all) {
    if (r.id === cur.id) continue;
    // 投影区间（垂直轴）重叠
    const aLo = vertical ? cur.x : cur.y;
    const aHi = vertical ? cur.x + cur.w : cur.y + cur.h;
    const bLo = vertical ? r.x : r.y;
    const bHi = vertical ? r.x + r.w : r.y + r.h;
    const overlap = Math.min(aHi, bHi) - Math.max(aLo, bLo);
    if (overlap <= 0) continue;
    // 主轴：目标中心必须严格在当前中心的前方 sign 方向
    const curC = vertical ? cur.y + cur.h / 2 : cur.x + cur.w / 2;
    const rC = vertical ? r.y + r.h / 2 : r.x + r.w / 2;
    const dist = (rC - curC) * sign;
    if (dist <= 0) continue;
    // 评分：投影重叠越大越优先，其次近者优先
    const score = overlap * 10_000 - dist;
    if (!best || score > best.score) best = { id: r.id, score };
  }
  return best?.id ?? null;
}

/** 从当前聚焦窗格推导要新建的会话（同 harness 同 cwd，全新会话标题） */
export function resolveSplitTab(src: {
  adapterId: string;
  workspaceId?: string | null;
  cwd?: string;
}): { adapterId: string; workspaceId: string | null; cwd?: string; title: string } {
  return {
    adapterId: src.adapterId,
    workspaceId: src.workspaceId ?? null,
    cwd: src.cwd,
    title: "新会话",
  };
}

// —— Model 投影（flexlayout → 业务 Tab）——
// 鸭子类型，只依赖方法签名，不 import flexlayout runtime，保证 node 环境可单测。
// visitNodes 的参数用 any：flexlayout 的 Model.visitNodes 参数是具体 Node 类，
// 函数参数逆变导致无法直接赋给 NodeLike；用 any 让真实 Model 与测试 duck 对象都兼容。

export interface ModelLike {
  visitNodes(fn: (n: any, level: number) => void): void;
  getActiveTabset():
    | { getSelectedNode(): { getId(): string } | undefined }
    | undefined;
}

/** 把 flexlayout Model 里的全部 tab 节点投影为业务 Tab（顺序 = 访问顺序）。
 *  config.kind 透传（P23 终端 tab）；缺省 = agent（兼容旧布局 config）。 */
export function extractTabsFromModel(model: ModelLike): Tab[] {
  const out: Tab[] = [];
  model.visitNodes((n) => {
    if (n.getType() !== "tab") return;
    const cfg = n.getConfig() ?? {};
    const sessionId = typeof cfg.sessionId === "string" && cfg.sessionId.length > 0 ? cfg.sessionId : undefined;
    const cwd = typeof cfg.cwd === "string" && cfg.cwd.length > 0 ? cfg.cwd : undefined;
    const workspaceId = typeof cfg.workspaceId === "string" && cfg.workspaceId.length > 0 ? cfg.workspaceId : null;
    const kind = cfg.kind === "terminal" ? ("terminal" as const) : ("agent" as const);
    out.push({
      key: n.getId(),
      adapterId: String(cfg.adapterId ?? ""),
      sessionId,
      title: n.getName() || "新会话",
      cwd,
      workspaceId,
      kind,
    });
  });
  return out;
}

/** 从 Model 推导当前激活 tabKey（无则空串） */
export function activeKeyOf(model: ModelLike): string {
  const sel = model.getActiveTabset()?.getSelectedNode();
  return sel?.getId() ?? "";
}

// —— P30 R2：窗格内 Ctrl+Tab / Ctrl+Shift+Tab 循环切 tab ——

/** 解析键盘事件是否为「窗格内切 tab」快捷键；不是则返回 null。
 *  Ctrl+Tab = 向后（next），Ctrl+Shift+Tab = 向前（prev）；ctrl/meta 等价（mac 惯例）。
 *  Tab 键 code 缺失时回退 key 推断（老环境）。 */
export function tabCycleShortcut(e: {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): "next" | "prev" | null {
  const code = e.code ?? inferredCode(e);
  if (code !== "Tab") return null;
  if (e.altKey) return null;
  if (!e.ctrlKey && !e.metaKey) return null;
  return e.shiftKey ? "prev" : "next";
}

/** 循环切换索引（P30 R2 纯逻辑）：dir=next 向后 / prev 向前，到头循环。
 *  count<=1 或 selected 无效时返回 null（调用方不动）。 */
export function nextTabIndex(count: number, selected: number, dir: "next" | "prev"): number | null {
  if (!Number.isInteger(count) || !Number.isInteger(selected)) return null;
  if (count <= 1) return null;
  if (selected < 0 || selected >= count) return null;
  return dir === "next" ? (selected + 1) % count : (selected - 1 + count) % count;
}
