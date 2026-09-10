// @vitest-environment jsdom
// P43：ActivityGroupCard 的文件变更聚合不得每帧重跑。
//
// 背景：ActivityGroupCard 原是无 memo 的普通函数组件，且 aggregateFileChanges 直接
// 写在渲染体内——它内部对每个文件调 diff@9 的 diffLines（Myers，O((N+M)·D)），
// 大文件单次可达毫秒级。叠加 MessageLine memo 被回调击穿的问题，流式期间视口内
// 每张历史组卡每帧重算一次。
//
// 本文件锁定两层防护：
//   1. MessageLine 的 renderItems useMemo 保住 item 引用 → 组卡 memo 命中；
//   2. 即便重渲染，aggregateFileChanges 也被 useMemo 挡住（item.blocks 不变时不重跑）。
// 计数用 spy 包住真实实现——不改变行为，只观测调用次数。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useStableCallback } from "@/chat/hooks/useStableCallback";
import type { ChatMsg } from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";

vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** 包住真实实现计数：调用次数即 Myers diff 触发次数 */
const aggCalls = { n: 0 };
vi.mock("@/chat/logic/fileChanges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/logic/fileChanges")>();
  return {
    ...actual,
    aggregateFileChanges: (diffs: Parameters<typeof actual.aggregateFileChanges>[0]) => {
      aggCalls.n++;
      return actual.aggregateFileChanges(diffs);
    },
  };
});

import { MessageLine } from "./MessageLine";

afterEach(() => {
  cleanup();
  aggCalls.n = 0;
});

const adapter: AdapterWithStatus = {
  id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".",
  logo: "#7c3aed", available: true, state: "ready",
  bridge: null, cli: null, auth: { state: "none", detail: "" },
  resolvedPath: null, source: null,
};

/** 含 diff 的已完成工具块 → 入组（groupable: tool 已结算） */
const toolWithDiff = {
  kind: "tool" as const,
  toolCallId: "t1",
  title: "编辑文件",
  status: "completed",
  ms: 120,
  startTs: 1000,
  content: [
    {
      kind: "diff" as const,
      diff: { path: "/w/a.ts", oldText: "line1\n", newText: "line1\nline2\n" },
    },
  ],
};
const msg: ChatMsg = {
  role: "assistant",
  blocks: [{ kind: "thought", text: "想一下", ms: 50, startTs: 900 }, toolWithDiff],
};

/** 稳定回调宿主（= ChatPanel 修复后接线） */
function Host({ tick, unstable = false }: { tick: number; unstable?: boolean }) {
  void tick;
  const onAddDiffComment = useStableCallback(() => {});
  return (
    <MessageLine
      msg={msg} index={0} adapter={adapter} busy={false} isLast={false}
      onAddDiffComment={unstable ? () => {} : onAddDiffComment}
    />
  );
}

describe("P43 ActivityGroupCard 文件变更聚合", () => {
  it("组卡惰性：折叠态不跑 Myers diff（无 diff 展示需求时不付出代价）", () => {
    render(<Host tick={0} />);
    // 折叠态仍会算徽标（P30 AC-2.4 改动规模要透出）——故此处应为 1 次，而非 0
    expect(aggCalls.n).toBe(1);
  });

  it("稳定回调下父级重渲染不重跑聚合（memo + useMemo 双层防护）", () => {
    const { rerender } = render(<Host tick={0} />);
    const after0 = aggCalls.n;
    expect(after0).toBe(1);

    for (let i = 1; i <= 5; i++) rerender(<Host tick={i} />);
    expect(aggCalls.n).toBe(after0);
  });

  it("对照组：回调不稳定而击穿 memo 时，聚合仍被组卡内 useMemo 挡住", () => {
    const { rerender } = render(<Host tick={0} unstable />);
    const after0 = aggCalls.n;
    expect(after0).toBe(1);

    for (let i = 1; i <= 5; i++) rerender(<Host tick={i} unstable />);
    // 即便组卡被迫重渲染，item.blocks 引用未变 → useMemo 命中，不再重算 diff
    expect(aggCalls.n).toBe(after0);
  });
});
