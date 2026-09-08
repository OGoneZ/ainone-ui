// session-core 协议层离线单测：验证 dispatchUpdate / toToolContent / toCommandWord
// 对 ACP SessionUpdate 的转换正确性。构造输入用 as unknown as 断言（SDK 生成类型结构繁琐，
// 测试只关心我们关心的字段）。这让协议层无需真实 harness 即可离线回归。

import { describe, it, expect } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { dispatchUpdate, toToolContent, toCommandWord, type Outgoing } from "./session-core";

// 构造一个「形状够用」的 SessionNotification，字段不足处靠 as unknown as 穿透
function notif(update: object): acp.SessionNotification {
  return { sessionId: "s", update } as unknown as acp.SessionNotification;
}

function collect(n: acp.SessionNotification): Outgoing[] {
  const out: Outgoing[] = [];
  dispatchUpdate(n, (e) => out.push(e));
  return out;
}

describe("session-core · dispatchUpdate", () => {
  it("agent_message_chunk(text) → agent_text", () => {
    const r = collect(
      notif({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } }),
    );
    expect(r).toEqual([{ type: "agent_text", text: "你好" }]);
  });

  it("agent_message_chunk 非文本（如 image）不产生 agent_text", () => {
    const r = collect(
      notif({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x" } }),
    );
    expect(r).toEqual([]);
  });

  it("agent_thought_chunk(text) → agent_thought", () => {
    const r = collect(
      notif({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "思考" } }),
    );
    expect(r).toEqual([{ type: "agent_thought", text: "思考" }]);
  });

  it("tool_call → tool_call（含 status 与 content 透传）", () => {
    const r = collect(
      notif({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read_file",
        status: "pending",
        content: [{ type: "content", content: { type: "text", text: "abc" } }],
      }),
    );
    expect(r).toEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        title: "read_file",
        status: "pending",
        content: [{ kind: "text", text: "abc" }],
      },
    ]);
  });

  it("tool_call_update → tool_update", () => {
    const r = collect(
      notif({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [],
      }),
    );
    expect(r).toEqual([{ type: "tool_update", toolCallId: "t1", status: "completed", content: [] }]);
  });

  // P30 AC-1.1：kind/rawInput 透传——带了就带键，不带就干净缺省
  it("tool_call 带 kind/rawInput → 透传同值；不带 → 字段缺省（无 null 垃圾）", () => {
    const withFields = collect(
      notif({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Terminal",
        status: "pending",
        kind: "execute",
        rawInput: { command: "git status" },
        content: [],
      }),
    );
    expect(withFields).toEqual([
      {
        type: "tool_call",
        toolCallId: "t1",
        title: "Terminal",
        status: "pending",
        kind: "execute",
        rawInput: { command: "git status" },
        content: [],
      },
    ]);

    const withoutFields = collect(
      notif({ sessionUpdate: "tool_call", toolCallId: "t2", title: "Task", status: "pending", content: [] }),
    );
    expect(withoutFields).toEqual([
      { type: "tool_call", toolCallId: "t2", title: "Task", status: "pending", content: [] },
    ]);
    expect("kind" in withoutFields[0]).toBe(false);
    expect("rawInput" in withoutFields[0]).toBe(false);
  });

  it("tool_call_update 带 kind/rawInput → 透传", () => {
    const r = collect(
      notif({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
        kind: "edit",
        rawInput: { file_path: "/a.ts" },
        content: [],
      }),
    );
    expect(r).toEqual([
      { type: "tool_update", toolCallId: "t1", status: "failed", kind: "edit", rawInput: { file_path: "/a.ts" }, content: [] },
    ]);
  });

  it("usage_update → usage（含 cost 数值 / 无 cost → null）", () => {
    expect(
      collect(notif({ sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount: 1.5, currency: "USD" } })),
    ).toEqual([{ type: "usage", used: 100, size: 1000, cost: 1.5 }]);

    expect(
      collect(notif({ sessionUpdate: "usage_update", used: 100, size: 1000 })),
    ).toEqual([{ type: "usage", used: 100, size: 1000, cost: null }]);
  });

  it("plan → plan（entries 透传 content/status/priority）", () => {
    expect(
      collect(notif({ sessionUpdate: "plan", entries: [{ content: "a", status: "pending", priority: "high" }] })),
    ).toEqual([{ type: "plan", entries: [{ content: "a", status: "pending", priority: "high" }] }]);
  });

  // P32d：session_info_update（agent 生成会话标题/更新时间）
  it("session_info_update → session_info（title/updatedAt 透传，null → undefined）", () => {
    expect(
      collect(notif({ sessionUpdate: "session_info_update", title: "修复登录 bug", updatedAt: "2026-09-08T12:00:00Z" })),
    ).toEqual([{ type: "session_info", title: "修复登录 bug", updatedAt: "2026-09-08T12:00:00Z" }]);
    expect(
      collect(notif({ sessionUpdate: "session_info_update", title: null, updatedAt: null })),
    ).toEqual([{ type: "session_info" }]);
  });

  it("未知 update 类型被忽略", () => {
    expect(collect(notif({ sessionUpdate: "current_mode_update", currentModeId: "ask" }))).toEqual([]);
  });
});

describe("session-core · toToolContent", () => {
  it("三类内容：text / diff / terminal 全部提取", () => {
    const r = toToolContent([
      { type: "content", content: { type: "text", text: "hello" } },
      { type: "diff", path: "/a.ts", oldText: "old", newText: "new" },
      { type: "terminal", terminalId: "term-1" },
    ] as acp.ToolCallContent[]);
    expect(r).toEqual([
      { kind: "text", text: "hello" },
      { kind: "diff", diff: { path: "/a.ts", oldText: "old", newText: "new" } },
      { kind: "terminal", terminal: { terminalId: "term-1" } },
    ]);
  });

  it("null / undefined / 空数组 → 空数组", () => {
    expect(toToolContent(null)).toEqual([]);
    expect(toToolContent(undefined)).toEqual([]);
    expect(toToolContent([])).toEqual([]);
  });

  it("content 块只有 text 类型才提取（image 跳过）", () => {
    const r = toToolContent([
      { type: "content", content: { type: "image", data: "x" } },
      { type: "content", content: { type: "text", text: "only-text" } },
    ] as acp.ToolCallContent[]);
    expect(r).toEqual([{ kind: "text", text: "only-text" }]);
  });
});

describe("session-core · toCommandWord", () => {
  it("提取 name/description/hint（无 input 时 hint 缺失）", () => {
    const c = toCommandWord({
      name: "model",
      description: "显示模型",
    } as acp.AvailableCommand);
    expect(c).toEqual({ name: "model", description: "显示模型", hint: undefined });

    const c2 = toCommandWord({
      name: "fast",
      description: "切换快速模式",
      input: { hint: "[on|off]" },
    } as acp.AvailableCommand);
    expect(c2).toEqual({ name: "fast", description: "切换快速模式", hint: "[on|off]" });
  });
});
