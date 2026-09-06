// P10 分屏纯逻辑单测（F-10-3 AC-P10-8/9）。

import { describe, it, expect } from "vitest";
import {
  inEditable,
  splitShortcut,
  closeTabShortcut,
  resolveSplitTab,
  extractTabsFromModel,
  activeKeyOf,
  focusArrowShortcut,
  pickFocusTarget,
  type ModelLike,
} from "./layout";

describe("P10 分屏纯逻辑", () => {
  // p20n 重映射：分屏快捷键带 Shift（Ctrl/Cmd+Shift+D 左右、Ctrl/Cmd+Shift+E 上下），
  // 裸 Ctrl/Cmd+D 让位给「关闭当前 tab」（closeTabShortcut）。
  it("splitShortcut：Ctrl+Shift+D→row，Ctrl+Shift+E→col，无 Shift/无修饰→null", () => {
    expect(splitShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: true })).toBe("row");
    expect(splitShortcut({ key: "e", ctrlKey: true, metaKey: false, shiftKey: true })).toBe("col");
    expect(splitShortcut({ key: "D", ctrlKey: true, metaKey: false, shiftKey: true })).toBe("row");
    expect(splitShortcut({ key: "e", ctrlKey: false, metaKey: true, shiftKey: true })).toBe("col");
    // 裸 Ctrl+D 不再是分屏（让位给关闭 tab）
    expect(splitShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: false })).toBeNull();
    // 无修饰键不触发
    expect(splitShortcut({ key: "d", ctrlKey: false, metaKey: false, shiftKey: true })).toBeNull();
    // 非 d/e 键不触发
    expect(splitShortcut({ key: "s", ctrlKey: true, metaKey: false, shiftKey: true })).toBeNull();
  });

  it("closeTabShortcut：Ctrl/Cmd+D（无 Shift）→ true，带 Shift 或其他键 → false", () => {
    expect(closeTabShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: false })).toBe(true);
    expect(closeTabShortcut({ key: "d", ctrlKey: false, metaKey: true, shiftKey: false })).toBe(true);
    // 带 Shift 是分屏不是关闭
    expect(closeTabShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: true })).toBe(false);
    expect(closeTabShortcut({ key: "e", ctrlKey: true, metaKey: false, shiftKey: false })).toBe(false);
    expect(closeTabShortcut({ key: "d", ctrlKey: false, metaKey: false, shiftKey: false })).toBe(false);
  });

  it("inEditable：textarea/input/contenteditable 不可拦截，普通元素可拦截", () => {
    const mk = (tagName: string, contentEditable = false) =>
      ({ tagName, isContentEditable: contentEditable }) as unknown as Element;
    expect(inEditable(mk("TEXTAREA"))).toBe(true);
    expect(inEditable(mk("input"))).toBe(true);
    expect(inEditable(mk("div"))).toBe(false);
    expect(inEditable(mk("div", true))).toBe(true);
    expect(inEditable(null)).toBe(false);
    expect(inEditable(undefined)).toBe(false);
  });

  it("resolveSplitTab：新会话保留 harness 与 cwd", () => {
    const r = resolveSplitTab({ adapterId: "omp", workspaceId: "ws-1", cwd: "/x/y" });
    expect(r.adapterId).toBe("omp");
    expect(r.workspaceId).toBe("ws-1");
    expect(r.cwd).toBe("/x/y");
    expect(r.title).toBe("新会话");
    // workspaceId 缺省 → null
    expect(resolveSplitTab({ adapterId: "omp" }).workspaceId).toBeNull();
  });

  it("extractTabsFromModel：只收 tab 节点，config 投影为业务 Tab", () => {
    const mkTab = (id: string, cfg: Record<string, unknown>, name = "标题") => ({
      getType: () => "tab",
      getId: () => id,
      getName: () => name,
      getConfig: () => cfg,
    });
    const model: ModelLike = {
      visitNodes: (fn) => {
        fn({ getType: () => "row", getId: () => "r1", getName: () => "", getConfig: () => undefined }, 0);
        fn(mkTab("tab-1", { adapterId: "omp", cwd: "/x", workspaceId: "ws-1" }), 1);
        fn(mkTab("tab-2", { adapterId: "pi" }), 1);
      },
      getActiveTabset: () => ({ getSelectedNode: () => ({ getId: () => "tab-1" }) }),
    };
    const tabs = extractTabsFromModel(model);
    expect(tabs).toHaveLength(2);
    expect(tabs[0].key).toBe("tab-1");
    expect(tabs[0].adapterId).toBe("omp");
    expect(tabs[0].workspaceId).toBe("ws-1");
    expect(tabs[1].workspaceId).toBeNull(); // 缺省 workspaceId → null
    expect(tabs[1].sessionId).toBeUndefined(); // 缺省 sessionId → undefined
    // P23：config 无 kind → 投影为 agent（旧布局兼容）
    expect(tabs[0].kind).toBe("agent");
    expect(tabs[1].kind).toBe("agent");
  });

  it("extractTabsFromModel：config.kind=terminal → 投影为终端 Tab（P23）", () => {
    const mkTab = (id: string, cfg: Record<string, unknown>, name = "标题") => ({
      getType: () => "tab",
      getId: () => id,
      getName: () => name,
      getConfig: () => cfg,
    });
    const model: ModelLike = {
      visitNodes: (fn) => {
        fn(mkTab("tab-9", { adapterId: "terminal", cwd: "/w", kind: "terminal" }, "终端"), 1);
      },
      getActiveTabset: () => undefined,
    };
    const tabs = extractTabsFromModel(model);
    expect(tabs[0].kind).toBe("terminal");
    expect(tabs[0].adapterId).toBe("terminal");
    expect(tabs[0].title).toBe("终端");
  });

  it("activeKeyOf：取激活 tabset 的选中 tab id；无则空串", () => {
    const withSel: ModelLike = { visitNodes: () => {}, getActiveTabset: () => ({ getSelectedNode: () => ({ getId: () => "k9" }) }) };
    expect(activeKeyOf(withSel)).toBe("k9");
    const none: ModelLike = { visitNodes: () => {}, getActiveTabset: () => undefined };
    expect(activeKeyOf(none)).toBe("");
  });

  it("focusArrowShortcut：macOS Cmd+方向键→方向，裸方向键/Alt 修饰→null", () => {
    // node 环境无 navigator，focusArrowShortcut 内部回退 Ctrl 分支（浏览器专属判定）
    expect(focusArrowShortcut({ key: "ArrowRight", ctrlKey: true, metaKey: false, altKey: false })).toBe("right");
    expect(focusArrowShortcut({ key: "ArrowUp", ctrlKey: true, metaKey: false, altKey: false })).toBe("up");
    expect(focusArrowShortcut({ key: "ArrowLeft", ctrlKey: true, metaKey: false, altKey: false })).toBe("left");
    expect(focusArrowShortcut({ key: "ArrowDown", ctrlKey: true, metaKey: false, altKey: false })).toBe("down");
    // 裸方向键（输入框光标移动）不受拦截
    expect(focusArrowShortcut({ key: "ArrowRight", ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
    // Alt 修饰不响应
    expect(focusArrowShortcut({ key: "ArrowRight", ctrlKey: true, metaKey: false, altKey: true })).toBeNull();
    // node 环境下 typeof navigator === "undefined" → 走 Ctrl 分支，Cmd 单独不响应
    expect(focusArrowShortcut({ key: "ArrowRight", ctrlKey: false, metaKey: true, altKey: false })).toBeNull();
  });

  it("pickFocusTarget：左右分屏横向切换、上下投影不重叠不误切", () => {
    // 左右两窗格
    const left = { id: "L", x: 0, y: 0, w: 500, h: 600 };
    const right = { id: "R", x: 508, y: 0, w: 500, h: 600 };
    expect(pickFocusTarget(left, [left, right], "right")).toBe("R");
    expect(pickFocusTarget(right, [left, right], "left")).toBe("L");
    // 边缘方向无候选 → null（焦点保持）
    expect(pickFocusTarget(right, [left, right], "right")).toBeNull();
    expect(pickFocusTarget(left, [left, right], "left")).toBeNull();
    // 上下叠放：横向投影重叠 0 → 左右不误切
    const top = { id: "T", x: 0, y: 0, w: 1000, h: 300 };
    const bottom = { id: "B", x: 0, y: 308, w: 1000, h: 300 };
    expect(pickFocusTarget(top, [top, bottom], "down")).toBe("B");
    expect(pickFocusTarget(top, [top, bottom], "right")).toBeNull();
  });

  it("pickFocusTarget：三窗格取投影重叠最大者（斜向就近），而非任意前方窗格", () => {
    // 当前在右上，右下与左下都在下方；ArrowDown 应选投影重叠的右下（正下方），
    // 而不是左下（无水平重叠，被 overlap<=0 排除）
    const cur = { id: "TR", x: 508, y: 0, w: 500, h: 300 };
    const br = { id: "BR", x: 508, y: 308, w: 500, h: 300 };
    const bl = { id: "BL", x: 0, y: 308, w: 500, h: 300 };
    expect(pickFocusTarget(cur, [cur, br, bl], "down")).toBe("BR");
  });
});
