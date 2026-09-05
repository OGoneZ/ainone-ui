// F-17-1 等分分屏纯逻辑单测（修正 DEC-52：owner = 可均分的最近祖先 row）。

import { describe, expect, it } from "vitest";
import {
  findOwningRow,
  equalizeRowChildren,
  equalizeSplitFor,
  type LayoutNodeLike,
} from "./splitEqualize";

/** 造测试节点树（自动接 parent 引用） */
function node(
  id: string,
  type: string,
  orientation: string,
  children: LayoutNodeLike[] = [],
): LayoutNodeLike {
  const n: LayoutNodeLike = {
    getId: () => id,
    getType: () => type,
    getParent: () => undefined,
    getChildren: () => children,
    getOrientation: () => ({ getName: () => orientation }),
    getWeight: () => 100,
  };
  for (const c of children) {
    (c as { getParent: () => LayoutNodeLike | undefined }).getParent = () => n;
  }
  return n;
}

describe("findOwningRow（P17 修正）", () => {
  it("tabset 直挂根 row（同向）→ owner = 根 row（上一版此处返回 undefined，等分失效根因）", () => {
    const tsA = node("tsA", "tabset", "horz");
    const tsB = node("tsB", "tabset", "horz");
    const root = node("root", "row", "horz", [tsA, tsB]);
    void root;
    expect(findOwningRow(tsA, "horz")).toBe(root);
  });

  it("三 tabset 同挂根 → owner = 根", () => {
    const a = node("a", "tabset", "horz");
    const b = node("b", "tabset", "horz");
    const c = node("c", "tabset", "horz");
    const root = node("root", "row", "horz", [a, b, c]);
    void root;
    expect(findOwningRow(b, "horz")).toBe(root);
  });

  it("反向嵌套：上下分屏建的 vert row → owner = 该 vert row", () => {
    const tsA = node("tsA", "tabset", "horz");
    const tsB = node("tsB", "tabset", "horz");
    const vertRow = node("vert", "row", "vert", [tsA, tsB]);
    const root = node("root", "row", "horz", [vertRow]);
    void root;
    expect(findOwningRow(tsA, "horz")).toBe(vertRow);
  });

  it("单子节点直挂链：向上跨过单子 row 找到可均分层", () => {
    const ts = node("ts", "tabset", "horz");
    const single = node("single", "row", "horz", [ts]);
    const root = node("root", "row", "horz", [single, node("other", "tabset", "horz")]);
    void root;
    expect(findOwningRow(ts, "horz")).toBe(root);
  });
});

describe("equalizeRowChildren", () => {
  it("2 个子节点 → 各 50", () => {
    const a = node("a", "tabset", "horz");
    const b = node("b", "tabset", "horz");
    const row = node("r", "row", "vert", [a, b]);
    expect(equalizeRowChildren(row)).toEqual({ rowId: "r", weights: [50, 50] });
  });

  it("3 个子节点 → 各 1/3", () => {
    const a = node("a", "tabset", "horz");
    const b = node("b", "tabset", "horz");
    const c = node("c", "tabset", "horz");
    const row = node("r", "row", "vert", [a, b, c]);
    const r = equalizeRowChildren(row)!;
    expect(r.weights).toHaveLength(3);
    r.weights.forEach((w) => expect(w).toBeCloseTo(100 / 3));
  });

  it("不足 2 个子节点 → null", () => {
    const a = node("a", "tabset", "horz");
    const row = node("r", "row", "vert", [a]);
    expect(equalizeRowChildren(row)).toBeNull();
  });
});

describe("equalizeSplitFor", () => {
  it("三连分屏场景：owner=根 row → 3 等分", () => {
    const a = node("a", "tabset", "horz");
    const b = node("b", "tabset", "horz");
    const c = node("c", "tabset", "horz");
    const root = node("root", "row", "horz", [a, b, c]);
    void root;
    const r = equalizeSplitFor(c, "horz")!;
    expect(r.rowId).toBe("root");
    expect(r.weights.map((w) => w)).toEqual([100 / 3, 100 / 3, 100 / 3]);
  });

  it("无父节点 → null", () => {
    const ts = node("ts", "tabset", "horz");
    expect(equalizeSplitFor(ts, "horz")).toBeNull();
  });
});
