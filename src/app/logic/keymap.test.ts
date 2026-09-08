// P25 键位注册中心纯逻辑单测。

import { describe, it, expect } from "vitest";
import {
  matchBinding,
  matchShortcut,
  doublePress,
  formatBinding,
  prettyCode,
  detectConflict,
  findConflictId,
  serializeOverrides,
  parseOverrides,
  userIndices,
  nextUserCursor,
  DEFAULT_DEFS,
  type Binding,
} from "./keymap";

const bind = (code: string, mods: Partial<Binding> = {}): Binding => ({ code, ...mods });

describe("P25 matchBinding", () => {
  it("code 相同 + 修饰全等 → 命中", () => {
    expect(matchBinding({ code: "KeyB", ctrlKey: true }, bind("KeyB", { ctrl: true }))).toBe(true);
    expect(matchBinding({ code: "Backslash", altKey: true }, bind("Backslash", { alt: true }))).toBe(true);
    expect(matchBinding({ code: "ArrowUp", altKey: true }, bind("ArrowUp", { alt: true }))).toBe(true);
  });

  it("ctrl 与 meta 等价（Cmd 兼容）", () => {
    expect(matchBinding({ code: "KeyB", metaKey: true }, bind("KeyB", { ctrl: true }))).toBe(true);
    expect(matchBinding({ code: "KeyB", ctrlKey: true }, bind("KeyB", { meta: true }))).toBe(true);
  });

  it("无修饰键绑定要求 ctrl/meta 都不按", () => {
    expect(matchBinding({ code: "ArrowUp" }, bind("ArrowUp"))).toBe(true);
    expect(matchBinding({ code: "ArrowUp", ctrlKey: true }, bind("ArrowUp"))).toBe(false);
  });

  it("shift/alt 必须精确匹配", () => {
    expect(matchBinding({ code: "KeyD", ctrlKey: true, shiftKey: true }, bind("KeyD", { ctrl: true, shift: true }))).toBe(true);
    expect(matchBinding({ code: "KeyD", ctrlKey: true }, bind("KeyD", { ctrl: true, shift: true }))).toBe(false);
    expect(matchBinding({ code: "KeyD", ctrlKey: true, shiftKey: true }, bind("KeyD", { ctrl: true }))).toBe(false);
  });

  it("meta 修饰与 ctrl 同语义等价", () => {
    expect(matchBinding({ code: "KeyM", metaKey: true }, bind("KeyM", { ctrl: true }))).toBe(true);
    expect(matchBinding({ code: "KeyM", metaKey: true }, bind("KeyM", { meta: true }))).toBe(true);
    // Ctrl+M 正常命中
    expect(matchBinding({ code: "KeyM", ctrlKey: true }, bind("KeyM", { ctrl: true }))).toBe(true);
  });

  it("code 缺失或不同 → 不命中", () => {
    expect(matchBinding({ key: "b", ctrlKey: true }, bind("KeyB", { ctrl: true }))).toBe(false);
    expect(matchBinding({ code: "KeyN", ctrlKey: true }, bind("KeyB", { ctrl: true }))).toBe(false);
  });
});

describe("P25 matchShortcut / DEFAULT_DEFS", () => {
  it("默认表命中典型键位", () => {
    expect(matchShortcut({ code: "KeyN", ctrlKey: true }, DEFAULT_DEFS, "app.new-session")).toBe(true);
    expect(matchShortcut({ code: "KeyT", ctrlKey: true }, DEFAULT_DEFS, "app.new-terminal")).toBe(true);
    expect(matchShortcut({ code: "KeyF", metaKey: true }, DEFAULT_DEFS, "app.global-search")).toBe(true);
    expect(matchShortcut({ code: "KeyD", ctrlKey: true, shiftKey: true }, DEFAULT_DEFS, "pane.split-row")).toBe(true);
    expect(matchShortcut({ code: "KeyE", ctrlKey: true, shiftKey: true }, DEFAULT_DEFS, "pane.split-col")).toBe(true);
    expect(matchShortcut({ code: "KeyD", ctrlKey: true }, DEFAULT_DEFS, "pane.close-tab")).toBe(true);
    expect(matchShortcut({ code: "KeyL", ctrlKey: true }, DEFAULT_DEFS, "pane.focus-zone")).toBe(true);
    expect(matchShortcut({ code: "KeyO", ctrlKey: true }, DEFAULT_DEFS, "pane.activity-toggle-all")).toBe(true);
    expect(matchShortcut({ code: "ArrowUp" }, DEFAULT_DEFS, "pane.scroll-line-up")).toBe(true);
    expect(matchShortcut({ code: "PageDown" }, DEFAULT_DEFS, "pane.scroll-page-down")).toBe(true);
    expect(matchShortcut({ code: "Home" }, DEFAULT_DEFS, "pane.scroll-top")).toBe(true);
    expect(matchShortcut({ code: "End" }, DEFAULT_DEFS, "pane.scroll-bottom")).toBe(true);
    expect(matchShortcut({ code: "Backslash", altKey: true }, DEFAULT_DEFS, "chat.voice-toggle")).toBe(true);
  });

  it("裸 Ctrl+D 命中关窗而非分屏；带 Shift 命中分屏而非关窗", () => {
    expect(matchShortcut({ code: "KeyD", ctrlKey: true, shiftKey: false }, DEFAULT_DEFS, "pane.close-tab")).toBe(true);
    expect(matchShortcut({ code: "KeyD", ctrlKey: true, shiftKey: false }, DEFAULT_DEFS, "pane.split-row")).toBe(false);
    expect(matchShortcut({ code: "KeyD", ctrlKey: true, shiftKey: true }, DEFAULT_DEFS, "pane.close-tab")).toBe(false);
  });

  it("overrides 覆盖默认绑定（改绑后旧键失效新键生效）", () => {
    const overrides = { "app.toggle-sidebar": [bind("KeyI", { ctrl: true })] };
    expect(matchShortcut({ code: "KeyI", ctrlKey: true }, DEFAULT_DEFS, "app.toggle-sidebar", overrides)).toBe(true);
    expect(matchShortcut({ code: "KeyB", ctrlKey: true }, DEFAULT_DEFS, "app.toggle-sidebar", overrides)).toBe(false);
  });

  it("id 不在 defs → false", () => {
    expect(matchShortcut({ code: "KeyB", ctrlKey: true }, [], "app.toggle-sidebar")).toBe(false);
  });
});

describe("P25 doublePress", () => {
  it("窗口内两次按下成立", () => {
    expect(doublePress(1000, 700, 500)).toBe(true);
    expect(doublePress(1000, 500, 500)).toBe(true); // 恰在边界
  });
  it("超出窗口或无上一次按下 → 不成立", () => {
    expect(doublePress(1000, 499, 500)).toBe(false);
    expect(doublePress(1000, 0, 500)).toBe(false);
    expect(doublePress(1000, -1, 500)).toBe(false);
  });
});

describe("P25 展示", () => {
  it("prettyCode：Key/Digit 前缀剥离、方向键与符号映射", () => {
    expect(prettyCode("KeyB")).toBe("B");
    expect(prettyCode("Digit1")).toBe("1");
    expect(prettyCode("ArrowUp")).toBe("↑");
    expect(prettyCode("Backslash")).toBe("\\");
    expect(prettyCode("Escape")).toBe("Esc");
    expect(prettyCode("F5")).toBe("F5");
  });
  it("formatBinding：node 环境（非 mac UA）用 Ctrl+/Alt+ 前缀", () => {
    expect(formatBinding(bind("KeyB", { ctrl: true }))).toBe("Ctrl+B");
    expect(formatBinding(bind("Backslash", { alt: true }))).toBe("Alt+\\");
    expect(formatBinding(bind("KeyD", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+D");
    expect(formatBinding(bind("ArrowUp"))).toBe("↑");
  });
});

describe("P25 冲突检测", () => {
  it("detectConflict：同 code 同修饰 → 冲突；修饰不同 → 不冲突", () => {
    expect(detectConflict(bind("KeyB", { ctrl: true }), bind("KeyB", { ctrl: true }))).toBe(true);
    expect(detectConflict(bind("KeyB", { ctrl: true }), bind("KeyB", { ctrl: true, shift: true }))).toBe(false);
    expect(detectConflict(bind("KeyB", { ctrl: true }), bind("KeyB", { meta: true }))).toBe(true); // ctrl/meta 等价视为冲突
  });

  it("findConflictId：命中其他动作的默认绑定；排除自身", () => {
    expect(findConflictId(bind("KeyN", { ctrl: true }), DEFAULT_DEFS, undefined, "app.toggle-rightrail")).toBe("app.new-session");
    expect(findConflictId(bind("KeyN", { ctrl: true }), DEFAULT_DEFS, undefined, "app.new-session")).toBeNull();
  });

  it("findConflictId：overrides 参与查重", () => {
    const overrides = { "app.new-terminal": [bind("KeyI", { ctrl: true })] };
    expect(findConflictId(bind("KeyI", { ctrl: true }), DEFAULT_DEFS, overrides, "app.toggle-sidebar")).toBe("app.new-terminal");
  });
});

describe("P25 持久化容错", () => {
  it("serialize → parse 往返", () => {
    const overrides = { "app.toggle-sidebar": [bind("KeyI", { ctrl: true })] };
    expect(parseOverrides(serializeOverrides(overrides))).toEqual(overrides);
  });
  it("null / 坏 JSON / 结构不对 → null", () => {
    expect(parseOverrides(null)).toBeNull();
    expect(parseOverrides("not json")).toBeNull();
    expect(parseOverrides("[1,2]")).toBeNull();
    expect(parseOverrides('{"a":1}')).toEqual({}); // 未知 id 被滤掉 → 空覆盖（合法）
  });
  it("非法绑定条目被过滤，无有效条目的 id 被丢弃", () => {
    const out = parseOverrides('{"app.toggle-sidebar":[{"code":"KeyI","ctrl":true},{"bad":1}],"app.new-session":[]}');
    expect(out).toEqual({ "app.toggle-sidebar": [{ code: "KeyI", ctrl: true }] });
  });
});

describe("P25 用户消息导航", () => {
  const msgs = ["user", "assistant", "assistant", "user", "assistant", "user"].map((role) => ({ role }));

  it("userIndices：升序收集全部 user 下标", () => {
    expect(userIndices(msgs)).toEqual([0, 3, 5]);
  });
  it("nextUserCursor：向下推进 / 向上回退", () => {
    const idx = userIndices(msgs);
    expect(nextUserCursor(idx, -1, 1)).toBe(0);
    expect(nextUserCursor(idx, 0, 1)).toBe(3);
    expect(nextUserCursor(idx, 3, 1)).toBe(5);
    expect(nextUserCursor(idx, 5, -1)).toBe(3);
    expect(nextUserCursor(idx, 3, -1)).toBe(0);
  });
  it("越界钳位为 null（保持不动）；空列表 → null", () => {
    const idx = userIndices(msgs);
    expect(nextUserCursor(idx, 5, 1)).toBeNull();
    expect(nextUserCursor(idx, -1, -1)).toBeNull();
    expect(nextUserCursor([], 0, 1)).toBeNull();
  });
  it("cur 落在 user 消息上时，向下给下一条、向上给上一条", () => {
    const idx = userIndices(msgs);
    expect(nextUserCursor(idx, 3, 1)).toBe(5);
    expect(nextUserCursor(idx, 3, -1)).toBe(0);
  });
});
