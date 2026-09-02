// Tab 编排纯逻辑（F-4-4 会话去重）。零依赖，可单测。
//
// 规则：任一时刻一个 sessionId 至多一个打开 Tab（避免同一会话多子进程分叉）。
// 点击历史会话时：已打开 → 激活既有 Tab；否则新开。

export interface Tab {
  key: string; // 唯一键（并行 Tab 复用同一会话时也需区分）
  adapterId: string;
  sessionId?: string; // 恢复时带，新建时 undefined
  title: string;
}

/** 找到已打开某 sessionId 的 Tab；不存在或 sessionId 为空返回 undefined */
export function findTabBySession(tabs: Tab[], sessionId: string | undefined): Tab | undefined {
  if (!sessionId) return undefined;
  return tabs.find((t) => t.sessionId === sessionId);
}

/** 点击历史会话的分派：返回要激活的 key 与新 Tab（若需要新开） */
export function resolveHistoryOpen(
  tabs: Tab[],
  entry: { session_id: string; adapter_id: string; title: string },
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
    },
  };
}
