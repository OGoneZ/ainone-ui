// P32 R5：块渲染稳定 key + memo 防回归。
// 意图：旧实现 key={i}——流式在 turn 尾部追加新块时，其后所有块的 key 位置
// 语义不变但若在前部/中部插入则整体漂移，React 会把「同位置不同 key」当作
// 新节点卸载重挂，Streamdown 对已渲染块重新解析（历史越长痛感越强）。
// 稳定 key（tool 用 toolCallId）保证追加/更新不打动既有块的 DOM 身份。

import { describe, it, expect } from "vitest";
import { renderItemKey } from "./MessageLine";
import type { RenderItem } from "@/chat/logic/activity";
import type { BlockMsg } from "@/acp/message-log";

function text(t: string): RenderItem {
  return { type: "block", block: { kind: "text", text: t } };
}
function thought(t: string): RenderItem {
  return { type: "block", block: { kind: "thought", text: t } };
}
function tool(id: string, status = "completed"): RenderItem {
  return { type: "block", block: { kind: "tool", toolCallId: id, title: id, status, content: [] } };
}
function group(blocks: BlockMsg[]): RenderItem {
  return { type: "activity_group", thoughts: 0, tools: blocks.length, ms: 0, blocks, running: false };
}

describe("renderItemKey（P32 R5 稳定 key）", () => {
  it("tool 块 key 用 toolCallId（跨更新稳定，与消息数组和分组无关）", () => {
    expect(renderItemKey(tool("call-1"), 0)).toBe("tool:call-1");
    expect(renderItemKey(tool("call-1"), 5)).toBe("tool:call-1");
  });

  it("text/thought 块 key 含类型前缀，不同类型不撞 key", () => {
    expect(renderItemKey(text("a"), 2)).toBe("text:2");
    expect(renderItemKey(thought("a"), 2)).toBe("thought:2");
  });

  it("activity_group key 有独立命名空间", () => {
    const g = group([{ kind: "tool", toolCallId: "t1", title: "t", status: "completed", content: [] }]);
    expect(renderItemKey(g, 3)).toBe("group:3");
  });

  it("核心语义：turn 尾部追加新块后，既有块 key 集合不变（不被重挂）", () => {
    const before = [text("第一段"), tool("call-1"), thought("思考")];
    const beforeKeys = before.map(renderItemKey);
    // 流式追加：尾部多了一个 text 块
    const after = [...before, text("第二段")];
    const afterKeys = after.map(renderItemKey);
    // 前 N 个 key 完全一致 → React reconciliation 复用既有 DOM
    expect(afterKeys.slice(0, beforeKeys.length)).toEqual(beforeKeys);
  });

  it("tool 状态更新（call-1 前 insertion）不影响其它 tool 块的 key", () => {
    const before = [tool("call-1"), tool("call-2")];
    const after = [tool("call-0"), ...before];
    // call-1/call-2 的 key 不因前面插入 call-0 而变化（index key 会全漂移）
    expect(renderItemKey(after[1], 1)).toBe("tool:call-1");
    expect(renderItemKey(after[2], 2)).toBe("tool:call-2");
  });
});
