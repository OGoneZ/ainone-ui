// F-21-6 侧栏拖宽把手：8px 热区（hover 高亮），pointer capture 拖拽。
// 视觉/交互与 FilePreview 左缘把手一致（.filepreview-resize 模式随迁）。
//
// p22c 对齐 flexlayout Splitter startDrag 后仍有两处真实环境缺陷，p22d 补齐：
//  ① 拖拽粘滞（真实 WKWebView 实测：松手后宽度持续跟随鼠标）——pointermove/pointerup
//     缺 preventDefault()，capture 后 WKWebView 原生拖选/滚动手势接管指针流，
//     pointerup 不再派发 → dragRef 永不清空。flexlayout 的 pointerMove/pointerUp
//     均显式 preventDefault（index.js:4379-4391），照抄。
//  ② 触屏/触控板手势从 touchstart 起手会绕过 pointer 拦截——flexlayout 对拖拽元素
//     挂 touchstart {passive:false} + preventDefault + stopImmediatePropagation
//     （index.js:4789-4808），同款防御。
//  元素级 onPointerMove/onPointerUp 转接保留：capture 重定向后事件 target 是把手，
//  与 document 监听双通道都指向同一处理器（幂等：dragRef 空即 no-op）。

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
  // width 是拖拽期间的快照 props（渲染 props），挂监听时经 ref 转发避免闭包过期
  const widthRef = useRef(width);
  widthRef.current = width;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeEndRef.current = onResizeEnd;
  const handleRef = useRef<HTMLDivElement | null>(null);

  function onPointerMove(e: PointerEvent) {
    if (!dragRef.current) return;
    // preventDefault 抑制 WKWebView 原生拖选/滚动手势接管指针流（粘滞根因，见头注①）
    e.preventDefault();
    const d = dragRef.current;
    onResizeRef.current(dragWidth(d, e.clientX, edge, min, max()));
  }
  function onPointerUp(e: PointerEvent) {
    e.preventDefault();
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    document.body.style.userSelect = "";
    const w = dragWidth(d, e.clientX, edge, min, max());
    onResizeRef.current(w);
    onResizeEndRef.current?.(w);
    detachListeners();
    logger.debug("layout", "sidebar-resize", { edge, width: w });
  }
  function onPointerCancel() {
    // 手势/触控被系统中断：复位状态但不上报宽度（未完成的拖拽不落盘）
    dragRef.current = null;
    document.body.style.userSelect = "";
    detachListeners();
  }
  function detachListeners() {
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerCancel);
  }

  // 触屏起手防御（flexlayout 同款）：touchstart 不拦会被系统手势接管，绕过 pointer 流
  useEffect(() => {
    const el = handleRef.current;
    if (!el) return;
    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    return () => el.removeEventListener("touchstart", onTouchStart);
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    // 拖拽全程禁文本选中（拖过聊天区不选中文字）；up/cancel 恢复
    document.body.style.userSelect = "none";
    dragRef.current = { startX: e.clientX, startW: widthRef.current };
    // flexlayout 同款：capture 必须成功（跨元素/惯性拖拽的根基），失败落日志
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch (err) {
      logger.warn("layout", "sidebar-resize-capture-failed", { err: String(err) });
    }
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
  }

  return (
    <div
      ref={handleRef}
      className={`sidebar-resize-handle ${edge === "left" ? "handle-left" : "handle-right"}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      // 原生 PointerEvent 处理器与 React 合成签名不同（NativePointerEvent），
      // 直接绑 document 级函数会导致类型不匹配——转接一层适配签名
      onPointerMove={(e) => onPointerMove(e.nativeEvent)}
      onPointerUp={(e) => onPointerUp(e.nativeEvent)}
      onPointerCancel={() => onPointerCancel()}
    />
  );
}
