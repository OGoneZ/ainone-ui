// P10 分屏纯逻辑单测（F-10-3 AC-P10-8/9）。

import { describe, it, expect } from "vitest";
import { inEditable, splitShortcut, resolveSplitTab } from "./layout";

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
    const mk = (tagName: string, contentEditable = false) => ({ tagName, isContentEditable: contentEditable });
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
});
