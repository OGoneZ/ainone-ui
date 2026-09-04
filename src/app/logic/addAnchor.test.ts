// addTabToModel 的 toNode 锚点解析（VS Code 式多开修复的核心逻辑，App.tsx 同款）。
// flexlayout applyAddTab 对 toNode 只接受 TabSetNode/BorderNode/RowNode/TabGroupNode：
// 传 tab 节点 id 时静默失败 → 第二个 session 起开不出来。此处抽纯函数锁行为防回归。

import { describe, it, expect } from "vitest";

/** App.tsx addTabToModel 的锚点解析部分（与实现保持同步，修改需两处同步） */
export function resolveAddAnchor(
  targetNodeId: string | undefined,
  getNode: (id: string) => { getType: () => string; getParent?: () => { getType: () => string; getId: () => string } | null } | undefined,
  getActiveTabset: () => { getId: () => string } | undefined,
  getRootRowId: () => string,
): { to: string; centerFallback: boolean } {
  let to = targetNodeId ?? "";
  let centerFallback = false;
  if (to) {
    const node = getNode(to);
    if (node && node.getType() === "tab") {
      const parent = node.getParent?.();
      if (parent && parent.getType() === "tabset") {
        to = parent.getId();
      } else {
        to = "";
      }
    } else if (!node) {
      to = "";
    }
  }
  if (!to) {
    to = getActiveTabset()?.getId() ?? getRootRowId();
    centerFallback = true;
  }
  return { to, centerFallback };
}

describe("resolveAddAnchor（VS Code 式多开修复，flexlayout toNode 锚点）", () => {
  it("targetNodeId 是 tab 节点 → 解析为其父 tabset（多开叠放的关键）", () => {
    const r = resolveAddAnchor(
      "t1",
      (id) =>
        id === "t1"
          ? { getType: () => "tab", getParent: () => ({ getType: () => "tabset", getId: () => "ts-1" }) }
          : undefined,
      () => undefined,
      () => "row-root",
    );
    expect(r).toEqual({ to: "ts-1", centerFallback: false });
  });

  it("targetNodeId 本身就是 tabset → 原样使用", () => {
    const r = resolveAddAnchor(
      "ts-1",
      (id) => (id === "ts-1" ? { getType: () => "tabset" } : undefined),
      () => undefined,
      () => "row-root",
    );
    expect(r).toEqual({ to: "ts-1", centerFallback: false });
  });

  it("targetNodeId 是已关闭/不存在的 tab（激活丢失）→ 回退激活 tabset", () => {
    const r = resolveAddAnchor(
      "gone",
      () => undefined,
      () => ({ getId: () => "ts-active" }),
      () => "row-root",
    );
    expect(r).toEqual({ to: "ts-active", centerFallback: true });
  });

  it("空布局（无激活 tabset）→ 回退根 row，CENTER 兜底", () => {
    const r = resolveAddAnchor(undefined, () => undefined, () => undefined, () => "row-root");
    expect(r).toEqual({ to: "row-root", centerFallback: true });
  });

  it("tab 节点无父 tabset（异常结构）→ 回退激活 tabset", () => {
    const r = resolveAddAnchor(
      "t1",
      () => ({ getType: () => "tab", getParent: () => null }),
      () => ({ getId: () => "ts-active" }),
      () => "row-root",
    );
    expect(r).toEqual({ to: "ts-active", centerFallback: true });
  });
});
