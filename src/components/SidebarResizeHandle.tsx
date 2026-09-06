// F-21-6 侧栏拖宽把手：8px 热区（hover 高亮），pointer capture 拖拽。
// 视觉/交互与 FilePreview 左缘把手一致（.filepreview-resize 模式随迁）。
//
// p22b 实测修复两处（真实交互不可用的根因）：
//  ① 热区被裁：旧定位 right/left:-3px 伸出容器外，被 .sidebar{overflow-y:auto}/
//     .rightrail{overflow:hidden} 裁掉，热区只剩 3px 且边缘 1px 落到 aside 本体——
//     用户瞄准边框拖拽必落空。改贴内缘（right/left:0）+ 宽 6→8px。
//  ② capture 脆弱：setPointerCapture 在部分环境（synthetic 事件 / WKWebView 时序）
//     抛 NotFoundError，异常中断 dragRef 赋值 → 拖拽静默失效。改为
//     window 级 move/up 监听（capture 只是优化，不再依赖），down 里 try/catch。

import { useEffect, useRef } from "react";
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

  useEffect(() => {
    // window 级 move/up：不依赖 pointer capture 也能全程跟踪（capture 失败的兜底）。
    // 挂载期常驻（dragRef 为空时 no-op），避免 down/up 间动态挂卸的时序竞态。
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      onResize(dragWidth(d, e.clientX, edge, min, max()));
    }
    function onUp(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      document.body.style.userSelect = "";
      const w = dragWidth(d, e.clientX, edge, min, max());
      onResize(w);
      onResizeEnd?.(w);
      logger.debug("layout", "sidebar-resize", { edge, width: w });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // 拖拽中失焦（Alt+Tab 等）也复位，防 dragRef 残留导致下次 hover 抖动
    const onBlur = () => onUp(new PointerEvent("pointerup"));
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edge, min, onResize, onResizeEnd]);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    // 拖拽全程禁文本选中（拖过聊天区不选中文字）；up/blur 恢复
    document.body.style.userSelect = "none";
    dragRef.current = { startX: e.clientX, startW: width };
    // capture 优先（跨 iframe/惯性更稳），失败不致命——window 监听已兜底
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className={`sidebar-resize-handle ${edge === "left" ? "handle-left" : "handle-right"}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
    />
  );
}
