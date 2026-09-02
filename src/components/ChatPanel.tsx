// 单会话聊天面板：独立的 AcpSession、消息列表、权限弹窗。
// 由 App 作为多 Tab 编排的单元。每个 ChatPanel 绑定一个 adapter 与一个会话。
//
// P3 渲染升级：
//   - assistant 文本走 react-markdown（GFM + 代码高亮）
//   - thinking 块折叠显示
//   - 工具调用的 Diff 内容渲染为 diff 视图

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openSession, type AcpSession } from "../acp/session";
import type { ToolContent } from "../acp/session-core";
import type { AdapterWithStatus } from "../config/adapters";

type ChatMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "thought"; text: string }
  | { role: "tool"; toolCallId: string; title: string; status: string; content: ToolContent[] };

function upsertLast(messages: ChatMsg[], next: ChatMsg): ChatMsg[] {
  if (messages.length > 0 && messages[messages.length - 1].role === next.role) {
    const copy = [...messages];
    copy[copy.length - 1] = next;
    return copy;
  }
  return [...messages, next];
}

interface Props {
  adapter: AdapterWithStatus;
  resumeSessionId?: string;
  onFirstPrompt?: (text: string, sessionId: string) => void;
}

export function ChatPanel({ adapter, resumeSessionId, onFirstPrompt }: Props) {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showThoughts, setShowThoughts] = useState(false);
  const sessionRef = useRef<AcpSession | null>(null);
  const toolMap = useRef(new Map<string, ChatMsg>());
  const permResolver = useRef<((d: "allow" | "reject") => void) | null>(null);
  const promptedOnce = useRef(false);

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
      let thought = "";
      await session.prompt(text, (e) => {
        switch (e.type) {
          case "agent_text":
            trailing += e.text;
            setMessages((m) => upsertLast(m, { role: "assistant", text: trailing }));
            break;
          case "agent_thought":
            thought += e.text;
            setMessages((m) => upsertLast(m, { role: "thought", text: thought }));
            break;
          case "tool_call":
            trailing = "";
            thought = "";
            const t: ChatMsg = {
              role: "tool",
              toolCallId: e.toolCallId,
              title: e.title,
              status: e.status ?? "pending",
              content: e.content,
            };
            toolMap.current.set(e.toolCallId, t);
            setMessages((m) => [...m, t]);
            break;
          case "tool_update": {
            const prev = toolMap.current.get(e.toolCallId);
            if (prev && prev.role === "tool") {
              prev.status = e.status ?? prev.status;
              if (e.content.length > 0) prev.content = e.content;
              setMessages((m) => [...m]);
            }
            break;
          }
          case "turn_stop":
            trailing = "";
            thought = "";
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

  const thoughtCount = useMemo(
    () => messages.filter((m) => m.role === "thought").length,
    [messages],
  );

  return (
    <div className="panel">
      <div className="chat">
        {starting && <div className="hint">正在启动 {adapter.name}…</div>}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="user">
              <b>你：</b>
              <span className="md">{m.text}</span>
            </div>
          ) : m.role === "assistant" ? (
            <div key={i} className="assistant">
              <b>agent：</b>
              <div className="md">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                  {m.text}
                </ReactMarkdown>
              </div>
            </div>
          ) : m.role === "thought" ? (
            <div key={i} className="thought">
              💭 {m.text}
            </div>
          ) : (
            <ToolBlock key={i} msg={m} />
          ),
        )}
        {thoughtCount > 0 && (
          <button className="thought-toggle" onClick={() => setShowThoughts((v) => !v)}>
            {showThoughts ? "隐藏" : "显示"}思考过程（{thoughtCount}）
          </button>
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

function ToolBlock({ msg }: { msg: Extract<ChatMsg, { role: "tool" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen((v) => !v)} title={msg.title}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        🔧 {msg.title} <span className="status">{msg.status}</span>
      </div>
      {open && msg.content.length > 0 && (
        <div className="tool-body">
          {msg.content.map((c, i) => (
            <ToolContentView key={i} content={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolContentView({ content }: { content: ToolContent }) {
  switch (content.kind) {
    case "text":
      return (
        <pre className="tool-text">
          <code>{content.text}</code>
        </pre>
      );
    case "diff":
      return <DiffView path={content.diff.path} oldText={content.diff.oldText} newText={content.diff.newText} />;
    case "terminal":
      return <div className="tool-terminal">🖥 终端 {content.terminal.terminalId}</div>;
  }
}

function DiffView({ path, oldText, newText }: { path: string; oldText?: string | null; newText: string }) {
  // 简单的行级 diff：无第三方库，按行对照（unified 风格，P3 够用）
  const oldLines = (oldText ?? "").split("\n");
  const newLines = newText.split("\n");
  const rows: { type: "del" | "add" | "ctx"; line: string }[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) rows.push({ type: "ctx", line: o ?? "" });
    else {
      if (o !== undefined) rows.push({ type: "del", line: o });
      if (n !== undefined) rows.push({ type: "add", line: n });
    }
  }
  return (
    <div className="diff">
      <div className="diff-path">{path}</div>
      {rows.map((r, i) => (
        <div key={i} className={`diff-line ${r.type}`}>
          <span className="diff-sign">{r.type === "add" ? "+" : r.type === "del" ? "-" : " "}</span>
          {r.line}
        </div>
      ))}
    </div>
  );
}
