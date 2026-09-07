// 本地消息日志：纯序列化/解析逻辑，零 Tauri 依赖（DEC-10 可单测）。
//
// 设计（plan-v2 F-4-3 / DEC-9 / DEC-10）：
//   - 每会话一份 JSONL，一行一条「气泡消息」（JSON.stringify 把文本内换行转义，按行切分安全）
//   - 本地日志是「单一真源」：恢复会话 = session/load（agent 上下文）+ 读日志回填 UI
//   - fs 操作经 LogStore 注入，本模块只做纯逻辑，vitest 直接覆盖
//
// 消息模型（plan-v2 F-4-1/F-4-2）：
//   - user 消息 = 独立气泡（UI 右对齐）
//   - assistant 消息 = 一个 turn，内部 blocks 顺序渲染（UI 左对齐 + harness 头像）
//     · text    正文（可多段，段间可能穿插 thought/tool）
//     · thought thinking（流式结束后折叠为「已思考 N 秒」；ms 为可选计时）
//     · tool    工具调用（toolCallId 定位，支持 update 改写 status/content）

import type { ToolContent } from "./session-core";

export type BlockMsg =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string; ms?: number }
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      status: string;
      /** P30：协议 ToolKind（read/edit/execute/…），驱动图标。字段名 toolKind——
       *  块级 kind 是块类型判别符（"text"/"thought"/"tool"），不能被协议值覆盖。旧日志缺省。 */
      toolKind?: string;
      /** P30：工具原始入参（驱动参数副标题）；原样保留，旧日志缺省 */
      rawInput?: unknown;
      content: ToolContent[];
      /** F-16-2（DEC-49）：工具耗时计时——startTs = tool_call 事件时间戳（写入即持久化）；
       *  ms = 收尾时封口的耗时毫秒。旧日志缺省 → 按 0 计不参与累加。 */
      startTs?: number;
      ms?: number;
    };

export type ChatMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; blocks: BlockMsg[] };

export interface LogStore {
  /** 读回当前日志全量文本（可能为空串） */
  readAll(): Promise<string>;
  /** 追加多行（每行已序列化、不含换行符；一次性落盘） */
  appendLines(lines: string[]): Promise<void>;
}

function isToolContent(c: unknown): c is ToolContent[] {
  return Array.isArray(c);
}

function isBlock(o: unknown): o is BlockMsg {
  if (typeof o !== "object" || o === null) return false;
  const b = o as Record<string, unknown>;
  const kind = b.kind;
  if (kind === "text") return typeof b.text === "string";
  if (kind === "thought")
    return typeof b.text === "string" && (b.ms === undefined || typeof b.ms === "number");
  if (kind === "tool")
    return (
      typeof b.toolCallId === "string" &&
      typeof b.title === "string" &&
      typeof b.status === "string" &&
      isToolContent(b.content) &&
      // P30：toolKind/rawInput 为纯展示字段不做形状校验（坏值由渲染层 kindIcon 回退兜底），
      // 与 content 的宽容策略一致（只查 Array.isArray 不查元素形状）——不因展示字段拒收整块
      (b.startTs === undefined || typeof b.startTs === "number") &&
      (b.ms === undefined || typeof b.ms === "number")
    );
  return false;
}

function isChatMsg(o: unknown): o is ChatMsg {
  if (typeof o !== "object" || o === null) return false;
  const m = o as Record<string, unknown>;
  if (m.role === "user") return typeof m.text === "string";
  if (m.role === "assistant") {
    return Array.isArray(m.blocks) && m.blocks.every(isBlock);
  }
  return false;
}

export function serializeMessage(msg: ChatMsg): string {
  return JSON.stringify(msg);
}

/** 序列化一批消息（保留顺序，每条一行文件行） */
export function serializeMessages(msgs: ChatMsg[]): string[] {
  return msgs.map(serializeMessage);
}

/** 解析单行；空行 / JSON 损坏 / 形状不合法 → null（降级跳过，不阻塞续聊） */
export function parseLine(line: string): ChatMsg | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t);
    return isChatMsg(o) ? o : null;
  } catch {
    return null;
  }
}

/** 解析全量日志文本：逐行 parse，损坏行跳过 */
export function parseLog(raw: string): ChatMsg[] {
  return raw
    .split("\n")
    .map(parseLine)
    .filter((m): m is ChatMsg => m !== null);
}

// —— turn 内 block 追加（流式增量 → block 合并）——
// 规则：新块 kind 与 turn 最后一个 block 同类型则追加到该 block 的 text，
// 否则 push 新 block（text/thought 按流式 chunk 递增，tool 各自独立）。

export function appendText(blocks: BlockMsg[], chunk: string): BlockMsg[] {
  if (blocks.length > 0 && blocks[blocks.length - 1].kind === "text") {
    const copy = blocks.slice();
    const last = copy[copy.length - 1];
    if (last.kind === "text") copy[copy.length - 1] = { ...last, text: last.text + chunk };
    return copy;
  }
  return [...blocks, { kind: "text", text: chunk }];
}

export function appendThought(blocks: BlockMsg[], chunk: string): BlockMsg[] {
  if (blocks.length > 0 && blocks[blocks.length - 1].kind === "thought") {
    const copy = blocks.slice();
    const last = copy[copy.length - 1];
    if (last.kind === "thought") copy[copy.length - 1] = { ...last, text: last.text + chunk };
    return copy;
  }
  return [...blocks, { kind: "thought", text: chunk }];
}

export function appendTool(blocks: BlockMsg[], tool: BlockMsg & { kind: "tool" }): BlockMsg[] {
  return [...blocks, tool];
}

/** 按 toolCallId 更新 tool block 的 status/toolKind/rawInput/content（找不到则原样返回）。
 *  F-16-2（DEC-49）：status 进入终态（completed/failed，error 为本地历史值）且块带
 *  startTs 时封口 ms = now - startTs。P30：toolKind/rawInput 仅在事件携带时覆盖（缺省保留旧值）。
 *  注：协议 kind 落块级字段名 toolKind（块 kind 是块类型判别符，不能覆盖）。 */
export function updateTool(
  blocks: BlockMsg[],
  toolCallId: string,
  status: string | null,
  content: ToolContent[],
  now?: () => number,
  patch?: { toolKind?: string; rawInput?: unknown },
): BlockMsg[] {
  const idx = blocks.findIndex(
    (b) => b.kind === "tool" && b.toolCallId === toolCallId,
  );
  if (idx < 0) return blocks;
  const copy = blocks.slice();
  const b = copy[idx];
  if (b.kind === "tool") {
    const nextStatus = status ?? b.status;
    const finished =
      (nextStatus === "completed" || nextStatus === "failed" || nextStatus === "error") &&
      b.startTs !== undefined &&
      b.ms === undefined;
    copy[idx] = {
      ...b,
      status: nextStatus,
      content: content.length > 0 ? content : b.content,
      ...(patch?.toolKind !== undefined ? { toolKind: patch.toolKind } : {}),
      ...(patch && "rawInput" in patch ? { rawInput: patch.rawInput } : {}),
      ...(finished && now ? { ms: Math.max(0, now() - b.startTs!) } : {}),
    };
  }
  return copy;
}

/** 把 turn 最后一个 thought block 的计时落定（流式结束 → 折叠为「已思考 N 秒」） */
export function sealLastThought(blocks: BlockMsg[], ms: number): BlockMsg[] {
  const idx = blocks.length - 1;
  if (idx < 0) return blocks;
  const b = blocks[idx];
  if (b.kind !== "thought") return blocks;
  const copy = blocks.slice();
  copy[idx] = { ...b, ms };
  return copy;
}
