// F-16-5 等分分屏纯逻辑单测（DEC-52）。

import { describe, expect, it } from "vitest";
import {
  findOwningRow,
  equalizeRowChildren,
  equalizeSplitFor,
  type LayoutNodeLike,
} from "./splitEqualize";

/** 造测试节点树 */
function node(
  id: string,
  type: string,
  orientation: string,
  children: LayoutNodeLike[] = [],
  parent?: LayoutNodeLike,
): LayoutNodeLike {
  const n: LayoutNodeLike = {
    getId: () => id,
    getType: () => type,
    getParent: () => parent,
    getChildren: () => children,
    getOrientation: () => ({ getName: () => orientation }),
    getWeight: () => 100,
  };
  children.forEach((c) => {
    // 让 getParent 链正确：重建子节点带 parent 引用
    (c as { getParent: () => LayoutNodeLike | undefined }).getParent = () => n;
  });
  return n;
}

describe("findOwningRow", () => {
  it("同向嵌套折叠：左右分屏后新 tabset 的祖先 = 根 row（horz）", () => {
    // root(horz) → [row(horz) → [tabsetA, tabsetB]]
    const tsA = node("tsA", "tabset", "horz");
    const tsB = node("tsB", "tabset", "horz");
    const inner = node("inner", "row", "horz", [tsA, tsB]);
    const root = node("root", "row", "horz", [inner]);
    void root;
    // tsA 的父链：inner(horz) → root(horz)，无反向 row → 向上折到根（同为 horz 也返回最外层）
    // 实际语义：parent 方向 != orientation 才返回；全 horz 时返回 undefined → 兜底用根
    expect(findOwningRow(tsA, "horz")).toBeUndefined();
  });

  it("反向分屏：上下分屏的新 tabset 的 owner = 新建 vert row", () => {
    const tsA = node("tsA", "tabset", "horz");
    const tsB = node("tsB", "tabset", "horz");
    // 上下分屏：flexlayout 建 vert row 包住 [新ts, 旧tabset]
    const vertRow = node("vert", "row", "vert", [tsA, tsB]);
    const root = node("root", "row", "horz", [vertRow]);
    void root;
    expect(findOwningRow(tsA, "horz")).toBe(vertRow);
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

  it("不足 2 个子节点 → null（无分屏可均分）", () => {
    const a = node("a", "tabset", "horz");
    const row = node("r", "row", "vert", [a]);
    expect(equalizeRowChildren(row)).toBeNull();
  });
});

describe("equalizeSplitFor", () => {
  it("组合：反向 row 场景返回 rowId + 等分 weights", () => {
    const tsA = node("tsA", "tabset", "horz");
    const tsB = node("tsB", "tabset", "horz");
    const vertRow = node("vert", "row", "vert", [tsA, tsB]);
    const root = node("root", "row", "horz", [vertRow]);
    void root;
    expect(equalizeSplitFor(tsA, "horz")).toEqual({ rowId: "vert", weights: [50, 50] });
  });

  it("同向无反向祖先 → null", () => {
    const tsA = node("tsA", "tabset", "horz");
    const inner = node("inner", "row", "horz", [tsA]);
    const root = node("root", "row", "horz", [inner]);
    void root;
    expect(equalizeSplitFor(tsA, "horz")).toBeNull();
  });
});
