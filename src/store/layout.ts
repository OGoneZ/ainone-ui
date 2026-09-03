// P10 分屏编排纯逻辑（F-10-3）。零依赖，可单测。
//
// 快捷键分屏语义（DEC-23）：Ctrl+D 左右切分、Ctrl+Shift+D 上下切分；
// 新窗格 = 同 harness + 同 cwd 的新会话（WARP 终端语义）。
// 只有「编辑器区获得焦点（非输入框）」时响应，避免拦截对话输入。
//
// Model 投影：flexlayout Model 是布局 + tab 集合的单一真源，本文件把 Model
// 的 tab 节点（用鸭子类型，不直接依赖 flexlayout runtime，纯函数可 node 单测）
// 投影回业务 Tab 数组与 activeKey。

import type { Tab } from "./tabs";

export type SplitAxis = "row" | "col";

/** 焦点是否落在可编辑控件内（textarea/input/contenteditable 时不拦截快捷键） */
export function inEditable(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (tag === "textarea" || tag === "input") return true;
  return (el as HTMLElement).isContentEditable === true;
}

/** 解析键盘事件是否为分屏快捷键；不是则返回 null */
export function splitShortcut(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): SplitAxis | null {
  if ((e.key ?? "").toLowerCase() !== "d") return null;
  if (!e.ctrlKey && !e.metaKey) return null;
  return e.shiftKey ? "col" : "row";
}

/** 从当前聚焦窗格推导要新建的会话（同 harness 同 cwd，全新会话标题） */
export function resolveSplitTab(src: {
  adapterId: string;
  workspaceId?: string | null;
  cwd?: string;
}): { adapterId: string; workspaceId: string | null; cwd?: string; title: string } {
  return {
    adapterId: src.adapterId,
    workspaceId: src.workspaceId ?? null,
    cwd: src.cwd,
    title: "新会话",
  };
}

// —— Model 投影（flexlayout → 业务 Tab）——
// 鸭子类型，只依赖方法签名，不 import flexlayout runtime，保证 node 环境可单测。
// visitNodes 的参数用 any：flexlayout 的 Model.visitNodes 参数是具体 Node 类，
// 函数参数逆变导致无法直接赋给 NodeLike；用 any 让真实 Model 与测试 duck 对象都兼容。

export interface ModelLike {
  visitNodes(fn: (n: any, level: number) => void): void;
  getActiveTabset():
    | { getSelectedNode(): { getId(): string } | undefined }
    | undefined;
}

/** 把 flexlayout Model 里的全部 tab 节点投影为业务 Tab（顺序 = 访问顺序） */
export function extractTabsFromModel(model: ModelLike): Tab[] {
  const out: Tab[] = [];
  model.visitNodes((n) => {
    if (n.getType() !== "tab") return;
    const cfg = n.getConfig() ?? {};
    const sessionId = typeof cfg.sessionId === "string" && cfg.sessionId.length > 0 ? cfg.sessionId : undefined;
    const cwd = typeof cfg.cwd === "string" && cfg.cwd.length > 0 ? cfg.cwd : undefined;
    const workspaceId = typeof cfg.workspaceId === "string" && cfg.workspaceId.length > 0 ? cfg.workspaceId : null;
    out.push({
      key: n.getId(),
      adapterId: String(cfg.adapterId ?? ""),
      sessionId,
      title: n.getName() || "新会话",
      cwd,
      workspaceId,
    });
  });
  return out;
}

/** 从 Model 推导当前激活 tabKey（无则空串） */
export function activeKeyOf(model: ModelLike): string {
  const sel = model.getActiveTabset()?.getSelectedNode();
  return sel?.getId() ?? "";
}
