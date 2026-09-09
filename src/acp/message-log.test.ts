import { describe, it, expect, beforeEach } from "vitest";
import {
  serializeMessage,
  serializeMessages,
  parseLine,
  parseLog,
  appendText,
  appendThought,
  appendTool,
  updateTool,
  sealLastThought,
  type ChatMsg,
  type BlockMsg,
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

describe("消息日志：气泡模型序列化 / 解析", () => {
  let lines: string[];
  let store: LogStore;
  beforeEach(() => {
    const m = memStore();
    lines = m.lines;
    store = m.store;
  });

  it("user / assistant（含 text/thought/tool blocks）都能无损往返", () => {
    const msgs: ChatMsg[] = [
      { role: "user", text: "你好" },
      {
        role: "assistant",
        blocks: [
          { kind: "text", text: "你好！" },
          { kind: "thought", text: "用户打了招呼", ms: 1200 },
          { kind: "tool", toolCallId: "t1", title: "read_file", status: "completed", content: [{ kind: "text", text: "abc" }] },
        ],
      },
    ];
    for (const m of msgs) {
      expect(parseLine(serializeMessage(m))).toEqual(m);
    }
  });

  it("含换行的正文序列化后仍是单行（JSONL 行切分安全）", () => {
    const msg: ChatMsg = {
      role: "assistant",
      blocks: [{ kind: "text", text: "第一行\n第二行\n```python\nprint(1)\n```" }],
    };
    const line = serializeMessage(msg);
    expect(line.split("\n")).toHaveLength(1);
    expect(parseLine(line)).toEqual(msg);
  });

  it("serializeMessages 保留顺序，appendLines + parseLog 无损还原", async () => {
    const msgs: ChatMsg[] = [
      { role: "user", text: "记住密码 banana-77" },
      { role: "assistant", blocks: [{ kind: "text", text: "已记住。" }] },
    ];
    await store.appendLines(serializeMessages(msgs));
    expect(lines).toHaveLength(2);
    expect(parseLog(lines.join("\n"))).toEqual(msgs);
  });

  it("损坏行 / 空行 / 形状不合法行被跳过，不抛异常", () => {
    const raw = [
      JSON.stringify({ role: "user", text: "ok" }),
      "", // 空行
      "{ 不是合法 JSON", // 损坏
      JSON.stringify({ role: "unknown-role", text: "x" }), // 形状不合法
      JSON.stringify({ role: "assistant", blocks: [{ kind: "voiced", text: "x" }] }), // block 形状非法
      JSON.stringify({ role: "assistant", blocks: [{ kind: "text", text: "ok2" }] }),
    ].join("\n");
    const parsed = parseLog(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ role: "user", text: "ok" });
    expect(parsed[1]).toEqual({ role: "assistant", blocks: [{ kind: "text", text: "ok2" }] });
  });

  it("parseLog 空输入返回空数组", () => {
    expect(parseLog("")).toEqual([]);
  });
});

describe("turn 内 block 追加 / 合并", () => {
  const tool = (id: string): BlockMsg & { kind: "tool" } => ({
    kind: "tool",
    toolCallId: id,
    title: "t",
    status: "pending",
    content: [],
  });

  it("appendText 相邻文本块合并，跨类型新起块", () => {
    let b: BlockMsg[] = [];
    b = appendText(b, "你");
    b = appendText(b, "好");
    expect(b).toEqual([{ kind: "text", text: "你好" }]);
    b = appendThought(b, "思考");
    b = appendText(b, "！");
    expect(b).toEqual([
      { kind: "text", text: "你好" },
      { kind: "thought", text: "思考" },
      { kind: "text", text: "！" },
    ]);
  });

  it("appendThought 相邻思考合并", () => {
    let b: BlockMsg[] = [];
    b = appendThought(b, "想");
    b = appendThought(b, "法");
    expect(b).toEqual([{ kind: "thought", text: "想法" }]);
  });

  it("appendTool 各自独立（工具间不合并）", () => {
    let b: BlockMsg[] = [];
    b = appendTool(b, tool("a"));
    b = appendTool(b, tool("b"));
    expect(b).toHaveLength(2);
  });

  it("updateTool 按 toolCallId 定位改写 status/content，找不到不报错", () => {
    let b: BlockMsg[] = [tool("a"), tool("b"), { kind: "text", text: "x" }];
    b = updateTool(b, "a", "completed", [{ kind: "text", text: "done" }]);
    expect((b[0] as { status: string }).status).toBe("completed");
    expect((b[0] as { content: unknown[] }).content).toHaveLength(1);
    // 找不到的 id：原样返回（引用不变）
    expect(updateTool(b, "nope", "x", [])).toBe(b);
  });

  it("updateTool 空 content 不改写原 content", () => {
    let b: BlockMsg[] = [{ ...tool("a"), content: [{ kind: "text", text: "keep" }] }];
    b = updateTool(b, "a", "completed", []);
    expect((b[0] as { content: unknown[] }).content).toHaveLength(1);
  });

  it("sealLastThought 只落定最后一个 thought 块的计时", () => {
    let b: BlockMsg[] = [
      { kind: "thought", text: "第一段", ms: 500 },
      { kind: "text", text: "正文" },
      { kind: "thought", text: "第二段" },
    ];
    b = sealLastThought(b, 1200);
    expect(b).toEqual([
      { kind: "thought", text: "第一段", ms: 500 },
      { kind: "text", text: "正文" },
      { kind: "thought", text: "第二段", ms: 1200 },
    ]);
  });

  it("sealLastThought 最后一块非 thought 时不动", () => {
    const b: BlockMsg[] = [{ kind: "text", text: "x" }];
    expect(sealLastThought(b, 100)).toBe(b);
  });

  // P30 AC-1.3：协议失败终态 failed 封口（error 为本地历史值）
  it("P30：updateTool 终态 completed/failed/error 均封口 ms；非终态不封口", () => {
    for (const terminal of ["completed", "failed", "error"] as const) {
      const b = [{ ...tool("a"), startTs: 50 }];
      const out = updateTool(b, "a", terminal, [], () => 100);
      expect((out[0] as { ms?: number }).ms).toBe(50); // ms = 100 - 50
    }
    const running = updateTool([{ ...tool("a"), startTs: 50 }], "a", "in_progress", [], () => 100);
    expect((running[0] as { ms?: number }).ms).toBeUndefined();
  });

  // P30 AC-1.4：旧日志行（无 toolKind/rawInput）解析不回归；新字段坏形状宽容降级
  it("P30：旧日志无新字段照常解析；toolKind 非 string 降级为缺省不拒收", () => {
    // 旧版日志行：tool 块无 toolKind/rawInput
    const legacy = JSON.stringify({
      role: "assistant",
      blocks: [{ kind: "tool", toolCallId: "t1", title: "Terminal", status: "failed", content: [{ kind: "text", text: "x" }], startTs: 1, ms: 2 }],
    });
    const parsedLegacy = parseLine(legacy);
    expect(parsedLegacy).not.toBeNull();
    expect((parsedLegacy as { blocks: Array<{ toolKind?: string }> }).blocks[0].toolKind).toBeUndefined();

    // 新字段形状坏（toolKind 为数字）→ 照常收下（纯展示字段不校验，渲染层回退兜底）
    const badShape = JSON.stringify({
      role: "assistant",
      blocks: [{ kind: "tool", toolCallId: "t2", title: "T", status: "completed", content: [], toolKind: 42 }],
    });
    const parsedBad = parseLine(badShape) as { blocks: Array<{ toolKind?: unknown }> } | null;
    expect(parsedBad).not.toBeNull();
    expect(parsedBad!.blocks[0].toolKind).toBe(42);

    // 新字段正常形状 → 无损往返
    const modern = JSON.stringify({
      role: "assistant",
      blocks: [{ kind: "tool", toolCallId: "t3", title: "Terminal", status: "completed", content: [], toolKind: "execute", rawInput: { command: "ls" } }],
    });
    const parsedModern = parseLine(modern) as { blocks: Array<{ toolKind?: string; rawInput?: unknown }> };
    expect(parsedModern.blocks[0].toolKind).toBe("execute");
    expect(parsedModern.blocks[0].rawInput).toEqual({ command: "ls" });
  });

  // P30 AC-1.2：updateTool patch 合并语义（携带才覆盖，缺省保留）
  it("P30：updateTool 携带 toolKind/rawInput 覆盖，不携带保留旧值", () => {
    const b = [{ ...tool("a"), toolKind: "execute", rawInput: { command: "ls" } }];
    const kept = updateTool(b, "a", "completed", [], undefined);
    expect((kept[0] as { toolKind?: string }).toolKind).toBe("execute");
    expect((kept[0] as { rawInput?: unknown }).rawInput).toEqual({ command: "ls" });

    const overridden = updateTool(b, "a", "completed", [], undefined, { toolKind: "edit", rawInput: { file_path: "/x" } });
    expect((overridden[0] as { toolKind?: string }).toolKind).toBe("edit");
    expect((overridden[0] as { rawInput?: unknown }).rawInput).toEqual({ file_path: "/x" });
  });

  // P36 R1 AC-1.4/1.5：rawOutput 落盘往返无损 + updateTool 携带才覆盖
  it("P36：rawOutput 序列化往返无损；updateTool 携带覆盖、不携带保留", () => {
    const ompOutput = { content: [{ type: "text", text: "hello" }], details: { totalLines: 3 } };
    const line = JSON.stringify({
      role: "assistant",
      blocks: [{ kind: "tool", toolCallId: "t1", title: "Terminal", status: "completed", content: [], rawOutput: ompOutput }],
    });
    const parsed = parseLine(line) as { blocks: Array<{ rawOutput?: unknown }> } | null;
    expect(parsed).not.toBeNull();
    expect(parsed!.blocks[0].rawOutput).toEqual(ompOutput);

    const b = [{ ...tool("a") }];
    const kept = updateTool(b, "a", "completed", [], undefined);
    expect((kept[0] as { rawOutput?: unknown }).rawOutput).toBeUndefined();
    const overridden = updateTool(b, "a", "completed", [], undefined, { rawOutput: ompOutput });
    expect((overridden[0] as { rawOutput?: unknown }).rawOutput).toEqual(ompOutput);
  });
});
