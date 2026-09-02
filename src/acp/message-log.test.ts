import { describe, it, expect, beforeEach } from "vitest";
import {
  serializeMessage,
  serializeMessages,
  parseLine,
  parseLog,
  type ChatMsg,
  type LogStore,
} from "./message-log";

/** 内存版 LogStore：验证 JSONL 批量追加写的行级语义 */
function memStore(): { store: LogStore; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    store: {
      async readAll() {
        return lines.join("\n");
      },
      async appendLines(newLines: string[]) {
        lines.push(...newLines);
      },
    },
  };
}

describe("消息日志序列化 / 解析", () => {
  let lines: string[];
  let store: LogStore;
  beforeEach(() => {
    const m = memStore();
    lines = m.lines;
    store = m.store;
  });

  it("user / assistant / thought / tool 四类消息都能往返", () => {
    const msgs: ChatMsg[] = [
      { role: "user", text: "你好" },
      { role: "assistant", text: "你好！有什么可以帮你？" },
      { role: "thought", text: "用户打了个招呼，准备回应。" },
      { role: "tool", toolCallId: "t1", title: "read_file", status: "completed", content: [{ kind: "text", text: "abc" }] },
    ];
    for (const m of msgs) {
      const back = parseLine(serializeMessage(m));
      expect(back).toEqual(m);
    }
  });

  it("含换行的 assistant 文本序列化后仍是单行（JSONL 行切分安全）", () => {
    const msg: ChatMsg = { role: "assistant", text: "第一行\n第二行\n```python\nprint(1)\n```" };
    const line = serializeMessage(msg);
    expect(line.split("\n")).toHaveLength(1);
    expect(parseLine(line)).toEqual(msg);
  });

  it("serializeMessages 保留顺序，appendLines + parseLog 无损还原", async () => {
    const msgs: ChatMsg[] = [
      { role: "user", text: "记住密码 banana-77" },
      { role: "assistant", text: "已记住。" },
      { role: "tool", toolCallId: "t1", title: "read", status: "completed", content: [] },
    ];
    await store.appendLines(serializeMessages(msgs));
    expect(lines).toHaveLength(3);
    expect(parseLog(lines.join("\n"))).toEqual(msgs);
  });

  it("损坏行 / 空行 / 形状不合法行被跳过，不抛异常", () => {
    const raw = [
      JSON.stringify({ role: "user", text: "ok" }),
      "", // 空行
      "{ 不是合法 JSON", // 损坏
      JSON.stringify({ role: "unknown-role", text: "x" }), // 形状不合法
      JSON.stringify({ role: "tool", text: "缺字段" }), // tool 缺 toolCallId
      JSON.stringify({ role: "assistant", text: "ok2" }),
    ].join("\n");
    const parsed = parseLog(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ role: "user", text: "ok" });
    expect(parsed[1]).toEqual({ role: "assistant", text: "ok2" });
  });

  it("parseLog 空输入返回空数组", () => {
    expect(parseLog("")).toEqual([]);
  });
});
