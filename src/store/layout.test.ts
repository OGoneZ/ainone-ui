// P10 分屏纯逻辑单测（F-10-3 AC-P10-8/9）。

import { describe, it, expect } from "vitest";
import {
  inEditable,
  splitShortcut,
  resolveSplitTab,
  extractTabsFromModel,
  activeKeyOf,
  type ModelLike,
} from "./layout";

describe("P10 分屏纯逻辑", () => {
  it("splitShortcut：Ctrl+D→row，Ctrl+Shift+D→col，其余→null", () => {
    expect(splitShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: false })).toBe("row");
    expect(splitShortcut({ key: "d", ctrlKey: true, metaKey: false, shiftKey: true })).toBe("col");
    expect(splitShortcut({ key: "D", ctrlKey: true, metaKey: false, shiftKey: false })).toBe("row");
    // 无修饰键不触发
    expect(splitShortcut({ key: "d", ctrlKey: false, metaKey: false, shiftKey: false })).toBeNull();
    // 非 d 键不触发
    expect(splitShortcut({ key: "s", ctrlKey: true, metaKey: false, shiftKey: false })).toBeNull();
    // macOS Cmd+D 等同 Ctrl+D
    expect(splitShortcut({ key: "d", ctrlKey: false, metaKey: true, shiftKey: false })).toBe("row");
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
  });

  it("activeKeyOf：取激活 tabset 的选中 tab id；无则空串", () => {
    const withSel: ModelLike = { visitNodes: () => {}, getActiveTabset: () => ({ getSelectedNode: () => ({ getId: () => "k9" }) }) };
    expect(activeKeyOf(withSel)).toBe("k9");
    const none: ModelLike = { visitNodes: () => {}, getActiveTabset: () => undefined };
    expect(activeKeyOf(none)).toBe("");
  });
});
