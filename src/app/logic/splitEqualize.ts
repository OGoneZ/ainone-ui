// P16 F-16-5 连续分屏等分（DEC-52）。鸭子类型不 import flexlayout runtime，
// node 环境可单测。
//
// 为什么需要：flexlayout 的 RowNode.drop / TabSetNode.drop 对新节点用
// 「切割现有重量」策略（size/3、weight/2），连续分屏会不断二分而不是等分。
// 修法：每次分屏落点确定后，对**新增节点所在层级的同向 row**执行
// Actions.adjustWeights 均分其直接子节点。
//
// findOwningRow 语义：从 tabset 出发向上找第一个「方向 != 给定方向」的祖先
// ——同向分屏（如左右 + 左右）的新 tabset 落在该祖先的 children 里；反向
// 分屏（左右 + 上下）时新 tabset 落在一个新建的反向 row 里，其子节点 =
// [旧 tabset, 新 tabset]，同样适用「children 等分」。

export interface LayoutNodeLike {
  getId(): string;
  getType(): string;
  getParent(): LayoutNodeLike | undefined;
  getChildren(): LayoutNodeLike[];
  getOrientation(): { getName(): string };
  getWeight(): number;
}

/** 从 tabset 向上找第一个方向异于 given 的祖先 row（同向嵌套折叠） */
export function findOwningRow(
  node: LayoutNodeLike,
  orientation: string,
): LayoutNodeLike | undefined {
  let cur: LayoutNodeLike | undefined = node;
  while (cur) {
    const parent = cur.getParent();
    if (!parent) return undefined;
    if (parent.getType() === "row" && parent.getOrientation().getName() !== orientation) {
      return parent;
    }
    cur = parent;
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
