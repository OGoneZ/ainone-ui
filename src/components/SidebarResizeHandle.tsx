// F-21-6 侧栏拖宽把手：8px 热区（hover 高亮），双事件流拖拽。
// 视觉/交互与 FilePreview 左缘把手一致（.filepreview-resize 模式随迁）。
//
// p22f 终版（WKWebView 事件流黑匣子，p20m 同根问题第二次踩坑）：
//   macOS WKWebView 对原生鼠标输入**不派发 pointer events**（黑匣子实锤：
//   trusted 输入只有 mousedown/mousemove/mouseup/click；PointerEvent 构造器
//   存在但仅合成派发可用，GUI 验收因此被骗三轮）。p22b/c/d 三版全在 pointer
//   流上做文章（window 监听/document 监听/capture 纪律/preventDefault），
//   真实鼠标下 onPointerDown 从未触发——「拖拽完全没反应」的直接根因。
//   「偶发粘滞」= 触控板按压路径走了 pointer 流但 pointerup 丢失（capture
//   劫持全窗口点击，400 条 trusted pointermove 取证）。
//   终版双通道（p20m 同款纪律）：
//   ① down：mousedown（原生必发）+ pointerdown（触屏环境），200ms 去重窗；
//   ② move/up：mousemove/mouseup 与 pointermove/pointerup 双流并行，
//      dragRef 空则 no-op——双流同帧到达幂等（宽度由 startX 差值决定）；
//   ③ capture 完全弃用：WKWebView 下 pointer capture 会把后续全窗口输入
//      重定向到把手（粘滞态取证），弊远大于利；mousemove/up 挂 window，
//      拖出窗口外仍跟踪（原生桌面拖拽惯例），blur 兜底复位；
//   ④ touch-action: none 进 CSS（flexlayout splitter 同款，防手势判定分流）。

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
  const handleRef = useRef<HTMLDivElement | null>(null);
  // 渲染 props 经 ref 转发：window 级监听闭包不随重渲染重建，读 ref 拿最新值
  const widthRef = useRef(width);
  widthRef.current = width;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeEndRef.current = onResizeEnd;
  // max 是调用方 inline arrow（App/RightRail 每渲染新引用）——经 ref 转发，
  // effect 依赖不再含 max（否则每帧重跑，cleanup 的 detach 会拆掉拖拽中的 window 监听：
  // 症状即「拖动约 10px 就断，必须松手重新按」——p22g 真机取证实锤）
  const maxRef = useRef(max);
  maxRef.current = max;
  // p20m 同款：mousedown/pointerdown 同一按压双发时去重
  const lastDownAt = useRef(0);

  function applyWidth(clientX: number) {
    const d = dragRef.current;
    if (!d) return;
    onResizeRef.current(dragWidth(d, clientX, edge, min, maxRef.current()));
  }

  function onWindowMove(e: MouseEvent | PointerEvent) {
    if (!dragRef.current) return;
    // 拖拽全程抑制文本选中等默认行为（mouse 流无 capture 兜着，preventDefault 必须）
    e.preventDefault();
    applyWidth(e.clientX);
  }

  function onWindowUp(e: MouseEvent | PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    document.body.style.userSelect = "";
    detach();
    const w = dragWidth(d, e.clientX, edge, min, maxRef.current());
    onResizeRef.current(w);
    onResizeEndRef.current?.(w);
    logger.debug("layout", "sidebar-resize", { edge, width: w });
  }

  function onWindowCancel() {
    // 手势/系统中断：复位但不上报宽度（未完成的拖拽不落盘）
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.userSelect = "";
    detach();
  }

  function attach() {
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowCancel);
    window.addEventListener("blur", onWindowCancel);
  }
  function detach() {
    window.removeEventListener("mousemove", onWindowMove);
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("mouseup", onWindowUp);
    window.removeEventListener("pointerup", onWindowUp);
    window.removeEventListener("pointercancel", onWindowCancel);
    window.removeEventListener("blur", onWindowCancel);
  }

  function startDrag(clientX: number) {
    document.body.style.userSelect = "none";
    dragRef.current = { startX: clientX, startW: widthRef.current };
    attach();
  }

  // 常驻双通道 down 监听（move/up 动态挂卸）。p20m：WKWebView 原生鼠标
  // 只走 mousedown；触屏只走 pointerdown；两者都发的环境用 200ms 去重。
  useEffect(() => {
    const el = handleRef.current;
    if (!el) return;
    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return;
      const now = Date.now();
      if (now - lastDownAt.current < 200) return;
      lastDownAt.current = now;
      e.preventDefault();
      startDrag(e.clientX);
    }
    function onPointerDown(e: PointerEvent) {
      const now = Date.now();
      if (now - lastDownAt.current < 200) return;
      lastDownAt.current = now;
      e.preventDefault();
      startDrag(e.clientX);
    }
    el.addEventListener("mousedown", onMouseDown);
    el.addEventListener("pointerdown", onPointerDown);
    // 触屏起手防御（flexlayout 同款）：touchstart 不拦会被系统手势接管绕过 mouse 流
    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    return () => {
      el.removeEventListener("mousedown", onMouseDown);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("touchstart", onTouchStart);
      detach(); // 卸载时若拖拽残留，一并清 window 监听
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  // p22g：依赖不含 max（inline arrow 每渲染新引用 → effect 每帧重跑 → cleanup detach
  // 拆掉拖拽中的 window move/up 监听 → 拖 10px 即断）。max 经 maxRef 转发。
  }, [edge, min]);

  return (
    <div
      ref={handleRef}
      className={`sidebar-resize-handle ${edge === "left" ? "handle-left" : "handle-right"}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
    />
  );
}
