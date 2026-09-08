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

/** F-21-4 权限审批引用（与 sessionStore.PermState 结构对齐；此处只判 null） */
export interface RuntimePermRef {
  title: string;
  options: unknown[];
}

/** P32 R2：运行时状态信号投影——App 层用 useShallow 提取标量子集，
 *  不再传整个 runtime（messages 数组引用随流式提交每帧变化会打穿订阅等值） */
export interface RuntimeSignalRef {
  busy: boolean;
  perm: RuntimePermRef | null;
  hasMessages: boolean;
}

/**
 * 把 tabs + 状态信号聚合为 sessionId → RuntimeSignal[]。
 * 新建中的 Tab（无 sessionId）不参与（尚无会话索引）。
 */
export function collectSignals(
  tabs: TabRef[],
  signalsByTab: Record<string, RuntimeSignalRef>,
): Map<string, RuntimeSignal[]> {
  const map = new Map<string, RuntimeSignal[]>();
  for (const t of tabs) {
    if (!t.sessionId) continue;
    const sig = signalsByTab[t.key];
    if (!sig) continue;
    const arr = map.get(t.sessionId) ?? [];
    arr.push({ busy: sig.busy, perm: sig.perm, hasMessages: sig.hasMessages });
    map.set(t.sessionId, arr);
  }
  return map;
}
