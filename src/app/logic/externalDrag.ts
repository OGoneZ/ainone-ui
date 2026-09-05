// F-15-3 侧栏会话拖入布局：载荷暂存 + tab 组装（DEC-43）。零 React 依赖，可单测。
//
// 为什么用模块级变量而不是 dataTransfer：flexlayout 内部拖拽以
// dataTransfer 的 "text/plain --flexlayout--" 作为识别通道，外部载荷若
// 写入同通道可能污染其判定；HTML5 dataTransfer 在 dragover 阶段也读不到
// 自定义类型（protected 模式）。模块级暂存 + dragstart/drop 生命周期即够。

import type { Tab } from "./tabs";

/** 拖拽载荷：侧栏会话行的最小投影 */
export interface ExternalDragPayload {
  sessionId: string;
  adapterId: string;
  title: string;
  cwd: string;
  workspaceId: string | null;
}

let pending: ExternalDragPayload | null = null;

/** dragstart 时暂存载荷（同一时刻至多一个拖拽） */
export function setExternalDragPayload(p: ExternalDragPayload): void {
  pending = p;
}

/** drop 时取出载荷并清空；无暂存返回 null */
export function takeExternalDragPayload(): ExternalDragPayload | null {
  const p = pending;
  pending = null;
  return p;
}

/** dragend 兜底清理（drop 未发生时防泄漏） */
export function clearExternalDragPayload(): void {
  pending = null;
}

/** 暂存是否非空（测试与 dragover 判定用） */
export function hasExternalDragPayload(): boolean {
  return pending !== null;
}

/** 载荷 → 业务 Tab（key 由调用方分配，这里只做字段投影与净化） */
export function payloadToTab(p: ExternalDragPayload, key: string): Tab {
  return {
    key,
    adapterId: p.adapterId,
    sessionId: p.sessionId,
    title: p.title,
    cwd: p.cwd && p.cwd.length > 0 ? p.cwd : undefined,
    workspaceId: p.workspaceId ?? null,
  };
}
