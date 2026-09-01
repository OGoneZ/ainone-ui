import { useEffect, useRef, useState } from "react";
import { openSession, type AcpSession } from "./acp/session";
import { listAdapters, type AdapterWithStatus } from "./config/adapters";
import { SettingsModal } from "./components/SettingsModal";
import "./App.css";

type ChatMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; title: string; status: string };

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
  const [adapters, setAdapters] = useState<AdapterWithStatus[]>([]);
  const [adapterId, setAdapterId] = useState<string>("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sessionRef = useRef<AcpSession | null>(null);
  const toolMap = useRef(new Map<string, ChatMsg>());
  // 权限决策的 resolve（存在 window 上，供弹窗按钮回调）
  const permResolver = useRef<((d: "allow" | "reject") => void) | null>(null);

  // 加载适配器列表
  function reloadAdapters() {
    listAdapters().then((list) => {
      setAdapters(list);
      setAdapterId((cur) => (list.some((a) => a.id === cur) ? cur : list[0]?.id ?? ""));
    });
  }
  useEffect(() => {
    reloadAdapters();
  }, []);

  const currentAdapter = adapters.find((a) => a.id === adapterId);

  async function ensureSession() {
    if (sessionRef.current) return sessionRef.current;
    if (!currentAdapter) throw new Error("未选择 harness");
    const s = await openSession(currentAdapter, async (params) => {
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

  /** 切换 harness：销毁旧子进程并清空会话 */
  async function switchAdapter(id: string) {
    if (id === adapterId) return;
    setAdapterId(id);
    setMessages([]);
    toolMap.current.clear();
    if (sessionRef.current) {
      await sessionRef.current.dispose().catch(() => {});
      sessionRef.current = null;
    }
  }

  function onPerm(d: "allow" | "reject") {
    permResolver.current?.(d);
    permResolver.current = null;
  }

  return (
    <main className="container">
      <h1>ainone-ui · Agent in One</h1>
      <div className="toolbar">
        <label>
          harness：
          <select value={adapterId} onChange={(e) => switchAdapter(e.target.value)}>
            {adapters.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.available ? "" : "（未安装）"}
              </option>
            ))}
          </select>
        </label>
        {currentAdapter && (
          <span className="hint">
            {currentAdapter.program} {currentAdapter.args.join(" ")}
          </span>
        )}
        <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
      </div>

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
        <button type="submit" disabled={busy || !currentAdapter}>
          {busy ? "运行中…" : "发送"}
        </button>
        <button type="button" onClick={stop} disabled={!busy}>
          停止
        </button>
      </form>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={reloadAdapters}
      />
    </main>
  );
}

export default App;
