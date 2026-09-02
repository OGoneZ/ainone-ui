// 侧栏工作区分组纯逻辑（F-5-1）。零依赖，可单测。
//
// 规则：
//   - 每个工作区一个父级组，其下挂该工作区的 sessions（按 mtime 倒序）
//   - 未匹配任何工作区（workspace_id 为 null）的会话归入「未归组」组
//   - 空工作区仍然占一个父级（F-5-1「空工作区显示为单行父级标题」）
//   - 未归组组仅在非空时产出（不显示空列）

import type { Workspace } from "../config/workspaces";
import type { SessionEntry } from "../config/sessions";

export interface GroupedSessions {
  workspace: Workspace | null; // null = 未归组
  sessions: SessionEntry[];
}

export function groupSessions(
  workspaces: Workspace[],
  sessions: SessionEntry[],
): GroupedSessions[] {
  const wsIds = new Set(workspaces.map((w) => w.id));
  const byId = new Map<string, SessionEntry[]>();
  const ungrouped: SessionEntry[] = [];
  for (const s of sessions) {
    // workspace_id 指向不存在的工作区（已删除）→ 视同未归组，避免会话丢失
    if (s.workspace_id && wsIds.has(s.workspace_id)) {
      const arr = byId.get(s.workspace_id) ?? [];
      arr.push(s);
      byId.set(s.workspace_id, arr);
    } else {
      ungrouped.push(s);
    }
  }
  const sort = (arr: SessionEntry[]) => arr.sort((a, b) => b.mtime_ms - a.mtime_ms);

  const groups: GroupedSessions[] = workspaces.map((w) => ({
    workspace: w,
    sessions: sort(byId.get(w.id) ?? []),
  }));
  if (ungrouped.length > 0) {
    groups.push({ workspace: null, sessions: sort(ungrouped) });
  }
  return groups;
}
