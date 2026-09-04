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
import { extractUsage } from "./metadata";
import { extractPlan } from "./plan";

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
  | { type: "usage"; used: number; size: number; cost: number | null }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "error"; message: string };

/** P9 F-9-1 计划条目（从 ACP plan block 提取） */
export interface PlanEntry {
  content: string;
  status: string;
  priority?: string;
}

export interface CommandWord {
  name: string;
  description: string;
  hint?: string;
}

export type PermissionDecision = (
  params: acp.RequestPermissionRequest,
) => Promise<acp.RequestPermissionResponse>;

/** F-12-2 结构化提问（Elicitation create 请求 → AskCard 渲染 → 返回 accept/decline） */
export type ElicitationHandler = (
  params: acp.CreateElicitationRequest,
) => Promise<acp.CreateElicitationResponse>;

export interface SessionIpc {
  fsRead(path: string): Promise<string>;
  fsWrite(path: string, content: string): Promise<void>;
  kill(): Promise<void>;
  /** 空闲超时回收（P8 F-8-1）：带最后活动时间 kill；缺省回退到 kill */
  recycle?(lastActivityMs: number): Promise<void>;
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
  /** F-8-5 会话分叉：从当前状态 fork，返回新 sessionId */
  fork(cwdOverride: string): Promise<string>;
  /** F-8-4 元数据：拉取当前 provider 路由信息（apiType/baseUrl），无则空数组 */
  listProviders(): Promise<Array<{ providerId?: string; current?: { apiType?: string; baseUrl?: string } | null }>>;
  /** 空闲超时回收：关闭连接 + kill 子进程（区别于 dispose 的常规清理） */
  recycle(lastActivityMs: number): Promise<void>;
  dispose(): Promise<void>;
}

export interface OpenOptions {
  streams: Streams;
  cwd: string;
  onPermission: PermissionDecision;
  /** F-12-2 结构化提问（Elicitation form）：未提供时自动 decline（不悬挂 agent） */
  onElicitation?: ElicitationHandler;
  ipc: SessionIpc;
  resumeSessionId?: string;
  /** 收到 available_commands_update 通知时回调（F-4-7 slash 补全数据源） */
  onCommands?: (words: CommandWord[]) => void;
  /** P4 启动守卫：子进程退出信号——initialize 等待中进程先退出 = 立即报错（带 stderr 尾迹） */
  closed?: Promise<{ code: number | null }>;
  /** P4 启动守卫：stderr 尾迹（环形缓冲），进程退出/握手超时时拼进错误信息 */
  stderrTail?: () => string;
  /** P4 启动守卫：initialize 超时，默认 15_000ms */
  initTimeoutMs?: number;
}

/** 启动期错误文案：附退出码与 stderr 尾部，替代模糊的静默失败 */
function startupFailMessage(what: string, code: number | null | undefined, stderrTail?: () => string): string {
  const tail = stderrTail?.().trim();
  const codeStr = code === undefined ? "" : code === null ? "（被信号终止）" : `（退出码 ${code}）`;
  return tail
    ? `${what}失败${codeStr}。stderr 尾部：${tail}`
    : `${what}失败${codeStr}，无 stderr 输出。`;
}

/** 给「启动期请求」加守卫：进程先退出 / 超时都转为带 stderr 尾迹的明确错误 */
async function withStartupGuard<T>(
  p: Promise<T>,
  what: string,
  opts: { closed?: Promise<{ code: number | null }>; stderrTail?: () => string; timeoutMs?: number },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`__startup_timeout__${what}`)), opts.timeoutMs ?? 15_000);
  });
  try {
    return await Promise.race([p, timeout]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("__startup_timeout__")) {
      throw new Error(
        `${msg.slice("__startup_timeout__".length)}超时（${opts.timeoutMs ?? 15_000}ms），进程可能卡住。${opts.stderrTail?.().trim() ? `stderr 尾部：${opts.stderrTail().trim()}` : ""}`,
      );
    }
    // 进程退出先于请求完成 → 用退出信息重写错误（原错误多为 EOF 模糊文案）
    if (opts.closed) {
      const settled = await Promise.race([
        opts.closed.then(() => true as const),
        new Promise<false>((r) => setTimeout(() => r(false), 50)),
      ]);
      if (settled) {
        const { code } = await opts.closed;
        throw new Error(startupFailMessage(what, code, opts.stderrTail));
      }
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createAcpSession(opts: OpenOptions): Promise<AcpSession> {
  const { streams, cwd, onPermission, ipc, resumeSessionId, onCommands } = opts;
  // F-12-2：缺省 elicitation 处理 = decline（声明了 form 能力就必须有兜底响应）
  const onElicitation: ElicitationHandler =
    opts.onElicitation ??
    (() => Promise.resolve({ action: "decline" } as acp.CreateElicitationResponse));

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
    // F-12-2 结构化提问（Elicitation form 模式）：交给 onElicitation 渲染提问卡
    .onRequest(acp.methods.client.elicitation.create, (ctx) => onElicitation(ctx.params))
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

  await withStartupGuard(
    connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
        // F-12-2：声明 form 模式支持（结构化提问卡）
        elicitation: { form: {} },
      },
      clientInfo: { name: "ainone-ui", version: "0.1.0" },
    }),
    "initialize",
    { closed: opts.closed, stderrTail: opts.stderrTail, timeoutMs: opts.initTimeoutMs },
  );
  console.info("[acp] initialize 完成，protocolVersion=", acp.PROTOCOL_VERSION);

  if (resumeSessionId) {
    // load：回放历史 update（纯消费不展示），response resolve 后回放结束
    await withStartupGuard(
      connection.agent.request(acp.methods.agent.session.load, {
        sessionId: resumeSessionId,
        cwd,
        mcpServers: [],
      }),
      "session/load",
      { closed: opts.closed, stderrTail: opts.stderrTail, timeoutMs: opts.initTimeoutMs },
    );
    boundSessionId = resumeSessionId;
    drainQueue();
    console.info("[acp] session/load 完成 sessionId=", resumeSessionId);
  } else {
    const resp = await withStartupGuard(
      connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      }),
      "session/new",
      { closed: opts.closed, stderrTail: opts.stderrTail, timeoutMs: opts.initTimeoutMs },
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
    /** F-8-4 元数据：拉取当前 provider 路由信息（apiType/baseUrl），失败静默。 */
    async listProviders() {
      try {
        const resp = await connection.agent.request(acp.methods.agent.providers.list as any, {});
        return (resp?.providers ?? []) as Array<{ providerId?: string; current?: { apiType?: string; baseUrl?: string } | null }>;
      } catch {
        return [];
      }
    },
    cancel() {
      console.info("[acp] session/cancel sessionId=", sessionId);
      return connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    },
    /**
     * F-8-5 会话分叉：`session/fork`（sessionId + cwd，从当前状态 fork，DEC-14）。
     * 返回新 sessionId；harness 未实现 fork 能力时抛错（上层降级提示）。
     */
    async fork(cwdOverride) {
      const forkResp = await connection.agent.request(acp.methods.agent.session.fork as any, {
        sessionId,
        cwd: cwdOverride,
        mcpServers: [],
      });
      console.info("[acp] session/fork 完成 sessionId=", sessionId, "→", forkResp.sessionId);
      return forkResp.sessionId as string;
    },
    /** 空闲超时回收（P8 F-8-1）：关闭连接 + 带活动时间 kill 子进程 */
    async recycle(lastActivityMs) {
      console.info("[acp] 空闲回收关闭连接 sessionId=", sessionId);
      try {
        connection.close();
      } catch {
        /* ignore */
      }
      if (ipc.recycle) await ipc.recycle(lastActivityMs).catch(() => {});
      else await ipc.kill().catch(() => {});
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
    case "usage_update":
      // F-8-4 元数据侧栏：上下文占用 / token / 成本（L5：走 metadata.extractUsage 单一实现）
      onOutgoing({ type: "usage", ...extractUsage(u.update) });
      break;
    case "plan":
      // F-9-1 计划栏：plan block 全量替换（DEC-16；L5：走 plan.extractPlan 单一实现）
      onOutgoing({ type: "plan", entries: extractPlan(u.update) });
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
