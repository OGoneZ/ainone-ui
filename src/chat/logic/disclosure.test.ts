// P32 AC-2.8：disclosure 纯函数——块级默认展开 / diff 边沿 / 组默认展开。
// 意图（WHY）：折叠策略必须对「流式 / 收组 / 历史回看」三种场景一致且可单测——
// 行为散在组件内是 P30 抖动问题的温床。

import { describe, it, expect } from "vitest";
import { defaultOpen, hasDiff, shouldAutoOpen, groupDefaultOpen } from "./disclosure";
import type { BlockMsg } from "@/acp/message-log";

const tool = (over: Partial<Extract<BlockMsg, { kind: "tool" }>>): BlockMsg => ({
  kind: "tool",
  toolCallId: "t1",
  title: "T",
  status: "completed",
  content: [],
  ...over,
});

describe("hasDiff / defaultOpen（AC-2.1/2.2/2.7）", () => {
  it("无 diff 工具块（text/空 content）→ defaultOpen false", () => {
    expect(defaultOpen(tool({ content: [{ kind: "text", text: "out" }] }))).toBe(false);
    expect(defaultOpen(tool({ content: [] }))).toBe(false);
    expect(hasDiff(tool({ content: [] }))).toBe(false);
  });

  it("含 diff 工具块 → defaultOpen true（写操作默认展开）", () => {
    const b = tool({ content: [{ kind: "diff", diff: { path: "/a.ts", oldText: "o", newText: "n" } }] });
    expect(hasDiff(b)).toBe(true);
    expect(defaultOpen(b)).toBe(true);
  });

  it("thought：ms 未落 → true（流式中展开）；sealed → false", () => {
    expect(defaultOpen({ kind: "thought", text: "t" })).toBe(true);
    expect(defaultOpen({ kind: "thought", text: "t", ms: 100 })).toBe(false);
  });

  it("text → 恒 false", () => {
    expect(defaultOpen({ kind: "text", text: "x" })).toBe(false);
  });

  it("历史与流式共用同一判定：判定只看块数据（AC-2.7 一致性）", () => {
    // 同一形状的块，无论来源（历史回放/流式到达），默认态一致
    const b = tool({ content: [{ kind: "diff", diff: { path: "/x", oldText: "", newText: "n" } }] });
    const b2 = tool({ toolCallId: "other", content: b.kind === "tool" ? b.content : [] });
    expect(defaultOpen(b)).toBe(defaultOpen(b2));
  });
});

describe("shouldAutoOpen（AC-2.3 边沿）", () => {
  it("无 diff→有 diff 边沿 → true", () => {
    expect(shouldAutoOpen(false, true)).toBe(true);
  });

  it("已有 diff → 重渲染不触发（false→true 才是边沿）", () => {
    expect(shouldAutoOpen(true, true)).toBe(false);
  });

  it("diff 消失 → 永不自动收起", () => {
    expect(shouldAutoOpen(true, false)).toBe(false);
    expect(shouldAutoOpen(false, false)).toBe(false);
  });
});

describe("groupDefaultOpen（AC-2.6 组级策略）", () => {
  it("组内任一 tool 含 diff → 组默认展开", () => {
    const blocks = [
      { kind: "thought" as const, text: "t", ms: 100 },
      tool({ toolCallId: "a", content: [{ kind: "text" as const, text: "x" }] }),
      tool({ toolCallId: "b", content: [{ kind: "diff" as const, diff: { path: "/p", oldText: "", newText: "n" } }] }),
    ];
    expect(groupDefaultOpen(blocks)).toBe(true);
  });

  it("纯思考/无 diff 组 → 默认折叠", () => {
    expect(groupDefaultOpen([{ kind: "thought", text: "t", ms: 1 }])).toBe(false);
    expect(groupDefaultOpen([tool({ toolCallId: "a", content: [] })])).toBe(false);
  });
});
