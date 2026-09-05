// historyAnchors 纯函数测试（P16 · F-16-2，AC-P16-4）。

import { describe, it, expect } from "vitest";
import { extractUserAnchors } from "./historyAnchors";
import type { ChatMsg } from "@/acp/message-log";

const user = (text: string): ChatMsg => ({ role: "user", text });
const assistant = (): ChatMsg => ({
  role: "assistant",
  blocks: [{ kind: "text", text: "回复" }],
});

describe("extractUserAnchors（DEC-49）", () => {
  it("从线性消息中按时间序提取用户消息锚点", () => {
    const msgs: ChatMsg[] = [user("第一问"), assistant(), user("第二问"), assistant(), user("第三问")];
    const anchors = extractUserAnchors(msgs);
    expect(anchors).toHaveLength(3);
    expect(anchors[0]).toMatchObject({ index: 0, text: "第一问", preview: "第一问" });
    expect(anchors[1]).toMatchObject({ index: 2 });
    expect(anchors[2]).toMatchObject({ index: 4 });
  });

  it("preview 取首行非空行并截断到 48 字", () => {
    const long = "一".repeat(60);
    const msgs: ChatMsg[] = [user(`\n\n${long}`)];
    const anchors = extractUserAnchors(msgs);
    expect(anchors[0].preview).toBe(`${"一".repeat(48)}…`);
  });

  it("多行消息 preview 只取首行", () => {
    const msgs: ChatMsg[] = [user("第一行\n第二行")];
    expect(extractUserAnchors(msgs)[0].preview).toBe("第一行");
  });

  it("全空白消息 preview 兜底「（空消息）」", () => {
    const msgs: ChatMsg[] = [user("  \n  ")];
    expect(extractUserAnchors(msgs)[0].preview).toBe("（空消息）");
  });

  it("无用户消息 → 空数组（UI 显示空态）", () => {
    expect(extractUserAnchors([assistant()])).toEqual([]);
    expect(extractUserAnchors([])).toEqual([]);
  });

  it("index 与 messages 位置一致——回溯截断后重算，锚点自动变短（树=剪枝语义）", () => {
    const msgs: ChatMsg[] = [user("a"), assistant(), user("b"), assistant(), user("c")];
    // 回溯到 index 3 之前 → 只剩 [user a, assistant, user b]
    const truncated = msgs.slice(0, 3);
    const anchors = extractUserAnchors(truncated);
    expect(anchors.map((a) => a.text)).toEqual(["a", "b"]);
    expect(anchors[1].index).toBe(2);
  });
});
