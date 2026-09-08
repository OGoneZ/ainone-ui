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
  | {
      type: "tool_call";
      toolCallId: string;
      title: string;
      status?: string | null;
      /** P30：协议 ToolKind（read/edit/execute/…十类），驱动图标与文案；缺省 = harness 未声明 */
      kind?: string;
      /** P30：工具原始入参（Bash→{command}、Edit→{file_path}…），驱动参数副标题；原样透传不解释 */
      rawInput?: unknown;
      content: ToolContent[];
    }
  | {
      type: "tool_update";
      toolCallId: string;
      status?: string | null;
      kind?: string;
      rawInput?: unknown;
      content: ToolContent[];
    }
  | { type: "turn_stop"; stopReason: string }
  | { type: "available_commands"; commands: CommandWord[] }
  | { type: "usage"; used: number; size: number; cost: number | null }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "config_options"; options: acp.SessionConfigOption[] }
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
  /** initialize 握手存档的 agent 能力（旧 harness 未声明 → null）。
   *  capability gate 的唯一事实源（对标 AionUi：所有功能入口按此显隐） */
  capabilities: acp.AgentCapabilities | null;
  /** initialize 握手存档的 agent 信息（名称/版本） */
  agentInfo: acp.Implementation | null;
  /** 会话来源：new = 全新；loaded = session/load 成功；degraded-new = load 失败降级 new */
  sessionOrigin: "new" | "loaded" | "degraded-new";
  /** 降级原因（sessionOrigin === "degraded-new" 时存在，供 UI 文案） */
  loadError?: string;
  /** P29：session/new 存档的会话配置选项（category="model" 即模型选择器；未声明 → null） */
  configOptions: acp.SessionConfigOption[] | null;
  /** P29：会话级设置配置选项（session/set_config_option；无该能力 → null） */
  setConfigOption: ((configId: string, value: string) => Promise<acp.SessionConfigOption[] | null>) | null;
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
  // 可取消的「取下一条 update」：prompt 消费循环每次迭代注册一个 waiter，
  // race 输给 null/死亡信号时 waiter 若留在数组里，下一轮会被 enqueue 命中、
  // 消息送给已废弃的 promise（吞消息）→ cancel 摘除；若已命中但无人消费，
  // 回插队首不丢消息。
  const takeUpdate = (): {
    promise: Promise<acp.SessionNotification>;
    cancel: () => void;
  } => {
    if (updateQueue.length) {
      return { promise: Promise.resolve(updateQueue.shift()!), cancel: () => {} };
    }
    let resolve!: (n: acp.SessionNotification) => void;
    let hit: acp.SessionNotification | null = null;
    const w = (n: acp.SessionNotification) => {
      hit = n;
      resolve(n);
    };
    const promise = new Promise<acp.SessionNotification>((r) => (resolve = r));
    waiters.push(w);
    return {
      promise,
      cancel: () => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        else if (hit) updateQueue.unshift(hit);
      },
    };
  };
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

  // capabilities 存档（对标 AionUi：握手结果逐项保留，功能入口按 capability 显隐）
  let agentCapabilities: acp.AgentCapabilities | null = null;
  let agentInfo: acp.Implementation | null = null;
  let sessionOrigin: "new" | "loaded" | "degraded-new" = "new";
  let loadError: string | undefined;
  // P29：session/new 响应的 configOptions（降级 new / 全新 new 两处赋值）
  let newConfigOptions: acp.SessionConfigOption[] | null = null;

  const initResp = await withStartupGuard(
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
  agentCapabilities = (initResp as acp.InitializeResponse).agentCapabilities ?? null;
  agentInfo = (initResp as acp.InitializeResponse).agentInfo ?? null;
  console.info(
    "[acp] initialize 完成，protocolVersion=",
    (initResp as acp.InitializeResponse).protocolVersion,
    "loadSession=",
    agentCapabilities?.loadSession,
  );

  // 会话建立：三级恢复链（对标 DeepChat acpSessionManager）——
  //   ① session/load（resumeId 存在且能力未显式声明 false）
  //   ② load 失败/被跳过 → 同连接 session/new（降级：连接本身健康，kill 重开
  //      白丢 stderr 上下文与一次 spawn 开销；new 也失败才走 openSession 的 kill 清理）
  //   ③ new 失败 → 原样上抛（外层 H8 catch 兜底 kill）
  if (resumeSessionId) {
    // 能力预检：显式 false 才视为不支持（undefined = 老 harness 未声明，宽松尝试）
    const loadSupported = agentCapabilities?.loadSession !== false;
    if (!loadSupported) {
      console.info("[acp] loadSession=false，跳过 session/load 直接 session/new");
    }
    let loaded = false;
    if (loadSupported) {
      try {
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
        sessionOrigin = "loaded";
        loaded = true;
        console.info("[acp] session/load 完成 sessionId=", resumeSessionId);
      } catch (e) {
        // 降级：清掉回放中已入队的半截 update（属于已失败的 load，不能算进新会话）
        loadError = String(e);
        console.warn("[acp] session/load 失败，降级 session/new：", loadError);
        drainQueue();
      }
    }
    if (!loaded) {
      const resp = await withStartupGuard(
        connection.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, {
          cwd,
          mcpServers: [],
        }),
        "session/new",
        { closed: opts.closed, stderrTail: opts.stderrTail, timeoutMs: opts.initTimeoutMs },
      );
      boundSessionId = resp.sessionId;
      sessionOrigin = "degraded-new";
      loadError = loadError ?? "session/load 失败";
      newConfigOptions = resp.configOptions ?? null;
      console.info("[acp] 降级 session/new 完成 sessionId=", resp.sessionId);
    }
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
    newConfigOptions = resp.configOptions ?? null;
    console.info("[acp] session/new 完成 sessionId=", resp.sessionId);
  }

  const sessionId = boundSessionId;

  // P29：configOptions 存档（模型选择器数据源；config_option_update 通知实时刷新）
  let configOptions: acp.SessionConfigOption[] | null = newConfigOptions;

  return {
    sessionId,
    capabilities: agentCapabilities,
    agentInfo,
    sessionOrigin,
    ...(loadError !== undefined ? { loadError } : {}),
    get configOptions() {
      return configOptions;
    },
    async setConfigOption(configId, value) {
      try {
        const resp = await connection.agent.request(acp.methods.agent.session.setConfigOption as any, {
          sessionId,
          configId,
          value,
        });
        // 响应带全量最新 configOptions → 存档刷新（currentValue 已更新）
        const opts = (resp as { configOptions?: acp.SessionConfigOption[] })?.configOptions;
        if (Array.isArray(opts)) configOptions = opts;
        return configOptions;
      } catch (e) {
        console.warn("[acp] session/set_config_option 失败:", e);
        return null;
      }
    },
    async prompt(text, onOutgoing) {
      console.info("[acp] session/prompt 开始 sessionId=", sessionId);
      // prompt 入口丢弃滞留 update：上一 turn 250ms 有界补派发的漏网尾巴
      //（迟到 tool_call_update/usage 等）若被本 turn 消费会错误归属（迟到
      // agent_text 混进新 turn）。丢弃代价可接受：usage 下一 turn 会重报，
      // tool 状态视觉停在非终态；available_commands_update 不经队列不受影响
      while (updateQueue.length) {
        const dropped = updateQueue.shift()!;
        console.warn("[acp] prompt 入口丢弃滞留 update:", dropped.update.sessionUpdate);
      }
      const promptPromise = connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      // 标记已处理：循环经 procDied 抛出退出后，SDK 会因连接断开 reject 掉
      // 这个没人 await 的 promise → unhandled rejection（noop catch 不影响
      // race/await 处照常拿到 rejection）
      promptPromise.catch(() => {});
      // 进程退出兜底：harness 中途死亡（被 kill / 崩溃）时 response 可能永不
      // settle → 主循环悬挂在 nextUpdate，UI 停在 busy，滞留 update 无界堆积。
      // closed 进 race：死亡即报错收口（ChatPanel catch 会提示并回插队列）。
      // 复用同一个 promise 对象：race 会为它挂 handler，正常结束后
      // closed 后到不会触发 unhandled rejection。
      const procDied: Promise<never> = opts.closed
        ? opts.closed.then(({ code }): never => {
            throw new Error(
              `turn 执行中 harness 进程退出${code === null || code === undefined ? "（被信号终止）" : `（退出码 ${code}）`}`,
            );
          })
        : new Promise<never>(() => {});
      // turn 正常结束后 closed 后到（空闲回收 kill）会让 procDied 悬空 reject，
      // 挂无害 catch 标记已处理；race 内 await 该 promise 仍正常拿到 rejection
      procDied.catch(() => {});
      // 消费 update 直到 response resolve（本轮结束）
      for (;;) {
        const t = takeUpdate();
        const msg = await Promise.race([t.promise, promptPromise.then(() => null), procDied]);
        if (msg === null) {
          t.cancel(); // race 输给结束信号：摘 waiter（期间到达的消息回插队首）
          break;
        }
        dispatchUpdate(msg, onOutgoing);
      }
      const resp = await promptPromise;
      // H12（F4）：response resolve 与最后几条 update（usage_update 等）存在竞速——
      // 不能直接丢弃：把队列里残余 update 派发完再收口。
      // 「有界」前提不成立（事故实锤：滞留 update 会先于 250ms 空闲判据持续
      // 到达，循环永不退出，每条派发全量重渲染 → WebView 主线程满载冻结）。
      // 双上限强制收口：时间 5s / 条数 1000，超限丢弃剩余滞留（后果同入口
      // 丢弃逻辑：usage 下一 turn 重报，tool 状态停在非终态）。
      const drainDeadline = Date.now() + 5_000;
      let drained = 0;
      for (;;) {
        const remaining = drainDeadline - Date.now();
        if (remaining <= 0 || drained >= 1_000) {
          const dropped = updateQueue.length;
          drainQueue();
          console.warn(`[acp] 收尾补派达上限（${drained} 条）收口，丢弃滞留 update ${dropped} 条`);
          break;
        }
        // 进程死亡在收尾阶段不再升级为错误（response 已正常拿到，turn 成功），
        // 视同空闲直接收口
        const t = takeUpdate();
        const msg = await Promise.race([
          t.promise,
          new Promise<null>((r) => setTimeout(() => r(null), Math.min(250, remaining))),
          opts.closed ? opts.closed.then(() => null) : new Promise<null>(() => {}),
        ]);
        if (msg === null) {
          t.cancel(); // 同上：输给空闲/死亡信号才摘 waiter
          break;
        }
        dispatchUpdate(msg, onOutgoing);
        drained++;
      }
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
        // P30：kind/rawInput 透传（字段缺省时不带键，保持事件形状干净）
        ...(u.update.kind ? { kind: u.update.kind } : {}),
        ...("rawInput" in u.update ? { rawInput: u.update.rawInput } : {}),
        content: toToolContent(u.update.content),
      });
      break;
    case "tool_call_update":
      onOutgoing({
        type: "tool_update",
        toolCallId: u.update.toolCallId,
        status: u.update.status ?? null,
        ...(u.update.kind ? { kind: u.update.kind } : {}),
        ...("rawInput" in u.update ? { rawInput: u.update.rawInput } : {}),
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
    case "config_option_update":
      // P29：会话配置选项全量刷新（模型切换 currentValue 实时更新）
      onOutgoing({ type: "config_options", options: u.update.configOptions });
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
