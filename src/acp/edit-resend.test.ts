import { describe, expect, it } from "vitest";
import { truncateMessagesToEdit } from "./edit-resend";
import type { ChatMsg } from "./message-log";

const msgs: ChatMsg[] = [
  { role: "user", text: "问题一" },
  { role: "assistant", blocks: [{ kind: "text", text: "回答一" }] },
  { role: "user", text: "问题二" },
  { role: "assistant", blocks: [{ kind: "text", text: "回答二" }] },
  { role: "user", text: "问题三" },
];

describe("truncateMessagesToEdit（F-12-1 编辑重试，DEC-35）", () => {
  it("中间消息编辑：保留之前 + 替换该条 + 丢弃之后", () => {
    const r = truncateMessagesToEdit(msgs, 2, "问题二（改）");
    expect(r).toEqual([
      { role: "user", text: "问题一" },
      { role: "assistant", blocks: [{ kind: "text", text: "回答一" }] },
      { role: "user", text: "问题二（改）" },
    ]);
  });

  it("第 0 条编辑：只剩替换后的一条", () => {
    const r = truncateMessagesToEdit(msgs, 0, "重新开始");
    expect(r).toEqual([{ role: "user", text: "重新开始" }]);
  });

  it("最后一条编辑：等价于原地替换", () => {
    const r = truncateMessagesToEdit(msgs, 4, "问题三（改）");
    expect(r).toHaveLength(5);
    expect(r![4]).toEqual({ role: "user", text: "问题三（改）" });
  });

  it("assistant 消息不可编辑 → null", () => {
    expect(truncateMessagesToEdit(msgs, 1, "x")).toBeNull();
  });

  it("越界（负数 / 超长）→ null", () => {
    expect(truncateMessagesToEdit(msgs, -1, "x")).toBeNull();
    expect(truncateMessagesToEdit(msgs, 5, "x")).toBeNull();
  });

  it("空文本 / 纯空白 → null（不发空消息）", () => {
    expect(truncateMessagesToEdit(msgs, 2, "")).toBeNull();
    expect(truncateMessagesToEdit(msgs, 2, "   ")).toBeNull();
  });

  it("空消息数组 → null", () => {
    expect(truncateMessagesToEdit([], 0, "x")).toBeNull();
  });
});
