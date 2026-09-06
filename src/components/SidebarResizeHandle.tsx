// F-21-6 侧栏拖宽把手：8px 热区（hover 高亮），pointer capture 拖拽。
// 视觉/交互与 FilePreview 左缘把手一致（.filepreview-resize 模式随迁）。
//
// p22c 重写（真实环境「点击后无拖拽反应」的根治）：
//   对齐 flexlayout Splitter 的 startDrag 模式——它是同一 WKWebView 里被用户
//   实证可用的唯一拖拽参照（p22b 的 window 级监听 + capture try/catch 吞错版
//   在浏览器 dispatchEvent 实测可用，但真实鼠标无效；两版差异只剩监听目标与
//   capture 纪律，故照抄参照）：
//   ① move/up 挂 document 而非 window（flexlayout 同款；pointer 事件冒泡终点
//      是 document，WKWebView 真实指针流下 window 不可靠）。
//   ② setPointerCapture 不再 try/catch 吞错（flexlayout 同款必须成功）；
//      失败时 warn 落日志而不是静默（Rule 12 fail loud）。
//   ③ 监听动态挂卸：pointerdown 时挂、up/cancel 时卸（参照实现形态），
//      并补 pointercancel 复位（触控/手势中断时 dragRef 残留防护）。

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
  // width 是拖拽期间的快照 props（渲染 props），挂监听时经 ref 转发避免闭包过期
  const widthRef = useRef(width);
  widthRef.current = width;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeEndRef.current = onResizeEnd;

  function onPointerMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    onResizeRef.current(dragWidth(d, e.clientX, edge, min, max()));
  }
  function onPointerUp(e: PointerEvent) {
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
      className={`sidebar-resize-handle ${edge === "left" ? "handle-left" : "handle-right"}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      // 原生 PointerEvent 处理器与 React 合成签名不同（NativePointerEvent），
      // 直接绑 document 级函数会导致类型不匹配——转接一层适配签名
      onPointerMove={(e) => onPointerMove(e.nativeEvent)}
      onPointerUp={(e) => onPointerUp(e.nativeEvent)}
    />
  );
}
