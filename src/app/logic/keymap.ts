// P25 键位注册中心纯逻辑。零依赖，node 可单测。
//
// 设计要点：
// - Binding 用 e.code（物理键位）匹配而非 e.key：Alt+\ 在 macOS 的 e.key 是
//   «（option 组合变字符），e.code 恒为 Backslash，跨键盘布局稳定。
// - matchShortcut 对 ctrl/meta 等价处理（用户确认：Ctrl 为主、Cmd 兼容）。
//   键位语义纯粹由绑定表决定，不做系统占位特判——用户改绑什么就匹配什么
//   （如 ⌘M 系统最小化收不到事件，属平台行为，不由匹配层代管）。
// - 所有函数接收 bindings/defs 参数，不读全局状态——保持 layout.test.ts 同款纯函数风格。

/** 单个键位绑定：code = KeyboardEvent.code（如 "KeyB"、"Backslash"、"ArrowUp"） */
export interface Binding {
  code: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** 快捷键作用域：global=App 级监听；pane=仅激活窗格响应；chord=双击类 */
export type ShortcutScope = "global" | "pane" | "chord";

/** 全部快捷键 id（键位总表见规格书 P25） */
export type ShortcutId =
  | "app.toggle-sidebar"
  | "app.toggle-rightrail"
  | "app.new-session"
  | "app.new-terminal"
  | "app.global-search"
  | "app.switch-model"
  | "pane.split-row"
  | "pane.split-col"
  | "pane.close-tab"
  | "pane.focus-n"
  | "pane.focus-s"
  | "pane.focus-e"
  | "pane.focus-w"
  | "pane.focus-zone"
  | "pane.tab-next"
  | "pane.tab-prev"
  | "pane.temp-maximize"
  | "pane.scroll-line-up"
  | "pane.scroll-line-down"
  | "pane.scroll-page-up"
  | "pane.scroll-page-down"
  | "pane.scroll-top"
  | "pane.scroll-bottom"
  | "chat.jump-prev-user"
  | "chat.jump-next-user"
  | "chat.voice-toggle"
  | "chat.interrupt"
  | "pane.activity-toggle-all";

export interface ShortcutDef {
  id: ShortcutId;
  scope: ShortcutScope;
  /** 帮助弹窗展示的动作名 */
  label: string;
  defaults: Binding[];
  /** chord：双击判定窗口毫秒数（如双击 Esc 中断） */
  chordMs?: number;
}

/** 键盘事件鸭子类型（真实 KeyboardEvent 与测试对象都兼容） */
export interface KeyEventLike {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** 默认键位表。已有键（搜索/分屏/关窗/移焦）迁移进来保持原语义。 */
export const DEFAULT_DEFS: ShortcutDef[] = [
  { id: "app.toggle-sidebar", scope: "global", label: "显示 / 隐藏左侧栏", defaults: [{ code: "KeyB", ctrl: true }] },
  { id: "app.toggle-rightrail", scope: "global", label: "显示 / 隐藏右侧栏", defaults: [{ code: "KeyK", ctrl: true }] },
  { id: "app.new-session", scope: "global", label: "新建会话", defaults: [{ code: "KeyN", ctrl: true }] },
  { id: "app.new-terminal", scope: "global", label: "新建终端", defaults: [{ code: "KeyT", ctrl: true }] },
  { id: "app.global-search", scope: "global", label: "搜索会话", defaults: [{ code: "KeyF", ctrl: true }] },
  { id: "app.switch-model", scope: "global", label: "切换模型（当前会话）", defaults: [{ code: "KeyP", ctrl: true }] },
  { id: "pane.split-row", scope: "global", label: "左右分屏", defaults: [{ code: "KeyD", ctrl: true, shift: true }] },
  { id: "pane.split-col", scope: "global", label: "上下分屏", defaults: [{ code: "KeyE", ctrl: true, shift: true }] },
  { id: "pane.close-tab", scope: "global", label: "关闭当前窗格", defaults: [{ code: "KeyD", ctrl: true }] },
  { id: "pane.focus-n", scope: "global", label: "焦点移到上方窗格", defaults: [{ code: "ArrowUp", ctrl: true }] },
  { id: "pane.focus-s", scope: "global", label: "焦点移到下方窗格", defaults: [{ code: "ArrowDown", ctrl: true }] },
  { id: "pane.focus-e", scope: "global", label: "焦点移到右侧窗格", defaults: [{ code: "ArrowRight", ctrl: true }] },
  { id: "pane.focus-w", scope: "global", label: "焦点移到左侧窗格", defaults: [{ code: "ArrowLeft", ctrl: true }] },
  { id: "pane.focus-zone", scope: "pane", label: "焦点域：聊天记录 ↔ 输入框", defaults: [{ code: "KeyL", ctrl: true }] },
  { id: "pane.tab-next", scope: "pane", label: "窗格内下一个 tab（循环）", defaults: [{ code: "Tab", ctrl: true }] },
  { id: "pane.tab-prev", scope: "pane", label: "窗格内上一个 tab（循环）", defaults: [{ code: "Tab", ctrl: true, shift: true }] },
  { id: "pane.temp-maximize", scope: "pane", label: "临时全屏当前窗格 / 恢复布局", defaults: [{ code: "Enter", ctrl: true }] },
  { id: "pane.scroll-line-up", scope: "pane", label: "聊天记录向上滚动一行", defaults: [{ code: "ArrowUp" }] },
  { id: "pane.scroll-line-down", scope: "pane", label: "聊天记录向下滚动一行", defaults: [{ code: "ArrowDown" }] },
  { id: "pane.scroll-page-up", scope: "pane", label: "聊天记录向上翻页", defaults: [{ code: "PageUp" }] },
  { id: "pane.scroll-page-down", scope: "pane", label: "聊天记录向下翻页", defaults: [{ code: "PageDown" }] },
  { id: "pane.scroll-top", scope: "pane", label: "跳到聊天记录最上方", defaults: [{ code: "Home" }] },
  { id: "pane.scroll-bottom", scope: "pane", label: "跳到聊天记录最下方", defaults: [{ code: "End" }] },
  { id: "chat.jump-prev-user", scope: "pane", label: "跳到上一条我的消息", defaults: [{ code: "ArrowUp", alt: true }] },
  { id: "chat.jump-next-user", scope: "pane", label: "跳到下一条我的消息", defaults: [{ code: "ArrowDown", alt: true }] },
  { id: "chat.voice-toggle", scope: "pane", label: "语音输入 开 / 关", defaults: [{ code: "Backslash", alt: true }] },
  { id: "chat.interrupt", scope: "chord", label: "中断当前回复（双击）", defaults: [{ code: "Escape" }], chordMs: 500 },
  { id: "pane.activity-toggle-all", scope: "pane", label: "展开 / 收起全部思考与工具", defaults: [{ code: "KeyO", ctrl: true }] },
];

// —— 匹配 ——

/**
 * 判定键盘事件是否命中绑定。ctrl 与 meta 等价（mac 惯例）。
 * 绑定的修饰键是「必须按下」语义——未声明的修饰键不强制抬起（宽匹配，
 * 否则浏览器自动携带的修饰会漏配）。
 */
export function matchBinding(e: KeyEventLike, b: Binding): boolean {
  const code = e.code ?? "";
  if (!code) return false;
  if (code !== b.code) return false;
  const mod = Boolean(e.ctrlKey) || Boolean(e.metaKey);
  const wantMod = Boolean(b.ctrl) || Boolean(b.meta);
  if (mod !== wantMod) return false;
  if (Boolean(b.shift) !== Boolean(e.shiftKey)) return false;
  if (Boolean(b.alt) !== Boolean(e.altKey)) return false;
  return true;
}

/** 事件是否命中 id 对应的任一默认/自定义绑定；defs 缺该 id → false */
export function matchShortcut(e: KeyEventLike, defs: ShortcutDef[], id: ShortcutId, overrides?: Partial<Record<ShortcutId, Binding[]>>): boolean {
  const def = defs.find((d) => d.id === id);
  if (!def) return false;
  const bindings = overrides?.[id] ?? def.defaults;
  return bindings.some((b) => matchBinding(e, b));
}

// —— 双击判定 ——

/** now 与 last 都在窗口内（且 last 有效）→ 双击成立 */
export function doublePress(now: number, last: number, windowMs: number): boolean {
  if (last <= 0) return false;
  return now - last <= windowMs;
}

// —— 展示 ——

/** 绑定的展示文案。mac 也输出 Ctrl+/Alt+/Shift+ 字面（用户指定：不用 ⌃⌥⇧⌘ 符号）。 */
export function formatBinding(b: Binding): string {
  const parts: string[] = [];
  if (b.ctrl || b.meta) parts.push("Ctrl+");
  if (b.alt) parts.push("Alt+");
  if (b.shift) parts.push("Shift+");
  return parts.join("") + prettyCode(b.code);
}

/** e.code → 人类可读键名（覆盖本项目用到的键，兜底原样返回） */
export function prettyCode(code: string): string {
  const named: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Backslash: "\\",
    Escape: "Esc",
    PageUp: "Page Up",
    PageDown: "Page Down",
    Enter: "Enter",
    Space: "空格",
    Tab: "Tab",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
  };
  if (named[code]) return named[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

// —— 冲突 ——

/** 两绑定同 code 同有效修饰 → 冲突。ctrl/meta 与 matchBinding 同语义等价——
 *  否则 Ctrl+B 与 Cmd+B 两个绑定会同时命中同一次按键。 */
export function detectConflict(a: Binding, b: Binding): boolean {
  return (
    a.code === b.code &&
    (Boolean(a.ctrl) || Boolean(a.meta)) === (Boolean(b.ctrl) || Boolean(b.meta)) &&
    Boolean(a.shift) === Boolean(b.shift) &&
    Boolean(a.alt) === Boolean(b.alt)
  );
}

/**
 * 在 defs+overrides 里找与 binding 冲突的其他动作 id（excludeId 除外）。
 * 返回第一个冲突的 id（帮助弹窗提示用）；无冲突返回 null。
 */
export function findConflictId(
  binding: Binding,
  defs: ShortcutDef[],
  overrides: Partial<Record<ShortcutId, Binding[]>> | undefined,
  excludeId: ShortcutId,
): ShortcutId | null {
  for (const def of defs) {
    if (def.id === excludeId) continue;
    const bindings = overrides?.[def.id] ?? def.defaults;
    if (bindings.some((b) => detectConflict(binding, b))) return def.id;
  }
  return null;
}

// —— 持久化（localStorage 容错；store 只存 overrides） ——

export function serializeOverrides(overrides: Partial<Record<ShortcutId, Binding[]>>): string {
  return JSON.stringify(overrides);
}

/** 解析失败 / 结构不对 → null（调用方回默认） */
export function parseOverrides(raw: string | null): Partial<Record<ShortcutId, Binding[]>> | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o !== "object" || o === null || Array.isArray(o)) return null;
    const validIds = new Set(DEFAULT_DEFS.map((d) => d.id));
    const out: Partial<Record<ShortcutId, Binding[]>> = {};
    for (const [id, bindings] of Object.entries(o)) {
      if (!validIds.has(id as ShortcutId)) continue;
      if (!Array.isArray(bindings)) continue;
      const ok = bindings.filter(
        (b): b is Binding => typeof b === "object" && b !== null && typeof (b as Binding).code === "string",
      );
      if (ok.length > 0) out[id as ShortcutId] = ok;
    }
    return out;
  } catch {
    return null;
  }
}

// —— 用户消息导航 ——

/** 消息鸭子类型（ChatPanel 的 Message 有 role 字段即可） */
export interface MessageLike {
  role: string;
}

/** 全部 user 消息的下标数组（升序） */
export function userIndices(messages: MessageLike[]): number[] {
  const out: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") out.push(i);
  });
  return out;
}

/**
 * 游标推进：从当前 index（消息下标或 -1）沿 dir 找相邻 user 消息下标。
 * dir=+1 朝列表尾（下一条）、-1 朝列表头（上一条）；越界钳位到端点；
 * 无 user 消息或无处可去 → null（调用方保持不动）。
 */
export function nextUserCursor(indices: number[], cur: number, dir: 1 | -1): number | null {
  if (indices.length === 0) return null;
  if (dir === 1) {
    // 下一条：第一个 > cur 的
    const next = indices.find((i) => i > cur);
    return next ?? null;
  }
  // 上一条：最后一个 < cur 的
  const prev = [...indices].reverse().find((i) => i < cur);
  return prev ?? null;
}
