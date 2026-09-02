// 单会话聊天面板：独立的 AcpSession、消息列表、权限弹窗。
// 由 App 作为多 Tab 编排的单元。每个 ChatPanel 绑定一个 adapter 与一个会话。

import { useEffect, useRef, useState } from "react";
import { openSession, type AcpSession } from "../acp/session";
import type { AdapterWithStatus } from "../config/adapters";

export type ChatMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; toolCallId: string; title: string; status: string };

function upsertAssistant(messages: ChatMsg[], text: string): ChatMsg[] {
  if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
    const copy = [...messages];
    copy[copy.length - 1] = { role: "assistant", text };
    return copy;
  }
  return [...messages, { role: "assistant", text }];
}

interface Props {
  adapter: AdapterWithStatus;
  resumeSessionId?: string;
  onFirstPrompt?: (text: string, sessionId: string) => void; // 首条消息发出后回调（用于写会话索引标题）
}

export function ChatPanel({ adapter, resumeSessionId, onFirstPrompt }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const sessionRef = useRef<AcpSession | null>(null);
  const toolMap = useRef(new Map<string, ChatMsg>());
  const permResolver = useRef<((d: "allow" | "reject") => void) | null>(null);
  const promptedOnce = useRef(false);

  // 卸载时清理子进程（关闭 Tab 不留残留）
  useEffect(() => {
    return () => {
      sessionRef.current?.dispose().catch(() => {});
    };
  }, []);

  async function ensureSession() {
    if (sessionRef.current) return sessionRef.current;
    setStarting(true);
    try {
      const s = await openSession(
        adapter,
        async (params) => {
          setPending(params.toolCall.title ?? "（无标题工具调用）");
          const decision = await new Promise<"allow" | "reject">((resolve) => {
            permResolver.current = resolve;
          });
          setPending(null);
          const target = params.options.find((o) =>
            decision === "allow" ? o.kind === "allow_once" : o.kind === "reject_once",
          );
          return {
            outcome: {
              outcome: "selected",
              optionId: target?.optionId ?? params.options[0].optionId,
            },
          };
        },
        resumeSessionId,
      );
      sessionRef.current = s;
      return s;
    } finally {
      setStarting(false);
    }
  }

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      const session = await ensureSession();
      if (!promptedOnce.current) {
        promptedOnce.current = true;
        onFirstPrompt?.(text, session.sessionId);
      }
      let trailing = "";
      await session.prompt(text, (e) => {
        switch (e.type) {
          case "agent_text":
            trailing += e.text;
            setMessages((m) => upsertAssistant(m, trailing));
            break;
          case "tool_call":
            trailing = "";
            const t: ChatMsg = { role: "tool", toolCallId: e.toolCallId, title: e.title, status: e.status ?? "pending" };
            toolMap.current.set(e.toolCallId, t);
            setMessages((m) => [...m, t]);
            break;
          case "tool_update": {
            const prev = toolMap.current.get(e.toolCallId);
            if (prev && prev.role === "tool") {
              prev.status = e.status ?? prev.status;
              setMessages((m) => [...m]);
            }
            break;
          }
          case "turn_stop":
            trailing = "";
            break;
          default:
            break;
        }
      });
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: `⚠️ ${String(err)}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!busy) return;
    try {
      await sessionRef.current?.cancel();
    } catch {
      /* ignore */
    }
  }

  function onPerm(d: "allow" | "reject") {
    permResolver.current?.(d);
    permResolver.current = null;
  }

  return (
    <div className="panel">
      <div className="chat">
        {starting && <div className="hint">正在启动 {adapter.name}…</div>}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="user">
              <b>你：</b>
              {m.text}
            </div>
          ) : m.role === "assistant" ? (
            <div key={i} className="assistant">
              <b>agent：</b>
              {m.text}
            </div>
          ) : (
            <div key={i} className="tool" title={m.title}>
              🔧 {m.title} <span className="status">{m.status}</span>
            </div>
          ),
        )}
        {pending && (
          <div className="perm">
            需要批准执行：<code>{pending}</code>
            <button onClick={() => onPerm("allow")}>允许</button>
            <button onClick={() => onPerm("reject")}>拒绝</button>
          </div>
        )}
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          placeholder={`给 ${adapter.name} 发消息…`}
          disabled={busy || starting}
        />
        <button type="submit" disabled={busy || starting}>
          {starting ? "启动中…" : busy ? "运行中…" : "发送"}
        </button>
        <button type="button" onClick={stop} disabled={!busy}>
          停止
        </button>
      </form>
    </div>
  );
}
