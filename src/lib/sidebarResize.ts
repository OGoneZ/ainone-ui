// F-21-6 侧栏拖宽把手：pointer capture 拖拽改宽（FilePreview 左缘把手同款模式）。
//
// 自研评估（P13 §5 金标准）：clamp + 两个 pointer 事件 ~15 行，引入
// re-resizable/react-resizable-panels 是负资产（包体 + API 对齐成本 > 收益）。
// 纯几何抽出便于单测；持久化由调用方决定（localStorage）。

export interface DragState {
  /** pointerdown 时的 clientX */
  startX: number;
  /** pointerdown 时的宽度 */
  startW: number;
}

/** 拖拽方向：edge="left"（把手在左缘，向左拖 = 增宽）；edge="right"（右缘，向右拖 = 增宽） */
export type ResizeEdge = "left" | "right";

/** 拖宽计算：dir 决定 delta 符号；结果 clamp 到 [min, max] */
export function dragWidth(
  d: DragState,
  currentX: number,
  edge: ResizeEdge,
  min: number,
  max: number,
): number {
  const delta = edge === "left" ? d.startX - currentX : currentX - d.startX;
  return Math.min(max, Math.max(min, d.startW + delta));
}

/** 宽度 clamp（读持久化/resize 窗口时兜底） */
export function clampWidth(w: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, w));
}

/** 默认上限：min(520, 40% 视窗宽)，随窗口缩放 */
export function sidebarMaxWidth(vw = window.innerWidth): number {
  return Math.min(520, Math.floor(vw * 0.4));
}
