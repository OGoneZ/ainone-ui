// P10 分屏编排纯逻辑（F-10-3）。零依赖，可单测。
//
// 快捷键分屏语义（DEC-23）：Ctrl+D 左右切分、Ctrl+Shift+D 上下切分；
// 新窗格 = 同 harness + 同 cwd 的新会话（WARP 终端语义）。
// 只有「编辑器区获得焦点（非输入框）」时响应，避免拦截对话输入。

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
