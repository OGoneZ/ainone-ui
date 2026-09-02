// ACP 客户端会话核心：纯协议层，零 Tauri 依赖（可在 Node 里直接测）。
//
// 与传输层的解耦点：streams（stdin/stdout/stderr）、fs 回调、kill 都通过参数注入。
// Node e2e 探针与 Tauri 前端共用同一份代码，验证的就是生产逻辑本身（DEC-8）。
//
// 关键协议事实（P0 报文存档 + ACP 规范）：
//   - session/prompt 是「请求」（有 PromptResponse 含 stopReason），session/update 是「通知」
//   - 一轮 turn 时序：先流式 update，最后 response resolve 即本轮结束
//   - session/load 会先回放历史 update，再回 response；回放结束即 response resolve
//   - SDK 的 ActiveSession 只支持 session/new attach，load 无对应公开入口 → 统一自建队列

import * as acp from "@agentclientprotocol/sdk";

export type DiffContent = { path: string; oldText?: string | null; newText: string };
export type TerminalContent = { terminalId: string };
export type TextContent = { text: string };

/** 工具调用的三类内容（ACP ToolCallContent）：文本 / diff / terminal */
export type ToolContent =
  | { kind: "text"; text: string }
  | { kind: "diff"; diff: DiffContent }
  | { kind: "terminal"; terminal: TerminalContent };

export type Outgoing =
  | { type: "agent_text"; text: string }
  | { type: "agent_thought"; text: string }
  | { type: "tool_call"; toolCallId: string; title: string; status?: string | null; content: ToolContent[] }
  | { type: "tool_update"; toolCallId: string; status?: string | null; content: ToolContent[] }
  | { type: "turn_stop"; stopReason: string }
  | { type: "available_commands"; commands: CommandWord[] }
  | { type: "error"; message: string };

export interface CommandWord {
  name: string;
  description: string;
  hint?: string;
}

export type PermissionDecision = (
  params: acp.RequestPermissionRequest,
) => Promise<acp.RequestPermissionResponse>;

export interface SessionIpc {
  fsRead(path: string): Promise<string>;
  fsWrite(path: string, content: string): Promise<void>;
  kill(): Promise<void>;
}

export interface Streams {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

export interface AcpSession {
  sessionId: string;
  prompt(text: string, onOutgoing: (e: Outgoing) => void): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface OpenOptions {
  streams: Streams;
  cwd: string;
  onPermission: PermissionDecision;
  ipc: SessionIpc;
  resumeSessionId?: string;
  /** 收到 available_commands_update 通知时回调（F-4-7 slash 补全数据源） */
  onCommands?: (words: CommandWord[]) => void;
}

export async function createAcpSession(opts: OpenOptions): Promise<AcpSession> {
  const { streams, cwd, onPermission, ipc, resumeSessionId, onCommands } = opts;

  // —— update 队列：onNotification 塞入，prompt 内消费 ——
  let boundSessionId = "";
  const updateQueue: acp.SessionNotification[] = [];
  const waiters: ((n: acp.SessionNotification) => void)[] = [];

  const enqueue = (n: acp.SessionNotification) => {
    if (boundSessionId && n.sessionId !== boundSessionId) return; // 多会话防串流
    const w = waiters.shift();
    if (w) w(n);
    else updateQueue.push(n);
  };
  const nextUpdate = (): Promise<acp.SessionNotification> =>
    updateQueue.length
      ? Promise.resolve(updateQueue.shift()!)
      : new Promise((r) => waiters.push(r));
  const drainQueue = () => {
    updateQueue.length = 0;
  };

  const app = acp
    .client({ name: "ainone-ui" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      onPermission(ctx.params),
    )
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => ({
      content: await ipc.fsRead(ctx.params.path),
    }))
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      await ipc.fsWrite(ctx.params.path, ctx.params.content);
      return {};
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const u = ctx.params;
      // available_commands_update 与 turn 内容无关（F-4-7）：不进队列，直接回调
      if (u.update.sessionUpdate === "available_commands_update") {
        onCommands?.(u.update.availableCommands.map(toCommandWord));
        return;
      }
      enqueue(u);
    });

  const stream = acp.ndJsonStream(streams.stdin, streams.stdout);
  const connection = app.connect(stream);

  // stderr 仅日志
  void (async () => {
    const reader = streams.stderr.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) console.warn("[harness stderr]", dec.decode(value));
    }
  })();

  await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: "ainone-ui", version: "0.1.0" },
  });
  console.info("[acp] initialize 完成，protocolVersion=", acp.PROTOCOL_VERSION);

  if (resumeSessionId) {
    // load：回放历史 update（纯消费不展示），response resolve 后回放结束
    await connection.agent.request(acp.methods.agent.session.load, {
      sessionId: resumeSessionId,
      cwd,
      mcpServers: [],
    });
    boundSessionId = resumeSessionId;
    drainQueue();
    console.info("[acp] session/load 完成 sessionId=", resumeSessionId);
  } else {
    const resp = await connection.agent.request<acp.NewSessionResponse>(
      acp.methods.agent.session.new,
      { cwd, mcpServers: [] },
    );
    boundSessionId = resp.sessionId;
    console.info("[acp] session/new 完成 sessionId=", resp.sessionId);
  }

  const sessionId = boundSessionId;

  return {
    sessionId,
    async prompt(text, onOutgoing) {
      console.info("[acp] session/prompt 开始 sessionId=", sessionId);
      const promptPromise = connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      // 消费 update 直到 response resolve（本轮结束）
      for (;;) {
        const msg = await Promise.race([nextUpdate(), promptPromise.then(() => null)]);
        if (msg === null) break;
        dispatchUpdate(msg, onOutgoing);
      }
      // 排空残余 update（usage_update 等），避免串到下一轮
      drainQueue();
      const resp = await promptPromise;
      console.info("[acp] session/prompt 结束 stopReason=", resp.stopReason);
      onOutgoing({ type: "turn_stop", stopReason: resp.stopReason });
    },
    cancel() {
      console.info("[acp] session/cancel sessionId=", sessionId);
      return connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    },
    async dispose() {
      console.info("[acp] dispose sessionId=", sessionId);
      try {
        connection.close();
      } catch {
        /* ignore */
      }
      await ipc.kill().catch(() => {});
    },
  };
}

export function dispatchUpdate(u: acp.SessionNotification, onOutgoing: (e: Outgoing) => void) {
  switch (u.update.sessionUpdate) {
    case "agent_message_chunk":
      if (u.update.content.type === "text") {
        onOutgoing({ type: "agent_text", text: u.update.content.text });
      }
      break;
    case "agent_thought_chunk":
      if (u.update.content.type === "text") {
        onOutgoing({ type: "agent_thought", text: u.update.content.text });
      }
      break;
    case "tool_call":
      onOutgoing({
        type: "tool_call",
        toolCallId: u.update.toolCallId,
        title: u.update.title,
        status: u.update.status ?? null,
        content: toToolContent(u.update.content),
      });
      break;
    case "tool_call_update":
      onOutgoing({
        type: "tool_update",
        toolCallId: u.update.toolCallId,
        status: u.update.status ?? null,
        content: toToolContent(u.update.content),
      });
      break;
    default:
      break;
  }
}

export function toCommandWord(c: acp.AvailableCommand): CommandWord {
  return {
    name: c.name,
    description: c.description,
    hint: c.input?.hint,
  };
}

export function toToolContent(content: acp.ToolCallContent[] | null | undefined): ToolContent[] {
  if (!content) return [];
  const out: ToolContent[] = [];
  for (const c of content) {
    switch (c.type) {
      case "content":
        if (c.content.type === "text") out.push({ kind: "text", text: c.content.text });
        break;
      case "diff":
        out.push({ kind: "diff", diff: { path: c.path, oldText: c.oldText, newText: c.newText } });
        break;
      case "terminal":
        out.push({ kind: "terminal", terminal: { terminalId: c.terminalId } });
        break;
      default:
        break;
    }
  }
  return out;
}
