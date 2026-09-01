import { useState, useRef } from "react";
import { openSession, type AcpSession } from "./acp/session";
import "./App.css";

type ChatMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; title: string; status: string };

// 硬编码 omp 适配器（P0 已验证的默认值）
const ADAPTER = {
  id: "omp",
  name: "Oh My Pi",
  program: "omp",
  args: ["acp", "--model", "duo-king-6.6"],
  cwd: "/Users/zhubaoduo/dev/ainone-ui",
};

/** 把最后一条 assistant 消息置为指定文本；若末尾不是 assistant 则追加一条 */
function upsertAssistant(messages: ChatMsg[], text: string): ChatMsg[] {
  if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
    const copy = [...messages];
    copy[copy.length - 1] = { role: "assistant", text };
    return copy;
  }
  return [...messages, { role: "assistant", text }];
}

function App() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const sessionRef = useRef<AcpSession | null>(null);
  const toolMap = useRef(new Map<string, ChatMsg>());

  async function ensureSession() {
    if (sessionRef.current) return sessionRef.current;
    const s = await openSession(ADAPTER, async (params) => {
      // 阻塞在权限审批弹窗，直到用户点「允许/拒绝」
      setPending(params.toolCall.title ?? "（无标题工具调用）");
      const decision = await new Promise<"allow" | "reject">((resolve) => {
        (window as never as { __resolvePerm?: (d: "allow" | "reject") => void }).__resolvePerm =
          resolve;
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
    });
    sessionRef.current = s;
    return s;
  }

  async function submit() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      const session = await ensureSession();
      // 本轮累积的 assistant 流式文本：每来一块就整体替换最后一条 assistant 消息
      let trailing = "";
      await session.prompt(text, (e) => {
        switch (e.type) {
          case "agent_text":
            trailing += e.text;
            setMessages((m) => upsertAssistant(m, trailing));
            break;
          case "tool_call":
            trailing = "";
            const t: ChatMsg = {
              role: "tool",
              title: e.title,
              status: e.status ?? "pending",
            };
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
            // agent_thought / error 等 P1 不渲染
            break;
        }
      });
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: `⚠️ ${String(err)}` }]);
    } finally {
      setBusy(false);
    }
  }

  function onPerm(d: "allow" | "reject") {
    (window as never as { __resolvePerm?: (d: "allow" | "reject") => void }).__resolvePerm?.(d);
  }

  return (
    <main className="container">
      <h1>ainone-ui · Agent in One</h1>
      <p className="hint">
        harness: {ADAPTER.name}（{ADAPTER.args.join(" ")}）
      </p>

      <div className="chat">
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
          placeholder="给 agent 发消息…"
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          {busy ? "运行中…" : "发送"}
        </button>
      </form>
    </main>
  );
}

export default App;
