import { describe, it, expect } from "vitest";
import { applyEvent, newTurn } from "./turn";
import type { Outgoing } from "./session-core";

const tool = (id: string): Outgoing => ({
  type: "tool_call",
  toolCallId: id,
  title: "read",
  status: "pending",
  content: [],
});

describe("turn 事件累加（F-4-2 thinking 折叠）", () => {
  it("agent_text 连续 chunk 合并为单一 text 块", () => {
    let t = 0;
    const now = () => ++t;
    let acc = newTurn();
    acc = applyEvent(acc, { type: "agent_text", text: "你" }, now);
    acc = applyEvent(acc, { type: "agent_text", text: "好" }, now);
    expect(acc.blocks).toEqual([{ kind: "text", text: "你好" }]);
  });

  it("thinking：开始时记时，正文出现即封口为「已思考 N 秒」", () => {
    let t = 0;
    const now = () => ++t;
    let acc = newTurn();
    acc = applyEvent(acc, { type: "agent_thought", text: "想" }, now); // now→1，记时 1
    acc = applyEvent(acc, { type: "agent_thought", text: "法" }, now); // 非首段，不推进时钟
    acc = applyEvent(acc, { type: "agent_text", text: "回复" }, now); // now→2，正文封口 ms=2-1=1
    expect(acc.blocks[0]).toEqual({ kind: "thought", text: "想法", ms: 1 });
    expect(acc.blocks[1]).toEqual({ kind: "text", text: "回复" });
  });

  it("turn_stop 封口未结束的 thinking", () => {
    let t = 0;
    const now = () => ++t;
    let acc = newTurn();
    acc = applyEvent(acc, { type: "agent_thought", text: "一段" }, now); // 记时 1
    acc = applyEvent(acc, { type: "turn_stop", stopReason: "end_turn" }, now); // now→2，ms=1
    expect(acc.blocks).toEqual([{ kind: "thought", text: "一段", ms: 1 }]);
  });

  it("工具调用封口 thinking，tool_update 按 id 改写", () => {
    let t = 0;
    const now = () => ++t;
    let acc = newTurn();
    acc = applyEvent(acc, { type: "agent_thought", text: "查" }, now); // 记时 1
    acc = applyEvent(acc, tool("a"), now); // now→2，封口 ms=1
    acc = applyEvent(
      acc,
      { type: "tool_update", toolCallId: "a", status: "completed", content: [{ kind: "text", text: "ok" }] },
      now,
    );
    expect(acc.blocks[0]).toEqual({ kind: "thought", text: "查", ms: 1 });
    expect((acc.blocks[1] as { status: string }).status).toBe("completed");
    expect((acc.blocks[1] as { content: unknown[] }).content).toHaveLength(1);
  });

  it("F-16-2（DEC-49）：工具收尾封口 ms = now - startTs", () => {
    let t = 100;
    const now = () => (t += 50);
    let acc = newTurn();
    acc = applyEvent(acc, tool("a"), now); // turnStart = 150（首个事件），startTs = 200
    expect((acc.blocks[0] as { startTs?: number }).startTs).toBe(200);
    t += 400; // 模拟 400ms 后收尾 → now 返回 650
    acc = applyEvent(
      acc,
      { type: "tool_update", toolCallId: "a", status: "completed", content: [] },
      now,
    );
    const blk = acc.blocks[0] as { ms?: number };
    expect(blk.ms).toBe(450);
  });

  it("F-16-2：非终态 update 不封口；error 也封口", () => {
    let t = 0;
    const now = () => (t += 10);
    let acc = newTurn();
    acc = applyEvent(acc, tool("a"), now); // startTs 10
    acc = applyEvent(acc, { type: "tool_update", toolCallId: "a", status: "in_progress", content: [] }, now);
    expect((acc.blocks[0] as { ms?: number }).ms).toBeUndefined();
    t += 10; // 收尾时刻 = startTs + 20
    acc = applyEvent(acc, { type: "tool_update", toolCallId: "a", status: "error", content: [] }, now);
    const blk = acc.blocks[0] as { ms?: number };
    expect(blk.ms).toBe(20);
  });

  // P30 AC-1.2：协议 kind/rawInput 落块级 toolKind/rawInput；tool_update 不携带 → 保留旧值
  it("P30：tool_call 带 kind/rawInput 入块（toolKind）；tool_update 不携带 → 保留旧值", () => {
    let acc = newTurn();
    acc = applyEvent(
      acc,
      { type: "tool_call", toolCallId: "a", title: "Terminal", status: "pending", kind: "execute", rawInput: { command: "ls" }, content: [] },
      () => 1,
    );
    // 块级 kind 是块类型判别符（恒 "tool"），协议 kind 落在 toolKind——不被覆盖
    expect(acc.blocks[0].kind).toBe("tool");
    expect((acc.blocks[0] as { toolKind?: string }).toolKind).toBe("execute");
    expect((acc.blocks[0] as { rawInput?: unknown }).rawInput).toEqual({ command: "ls" });

    // update 只带 status/content：toolKind/rawInput 保留
    acc = applyEvent(acc, { type: "tool_update", toolCallId: "a", status: "completed", content: [] }, () => 2);
    const blk = acc.blocks[0] as { toolKind?: string; rawInput?: unknown };
    expect(blk.toolKind).toBe("execute");
    expect(blk.rawInput).toEqual({ command: "ls" });

    // update 带新 toolKind/rawInput：覆盖
    acc = applyEvent(
      acc,
      { type: "tool_update", toolCallId: "a", status: "completed", kind: "edit", rawInput: { file_path: "/x" }, content: [] },
      () => 3,
    );
    const blk2 = acc.blocks[0] as { toolKind?: string; rawInput?: unknown };
    expect(blk2.toolKind).toBe("edit");
    expect(blk2.rawInput).toEqual({ file_path: "/x" });
  });

  // P30 AC-1.3：协议失败终态 failed 也封口 ms（error 为本地历史值，另行覆盖）
  it("P30：failed 终态封口 ms", () => {
    let t = 0;
    const now = () => (t += 10);
    let acc = newTurn();
    acc = applyEvent(acc, tool("a"), now); // 首事件 turnStart=10，startTs=20
    // 收尾 update：withStart 已落定不再调 now；updateTool 内封口调 now()=30 → ms = 30 - 20 = 10
    acc = applyEvent(acc, { type: "tool_update", toolCallId: "a", status: "failed", content: [] }, now);
    expect((acc.blocks[0] as { ms?: number }).ms).toBe(10);
  });

  it("两段 thinking 各自独立封口（工具间穿插）", () => {
    let t = 0;
    const now = () => ++t;
    let acc = newTurn();
    acc = applyEvent(acc, { type: "agent_thought", text: "A" }, now); // 记时 1
    acc = applyEvent(acc, tool("x"), now); // now→2，封 A ms=1
    acc = applyEvent(acc, { type: "agent_thought", text: "B" }, now); // now→3，记时 3
    acc = applyEvent(acc, { type: "agent_text", text: "正文" }, now); // now→4，封 B ms=1
    expect(acc.blocks.map((b) => b.kind)).toEqual(["thought", "tool", "thought", "text"]);
    expect((acc.blocks[0] as { ms: number }).ms).toBe(1);
    expect((acc.blocks[2] as { ms: number }).ms).toBe(1);
  });

  it("available_commands / error 不改动 turn 内容", () => {
    let t = 0;
    const now = () => ++t;
    let acc = newTurn();
    acc = applyEvent(acc, { type: "agent_text", text: "x" }, now);
    const before = acc;
    acc = applyEvent(acc, { type: "available_commands", commands: [{ name: "model", description: "d" }] }, now);
    acc = applyEvent(acc, { type: "error", message: "boom" }, now);
    expect(acc).toEqual(before);
  });
});
