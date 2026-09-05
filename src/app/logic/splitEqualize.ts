// P17 F-17-1 连续分屏等分（修正 DEC-52）。鸭子类型不 import flexlayout runtime，
// node 环境可单测。
//
// 为什么需要：flexlayout 的 RowNode.drop / TabSetNode.drop 对新节点用
// 「切割现有重量」策略（size/3、weight/2），连续分屏会不断二分而不是等分。
// 修法：每次分屏落点确定后，对「新增 tabset 的父 row」执行 adjustWeights 均分。
//
// P17 修正：owner row 的找法。上一版找「第一个方向异于分屏方向的祖先 row」，
// 但常见布局里根 row 本身就是同向（horz）——向上永远找不到反向祖先 → 静默跳过，
// 表现为实测的 1/2 + 1/4 + 1/4 二分链。正确语义：**同向分屏发生在 tabset 的
// 直接父 row 层级**（flexlayout TabSetNode.drop 同向分支把新 tabset 加进
// parentRow.children），所以 owner = 最近的可均分祖先：
//   1. tabset 的直接父 row（无论方向）——覆盖同向（新 tabset 落这里）
//   2. 若父 row 只有 1 个子节点（单 tabset 直挂根），向上取根 row
// 均分只作用于「本次新增节点的父层」，不动其它层级。

export interface LayoutNodeLike {
  getId(): string;
  getType(): string;
  getParent(): LayoutNodeLike | undefined;
  getChildren(): LayoutNodeLike[];
  getOrientation(): { getName(): string };
  getWeight(): number;
}

/**
 * 从 tabset 向上找「可均分的 row」：优先直接父 row；其 children < 2 时
 * 继续向上（单子节点直挂链）。找不到（无父/到根仍 <2）→ undefined。
 */
export function findOwningRow(
  node: LayoutNodeLike,
  _orientation: string,
): LayoutNodeLike | undefined {
  let cur = node.getParent();
  while (cur) {
    if (cur.getType() === "row" && cur.getChildren().length >= 2) {
      return cur;
    }
    cur = cur.getParent();
  }
  return undefined;
}

/**
 * 计算均分动作参数：{rowId, weights}。
 * children 不足 2 个（无分屏）→ null。
 */
export function equalizeRowChildren(
  row: LayoutNodeLike,
): { rowId: string; weights: number[] } | null {
  const children = row.getChildren();
  if (children.length < 2) return null;
  const even = 100 / children.length;
  return { rowId: row.getId(), weights: children.map(() => even) };
}

/** 组合：tabset + 分屏方向 → adjustWeights 参数（无操作返回 null） */
export function equalizeSplitFor(
  tabset: LayoutNodeLike,
  orientation: string,
): { rowId: string; weights: number[] } | null {
  const row = findOwningRow(tabset, orientation);
  if (!row) return null;
  return equalizeRowChildren(row);
}
