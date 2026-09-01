// ACP 客户端会话层：封装官方 @agentclientprotocol/sdk，向 React 暴露最小接口。
//
// 职责边界（见 plan.md DEC-7）：
//   - 协议状态机、JSONL 切行、请求 id 关联 → 全部交给 SDK
//   - 这里只做三件业务粘合：
//       1) 把 harness 进程的字节流接到 SDK（bridge.spawnHarness）
//       2) 把 SDK 的 fs/* 回调接到 Rust（invoke fd_read / fd_write）
//       3) 把 SDK 的权限请求转成「可等待用户决策」的异步约定

import * as acp from "@agentclientprotocol/sdk";
import { invoke } from "@tauri-apps/api/core";
import { spawnHarness } from "./bridge";

export type Outgoing =
  | { type: "agent_text"; text: string; messageId?: string | null }
  | { type: "agent_thought"; text: string }
  | { type: "tool_call"; toolCallId: string; title: string; status?: string | null }
  | { type: "tool_update"; toolCallId: string; status?: string | null }
  | { type: "turn_stop"; stopReason: string }
  | { type: "error"; message: string };

export type Adapter = { id: string; name: string; program: string; args: string[]; cwd: string };

/** 权限请求被挂起时，交给 UI 决策；resolve 掉 SDK 就继续 */
export type PermissionDecision = (
  params: acp.RequestPermissionRequest,
) => Promise<acp.RequestPermissionResponse>;

export interface AcpSession {
  /** 会话语义下的唯一 id（来自 session/new），可用于后续恢复 */
  sessionId: string;
  /** 发送一条用户消息，逐事件回调 onOutgoing（含流式文本与工具状态） */
  prompt(text: string, onOutgoing: (e: Outgoing) => void): Promise<void>;
  /** 终止会话：关连接 + 杀子进程 */
  dispose(): Promise<void>;
}

/**
 * 拉起一个 harness 会话。
 * @param adapter 适配器配置
 * @param onPermission UI 侧权限决策回调（阻塞式）
 */
export async function openSession(
  adapter: Adapter,
  onPermission: PermissionDecision,
): Promise<AcpSession> {
  const proc = await spawnHarness(adapter.program, adapter.args, adapter.cwd);

  const app = acp
    .client({ name: "ainone-ui" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
      onPermission(ctx.params),
    )
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
      const content = await invoke<string>("fd_read", { path: ctx.params.path });
      return { content };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      await invoke("fd_write", { path: ctx.params.path, content: ctx.params.content });
      return {};
    });

  const stream = acp.ndJsonStream(proc.stdin, proc.stdout);

  const connection = app.connect(stream);

  // stderr 只进日志，不进协议
  void (async () => {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) console.warn("[harness stderr]", dec.decode(value));
    }
  })();

  const initResult = await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
    },
  });
  console.log(`[acp] 已连接 ${initResult.agentInfo?.name ?? "agent"} protocol v${initResult.protocolVersion}`);

  const session = await connection.agent.buildSession(adapter.cwd).start();

  return {
    sessionId: session.sessionId,
    async prompt(text, onOutgoing) {
      const promptResponse = session.prompt(text);
      // 流式读取直到本轮结束
      for (;;) {
        const msg = await session.nextUpdate();
        if (msg.kind === "stop") {
          onOutgoing({ type: "turn_stop", stopReason: msg.stopReason });
          await promptResponse;
          return;
        }
        const u = msg.update;
        switch (u.sessionUpdate) {
          case "agent_message_chunk":
            if (u.content.type === "text") {
              onOutgoing({
                type: "agent_text",
                text: u.content.text,
                messageId: u.messageId,
              });
            }
            break;
          case "agent_thought_chunk":
            if (u.content.type === "text") {
              onOutgoing({ type: "agent_thought", text: u.content.text });
            }
            break;
          case "tool_call":
            onOutgoing({
              type: "tool_call",
              toolCallId: u.toolCallId,
              title: u.title,
              status: u.status ?? null,
            });
            break;
          case "tool_call_update":
            onOutgoing({
              type: "tool_update",
              toolCallId: u.toolCallId,
              status: u.status ?? null,
            });
            break;
          default:
            // 其余 update 类型（plan/file_change/usage 等）P1 安全忽略
            break;
        }
      }
    },
    async dispose() {
      try {
        connection.close();
      } catch {
        /* ignore */
      }
      await proc.child.kill().catch(() => {});
    },
  };
}
