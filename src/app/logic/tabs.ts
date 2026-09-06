// Tab 编排纯逻辑（F-4-4 会话去重）。零依赖，可单测。
//
// 规则：任一时刻一个 sessionId 至多一个打开 Tab（避免同一会话多子进程分叉）。
// 点击历史会话时：已打开 → 激活既有 Tab；否则新开。

/** Tab 种类（P23）：agent = harness ACP 会话（缺省，旧数据无字段）；terminal = 本地 PTY 终端 */
export type TabKind = "agent" | "terminal";

export const TERMINAL_ADAPTER_ID = "terminal";

export interface Tab {
  key: string; // 唯一键（并行 Tab 复用同一会话时也需区分）
  adapterId: string;
  sessionId?: string; // 恢复时带，新建时 undefined
  title: string;
  /** 会话运行目录（工作区 cwd）——新建选工作区/恢复时确定 */
  cwd?: string;
  /** 所属工作区 id；null/undefined = 未归组 */
  workspaceId?: string | null;
  /** Tab 种类（P23）；缺省 = agent（兼容旧 Tab 与旧布局 config） */
  kind?: TabKind;
}

/** 找到已打开某 sessionId 的 Tab；不存在或 sessionId 为空返回 undefined */
export function findTabBySession(tabs: Tab[], sessionId: string | undefined): Tab | undefined {
  if (!sessionId) return undefined;
  return tabs.find((t) => t.sessionId === sessionId);
}

/** 点击历史会话的分派：返回要激活的 key 与新 Tab（若需要新开）。
 *  entry 可带 kind（P23 终端条目）；缺省 agent。 */
export function resolveHistoryOpen(
  tabs: Tab[],
  entry: {
    session_id: string;
    adapter_id: string;
    title: string;
    cwd?: string;
    workspace_id: string | null;
    kind?: TabKind;
  },
  nextKey: string,
): { activateKey: string; newTab: Tab | null } {
  const existing = findTabBySession(tabs, entry.session_id);
  if (existing) return { activateKey: existing.key, newTab: null };
  return {
    activateKey: nextKey,
    newTab: {
      key: nextKey,
      adapterId: entry.adapter_id,
      sessionId: entry.session_id,
      title: entry.title,
      cwd: entry.cwd && entry.cwd.length > 0 ? entry.cwd : undefined,
      workspaceId: entry.workspace_id ?? null,
      kind: entry.kind,
    },
  };
}
