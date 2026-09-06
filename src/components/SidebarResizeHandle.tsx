// F-21-6 侧栏拖宽把手：6px 热区（hover 高亮），pointer capture 拖拽。
// 视觉/交互与 FilePreview 左缘把手一致（.filepreview-resize 模式随迁）。

import { useRef } from "react";
import { dragWidth, type DragState, type ResizeEdge } from "@/lib/sidebarResize";
import { logger } from "@/lib/logger";

interface Props {
  edge: ResizeEdge;
  min: number;
  /** max 取值依赖视窗（sidebarMaxWidth），由调用方传入 getter */
  max: () => number;
  width: number;
  onResize: (w: number) => void;
  /** 拖拽结束（持久化时机） */
  onResizeEnd?: (w: number) => void;
  label: string;
}

export function SidebarResizeHandle({ edge, min, max, width, onResize, onResizeEnd, label }: Props) {
  const dragRef = useRef<DragState | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: width };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    onResize(dragWidth(d, e.clientX, edge, min, max()));
  }
  function onPointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    if (d) {
      const w = dragWidth(d, e.clientX, edge, min, max());
      onResize(w);
      onResizeEnd?.(w);
      logger.debug("layout", "sidebar-resize", { edge, width: w });
    }
  }

  return (
    <div
      className={`sidebar-resize-handle ${edge === "left" ? "handle-left" : "handle-right"}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}
