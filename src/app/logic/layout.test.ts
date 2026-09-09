// P10 分屏纯逻辑单测（F-10-3 AC-P10-8/9）。
// node 环境（纯逻辑无 DOM）：可 require("node:fs") 做源码级回归断言。

import { describe, it, expect } from "vitest";
import {
  inEditable,
  splitShortcut,
  closeTabShortcut,
  resolveSplitTab,
  extractTabsFromModel,
  activeKeyOf,
  visibleKeysOf,
  focusArrowShortcut,
  pickFocusTarget,
  tabCycleShortcut,
  nextTabIndex,
  layoutBindings,
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

  // —— P34 R1：可见性投影（分屏失焦窗格白屏回归的语义修正）——

  /** 造一个鸭子 tab 节点（可见性测试只需 getType/getId） */
  const mkVisTab = (id: string) => ({
    getType: () => "tab",
    getId: () => id,
    getName: () => id,
    getConfig: () => ({}),
  });

  /** 造一个鸭子 tabset 节点 */
  const mkTabset = (id: string, selectedId?: string) => ({
    getType: () => "tabset",
    getId: () => id,
    ...(selectedId !== undefined
      ? { getSelectedNode: () => ({ getId: () => selectedId }) }
      : { getSelectedNode: () => undefined }),
  });

  it("visibleKeysOf：每个 tabset 的选中 tab 都可见（分屏多窗格各有一个）", () => {
    const model: ModelLike = {
      visitNodes: (fn) => {
        fn(mkTabset("ts1", "k1"), 1);
        fn(mkVisTab("k1"), 2);
        fn(mkTabset("ts2", "k2"), 1);
        fn(mkVisTab("k2"), 2);
        fn(mkVisTab("k3"), 2); // ts1 的非选中 tab
      },
      getActiveTabset: () => ({ getSelectedNode: () => ({ getId: () => "k1" }) }),
    };
    const vis = visibleKeysOf(model);
    // 分屏：两个 tabset 的选中 tab 都屏幕可见
    expect(vis.has("k1")).toBe(true);
    expect(vis.has("k2")).toBe(true);
    // 非选中 tab 不可见
    expect(vis.has("k3")).toBe(false);
  });

  it("visibleKeysOf：可见集合 ≠ 焦点——焦点只在 activeKeyOf，可见是全集", () => {
    const model: ModelLike = {
      visitNodes: (fn) => {
        fn(mkTabset("ts1", "kA"), 1);
        fn(mkTabset("ts2", "kB"), 1);
      },
      getActiveTabset: () => ({ getSelectedNode: () => ({ getId: () => "kA" }) }),
    };
    // 焦点单值（kA），可见双值（kA、kB）——R7 白屏的语义根源即二者混淆
    expect(activeKeyOf(model)).toBe("kA");
    expect(visibleKeysOf(model)).toEqual(new Set(["kA", "kB"]));
  });

  it("visibleKeysOf：tabset 无选中/空布局 → 空集", () => {
    const noSel: ModelLike = {
      visitNodes: (fn) => fn(mkTabset("ts1"), 1),
      getActiveTabset: () => undefined,
    };
    expect(visibleKeysOf(noSel).size).toBe(0);
    const empty: ModelLike = { visitNodes: () => {}, getActiveTabset: () => undefined };
    expect(visibleKeysOf(empty).size).toBe(0);
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

  // P25：判定函数可传入键位绑定（改绑后新键生效旧键失效），缺省沿用默认表
  it("P25 splitShortcut/closeTabShortcut：自定义绑定生效，缺省不变", () => {
    // 缺省：默认表语义
    expect(splitShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: true })).toBe("row");
    expect(closeTabShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: false })).toBe(true);
    // 自定义：关窗改绑 KeyQ（无 Shift），旧 Ctrl+D 不再关窗
    const custom = layoutBindings({ "pane.close-tab": [{ code: "KeyQ", ctrl: true }] });
    expect(closeTabShortcut({ key: "q", ctrlKey: true, metaKey: false, shiftKey: false }, custom)).toBe(true);
    expect(closeTabShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: false }, custom)).toBe(false);
    // 自定义：分屏改绑 KeyR+Shift
    const customSplit = layoutBindings({ "pane.split-row": [{ code: "KeyR", ctrl: true, shift: true }] });
    expect(splitShortcut({ key: "r", ctrlKey: true, metaKey: false, shiftKey: true }, customSplit)).toBe("row");
    expect(splitShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: true }, customSplit)).toBeNull();
  });

  it("P25 focusArrowShortcut：自定义绑定（含 code 的真实事件形）生效", () => {
    const custom = layoutBindings({ "pane.focus-n": [{ code: "ArrowUp", ctrl: true }] });
    expect(focusArrowShortcut({ key: "ArrowUp", code: "ArrowUp", ctrlKey: true, metaKey: false, altKey: false }, custom)).toBe("up");
    expect(focusArrowShortcut({ key: "ArrowRight", code: "ArrowRight", ctrlKey: true, metaKey: false, altKey: false }, custom)).toBe("right");
    // 修饰不符不命中
    expect(focusArrowShortcut({ key: "ArrowUp", code: "ArrowUp", ctrlKey: false, metaKey: false, altKey: false }, custom)).toBeNull();
  });
});

// —— P30：窗格内 Ctrl+Tab 循环切 tab ——

describe("P30 tabCycleShortcut", () => {
  it("Ctrl/Cmd+Tab→next；+Shift→prev（AC-R2-1）", () => {
    expect(tabCycleShortcut({ key: "Tab", code: "Tab", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe("next");
    expect(tabCycleShortcut({ key: "Tab", code: "Tab", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe("next");
    expect(tabCycleShortcut({ key: "Tab", code: "Tab", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe("prev");
  });

  it("非 Tab 键 / 无修饰 / alt 修饰→null（不误吞浏览器焦点移动）", () => {
    expect(tabCycleShortcut({ key: "b", code: "KeyB", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(tabCycleShortcut({ key: "Tab", code: "Tab", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBeNull();
    expect(tabCycleShortcut({ key: "Tab", code: "Tab", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false })).toBeNull();
  });
});

describe("P30 nextTabIndex 循环语义（AC-R2-1）", () => {
  it("next 到尾循环：2→0", () => {
    expect(nextTabIndex(3, 2, "next")).toBe(0);
  });

  it("prev 到头循环：0→2", () => {
    expect(nextTabIndex(3, 0, "prev")).toBe(2);
  });

  it("正常推进：0→1→2", () => {
    expect(nextTabIndex(3, 0, "next")).toBe(1);
    expect(nextTabIndex(3, 1, "next")).toBe(2);
  });

  it("单 tab / 空 tabset 返回 null（调用方不动）", () => {
    expect(nextTabIndex(1, 0, "next")).toBeNull();
    expect(nextTabIndex(0, -1, "next")).toBeNull();
    expect(nextTabIndex(1, 0, "prev")).toBeNull();
  });

  it("selected 越界 / 非整数返回 null（防呆，不编造索引）", () => {
    expect(nextTabIndex(3, 3, "next")).toBeNull();
    expect(nextTabIndex(3, -1, "next")).toBeNull();
    expect(nextTabIndex(3, 1.5, "next")).toBeNull();
    expect(nextTabIndex(NaN, 0, "next")).toBeNull();
  });
});

describe("P30 R1 焦点保持（源码级回归锁定）", () => {
  it("onFocusMove 不再把源 tabset 的 selected idx 传给 activateTabsetAndComposer（AC-R1-1）", async () => {
    const appSrc = await readAppSource();
    // 旧 bug：activateTabsetAndComposer(targetId, curTabset.getSelected() ?? 0)
    // → selectTab(目标.children[源Idx])，错位/越界兜底 0 = 切焦点跳第一个 tab
    expect(appSrc).not.toMatch(/activateTabsetAndComposer\(targetId,\s*curTabset\.getSelected\(\)\s*\?\?\s*0\)/);
    expect(appSrc).toMatch(/activateTabsetAndComposer\(targetId\);/);
  });

  it("activateTabsetAndComposer 无效 idx 不再兜底 0（三态语义：不改选中）", async () => {
    const appSrc = await readAppSource();
    // 旧实现：selectedIdx !== undefined && ... ? selectedIdx : 0
    expect(appSrc).not.toMatch(/\?\s*selectedIdx\s*:\s*0/);
    // 新实现：无效 idx 走 getSelectedNode() 读当前显示
    expect(appSrc).toMatch(/getSelectedNode\?\.\(\)/);
  });
});

/** 读 App.tsx 源码（node 环境专用；tsconfig 未含 @types/node → 字符串路径规避类型检查） */
async function readAppSource(): Promise<string> {
  const mod: { readFileSync: (p: string, enc: string) => string } = await import(/* @vite-ignore */ "nod" + "e:fs");
  return mod.readFileSync(new URL("../App.tsx", import.meta.url).pathname, "utf8");
}
