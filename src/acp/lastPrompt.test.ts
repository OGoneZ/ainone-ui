import { describe, it, expect } from "vitest";
import { lastUserIndex, shouldShowLastPromptBubble, ellipsize } from "./lastPrompt";
import type { ChatMsg } from "./message-log";

const user = (t: string): ChatMsg => ({ role: "user", text: t });
const agent = (): ChatMsg => ({ role: "assistant", blocks: [{ kind: "text", text: "r" }] });

describe("lastUserIndex", () => {
  it("空列表 → -1", () => {
    expect(lastUserIndex([])).toBe(-1);
  });

  it("纯 agent → -1", () => {
    expect(lastUserIndex([agent(), agent()])).toBe(-1);
  });

  it("多轮 → 最后一条 user 下标", () => {
    expect(lastUserIndex([user("a"), agent(), user("b"), agent()])).toBe(2);
  });

  it("user 在末尾 → 末位", () => {
    expect(lastUserIndex([agent(), user("c")])).toBe(1);
  });
});

describe("shouldShowLastPromptBubble", () => {
  it("无 user 消息恒隐藏", () => {
    expect(shouldShowLastPromptBubble(false, 9999)).toBe(false);
  });

  it("距底超阈值 → 显示", () => {
    expect(shouldShowLastPromptBubble(true, 100)).toBe(true);
  });

  it("贴底（≤64px）→ 隐藏", () => {
    expect(shouldShowLastPromptBubble(true, 64)).toBe(false);
    expect(shouldShowLastPromptBubble(true, 0)).toBe(false);
  });
});

describe("ellipsize", () => {
  it("换行折空格", () => {
    expect(ellipsize("第一行\n第二行")).toBe("第一行 第二行");
  });

  it("超长截断加省略号", () => {
    expect(ellipsize("a".repeat(100), 60)).toHaveLength(61);
    expect(ellipsize("a".repeat(100), 60).endsWith("…")).toBe(true);
  });

  it("短文本原样", () => {
    expect(ellipsize("短")).toBe("短");
  });
});
