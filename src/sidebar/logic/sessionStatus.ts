// 会话状态推导纯函数（F-6-1）。零依赖，可单测。
//
// 数据源是 P4 外提的 zustand store（F-4-8）：非活跃 Tab 的 busy/pending 也可读。
// 一个 sessionId 至多一个活跃 Tab（F-4-4 去重），但仍按「多 runtime 聚合」建模，
// 兼容未来同会话多视图：多个 runtime 里取最活跃的状态。

export type SessionStatus = "working" | "awaiting_input" | "done" | "idle";

export interface RuntimeSignal {
  busy: boolean;
  /** F-21-4：权限审批状态（null = 无等待）；结构化 perm 非 null 即 awaiting_input */
  perm: { title: string; options: unknown[] } | null;
  hasMessages: boolean;
}

/**
 * 由一组 runtime 信号推导会话状态。优先级：
 *   awaiting_input（等批准/等回复） > working（工作中） > done（有历史/已完成） > idle（空会话）
 * 无任何 runtime（纯历史会话，未打开）→ done。
 */
export function deriveStatus(runtimes: RuntimeSignal[]): SessionStatus {
  if (runtimes.some((r) => r.perm !== null)) return "awaiting_input";
  if (runtimes.some((r) => r.busy)) return "working";
  if (runtimes.some((r) => r.hasMessages)) return "done";
  if (runtimes.length > 0) return "idle";
  return "done";
}

export interface TabRef {
  key: string;
  sessionId?: string;
}

export interface RuntimeRef {
  busy: boolean;
  perm: { title: string; options: unknown[] } | null;
  messages: unknown[];
}

/**
 * 把 tabs + runtime 聚合成 sessionId → RuntimeSignal[]。
 * 新建中的 Tab（无 sessionId）不参与（尚无会话索引）。
 */
export function collectSignals(
  tabs: TabRef[],
  runtime: Record<string, RuntimeRef>,
): Map<string, RuntimeSignal[]> {
  const map = new Map<string, RuntimeSignal[]>();
  for (const t of tabs) {
    if (!t.sessionId) continue;
    const rt = runtime[t.key];
    if (!rt) continue;
    const arr = map.get(t.sessionId) ?? [];
    arr.push({ busy: rt.busy, perm: rt.perm, hasMessages: rt.messages.length > 0 });
    map.set(t.sessionId, arr);
  }
  return map;
}
