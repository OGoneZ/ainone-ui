// searchMessages 单测：多命中 / 无命中 / 空关键词 / thinking 与工具标题命中（AC-P9-8）。

import { describe, it, expect } from "vitest";
import { searchMessages, messageSearchText } from "./search";
import type { ChatMsg } from "./message-log";

describe("messageSearchText", () => {
  it("user 消息 → 原文", () => {
    expect(messageSearchText({ role: "user", text: "你好" })).toBe("你好");
  });

  it("assistant → 正文 + thinking + 工具标题拼接", () => {
    const m: ChatMsg = {
      role: "assistant",
      blocks: [
        { kind: "text", text: "正文" },
        { kind: "thought", text: "思考过程" },
        { kind: "tool", toolCallId: "t", title: "read_file", status: "done", content: [] },
      ],
    };
    expect(messageSearchText(m)).toBe("正文\n思考过程\nread_file");
  });
});

describe("searchMessages", () => {
  const msgs: ChatMsg[] = [
    { role: "user", text: "帮我看看这个文件" },
    { role: "assistant", blocks: [{ kind: "text", text: "这个文件包含安全漏洞" }] },
    { role: "assistant", blocks: [{ kind: "thought", text: "我需要检查安全漏洞" }] },
    { role: "assistant", blocks: [{ kind: "tool", toolCallId: "t1", title: "read_file", status: "done", content: [] }] },
  ];

  it("多命中：正文 + thinking + 工具标题都命中", () => {
    const h = searchMessages(msgs, "安全漏洞");
    expect(h.map((x) => x.index)).toEqual([1, 2]);
  });

  it("工具标题命中", () => {
    const h = searchMessages(msgs, "read_file");
    expect(h.map((x) => x.index)).toEqual([3]);
  });

  it("无命中 → 空数组", () => {
    expect(searchMessages(msgs, "不存在的内容xyz")).toEqual([]);
  });

  it("空关键词 → 空数组", () => {
    expect(searchMessages(msgs, "")).toEqual([]);
    expect(searchMessages(msgs, "   ")).toEqual([]);
  });

  it("不区分大小写", () => {
    expect(searchMessages(msgs, "READ_FILE").map((x) => x.index)).toEqual([3]);
  });
});
