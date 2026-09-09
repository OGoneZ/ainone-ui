// prompt() 消费循环防回归测试（事故：harness 中途死亡 / 收尾滞留风暴时循环无界，
// WebKit 主线程被持续全量派发钉死 100%，UI 冻结假死）。
//
// 双端接线：session-core 真实协议栈 ↔ 内存 fake harness（手搓 JSON-RPC 行），
// 与 probe-core.test.ts 同款离线思路——验证的就是生产代码路径本身。

import { describe, it, expect, vi } from "vitest";
import { createAcpSession, type Outgoing, type Streams } from "./session-core";

const SID = "s1";

interface Harness {
  streams: Streams;
  /** 发一条 session/update 通知 */
  sendUpdate(update: object): void;
  /** 回 session/prompt response（本轮结束） */
  resolvePrompt(stopReason?: string): void;
  /** 断言最近一次 prompt 请求已到达 */
  promptArrived(): Promise<void>;
}

/** 内存 fake harness：按行解析 client→agent JSON-RPC，回 initialize/session/new */
function makeHarness(): Harness {
  let outCtrl!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { outCtrl = c; } });
  const stderr = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });

  const enc = new TextEncoder();
  let promptArrivedResolve!: () => void;
  const promptArrived = new Promise<void>((r) => (promptArrivedResolve = r));
  let promptId: number | string | null = null;

  const send = (obj: object) => outCtrl.enqueue(enc.encode(JSON.stringify(obj) + "\n"));

  const lineBuf = { s: "" };
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      lineBuf.s += new TextDecoder().decode(chunk);
      let i: number;
      while ((i = lineBuf.s.indexOf("\n")) >= 0) {
        const line = lineBuf.s.slice(0, i).trim();
        lineBuf.s = lineBuf.s.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === "initialize") {
          send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        } else if (msg.method === "session/new") {
          send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: SID } });
        } else if (msg.method === "session/prompt") {
          promptId = msg.id;
          promptArrivedResolve();
        }
      }
    },
  });

  return {
    streams: { stdin, stdout, stderr },
    sendUpdate: (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID, update } }),
    resolvePrompt: (stopReason = "end_turn") => {
      if (promptId === null) throw new Error("prompt 请求未到");
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason } });
    },
    promptArrived: () => promptArrived,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function openSession(h: Harness, closed?: Promise<{ code: number | null }>) {
  return createAcpSession({
    streams: h.streams,
    cwd: "/tmp",
    onPermission: async () => ({ outcome: { outcome: "selected", optionId: "x" } } as never),
    ipc: { fsRead: async () => "", fsWrite: async () => {}, kill: async () => {} },
    ...(closed ? { closed } : {}),
  });
}

const textChunk = (t: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
const usageUpdate = { sessionUpdate: "usage_update", used: 10, size: 100 };

describe("session-core · prompt 循环边界（防回归）", () => {
  it("T1 harness 中途死亡：prompt 立即 reject（带退出码），不悬挂", async () => {
    const h = makeHarness();
    const die = deferred<{ code: number | null }>();
    const session = await openSession(h, die.promise);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const events: Outgoing[] = [];
    const p = session.prompt("hi", (e) => events.push(e));
    await h.promptArrived();
    h.sendUpdate(textChunk("半截输出"));
    await new Promise((r) => setTimeout(r, 30)); // 让死亡前的 update 确定性先派发
    die.resolve({ code: 137 });

    await expect(p).rejects.toThrow(/harness 进程退出（退出码 137）/);
    // 死亡前的 update 照常派发；turn_stop 不出现（异常收口由 ChatPanel catch 处理）
    expect(events.some((e) => e.type === "agent_text")).toBe(true);
    expect(events.some((e) => e.type === "turn_stop")).toBe(false);
    await session.dispose();
  });

  it("T2 收尾滞留风暴：drain 达条数上限强制收口，prompt 正常结束不冻结", async () => {
    const h = makeHarness();
    const session = await openSession(h);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const events: Outgoing[] = [];
    const p = session.prompt("hi", (e) => events.push(e));
    await h.promptArrived();
    // response 先回 → 主循环收口；随后 1500 条滞留 update 洪泛进收尾 drain
    h.resolvePrompt();
    for (let i = 0; i < 1500; i++) h.sendUpdate(textChunk(`x${i}`));

    await expect(p).resolves.toBeUndefined(); // 若循环无界，这里会永不 resolve（测试超时=回归）
    const agentTexts = events.filter((e) => e.type === "agent_text").length;
    expect(agentTexts).toBeLessThanOrEqual(1000); // drain 派发 ≤ 上限条数
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("收尾补派达上限"));
    expect(events[events.length - 1]).toEqual({ type: "turn_stop", stopReason: "end_turn", outputTokens: null });
    await session.dispose();
  });

  it("T3 drain 期进程死亡：视同空闲收口，turn 成功（不升级为错误）", async () => {
    const h = makeHarness();
    const die = deferred<{ code: number | null }>();
    const session = await openSession(h, die.promise);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const events: Outgoing[] = [];
    const p = session.prompt("hi", (e) => events.push(e));
    await h.promptArrived();
    h.resolvePrompt();
    h.sendUpdate(usageUpdate); // 先入队一条，保证 drain 阻塞在 nextUpdate 上
    await new Promise((r) => setTimeout(r, 30)); // 让 usage 确定性先被派发
    die.resolve({ code: null });

    await expect(p).resolves.toBeUndefined();
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "turn_stop", stopReason: "end_turn", outputTokens: null });
    await session.dispose();
  });

  it("T4 H12 迟到尾巴仍被派发；无界补派后正常收口（修复不弄坏旧语义）", async () => {
    const h = makeHarness();
    const session = await openSession(h);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const events: Outgoing[] = [];
    const p = session.prompt("hi", (e) => events.push(e));
    await h.promptArrived();
    h.sendUpdate(textChunk("正文"));
    h.resolvePrompt();
    await new Promise((r) => setTimeout(r, 60)); // 模拟「response 之后才到」的 usage
    h.sendUpdate(usageUpdate);

    await p;
    expect(events).toContainEqual({ type: "usage", used: 10, size: 100, cost: null });
    expect(events[events.length - 1]).toEqual({ type: "turn_stop", stopReason: "end_turn", outputTokens: null });
    await session.dispose();
  });

  it("T5 正常 turn 冒烟：流式 update → response → turn_stop；closed 缺席不报错", async () => {
    const h = makeHarness();
    const session = await openSession(h); // closed 未提供 → procDied 走永不 settle 分支

    const events: Outgoing[] = [];
    const p = session.prompt("hi", (e) => events.push(e));
    await h.promptArrived();
    h.sendUpdate(textChunk("a"));
    h.sendUpdate(textChunk("b"));
    h.resolvePrompt("end_turn");
    await p;

    expect(events.filter((e) => e.type === "agent_text")).toHaveLength(2);
    expect(events[events.length - 1]).toEqual({ type: "turn_stop", stopReason: "end_turn", outputTokens: null });
    await session.dispose();
  });

  it("T6 turn 正常结束后 closed 后到（空闲回收 kill）→ 无 unhandled rejection", async () => {
    const h = makeHarness();
    const die = deferred<{ code: number | null }>();
    const session = await openSession(h, die.promise);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // 本仓 tsconfig 无 @types/node（测试不碰 Node API），唯一例外：T6 要监听
    // unhandledRejection 验证 promise 卫生 → 经 globalThis 取，保持零新增依赖
    const proc = (
      globalThis as unknown as {
        process: { on: (ev: string, fn: (r: unknown) => void) => void; off: (ev: string, fn: (r: unknown) => void) => void };
      }
    ).process;
    const unhandled = vi.fn();
    proc.on("unhandledRejection", unhandled);
    try {
      const p = session.prompt("hi", () => {});
      await h.promptArrived();
      h.resolvePrompt(); // response 正常回 → drain 等 250ms 空闲收口
      await p;
      die.resolve({ code: null }); // turn 结束后进程才被回收 kill
      await new Promise((r) => setTimeout(r, 100));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      proc.off("unhandledRejection", unhandled);
    }
    await session.dispose();
  });
});
