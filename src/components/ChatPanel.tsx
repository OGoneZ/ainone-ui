// 单会话聊天面板：独立的 AcpSession 进程 + 全局 store 里的运行时。
// 由 App 作为多 Tab 编排的单元（tabKey 唯一）。消息状态不在本组件内，
// 而在 zustand store（F-4-8），切换 Tab 不丢失消息；另有 JSONL 日志兜底持久化（F-4-3）。
//
// P4 渲染升级（F-4-1/F-4-2）：
//   - 用户消息右侧气泡；agent 消息左侧气泡 + 品牌色首字母头像
//   - 一轮 agent 回复内部 blocks 顺序渲染：text / thought / tool
//   - thinking 流式中浅色小字展开，结束后自动折叠为「已思考 N 秒」，可点击展开

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openSession, type AcpSession } from "../acp/session";
import { logRead, logAppend } from "../config/sessions";
import { parseLog, serializeMessages, type BlockMsg } from "../acp/message-log";
import { newTurn, applyEvent, type TurnAccumulator } from "../acp/turn";
import { isSlashInput, filterCommands, completeCommand } from "../acp/slash";
import {
  useSessionStore,
  type ChatMsg,
  type CommandWord,
} from "../store/sessionStore";
import type { ToolContent } from "../acp/session-core";
import type { AdapterWithStatus } from "../config/adapters";

interface Props {
  tabKey: string;
  adapter: AdapterWithStatus;
  resumeSessionId?: string;
  onFirstPrompt?: (text: string, sessionId: string) => void;
}

export function ChatPanel({ tabKey, adapter, resumeSessionId, onFirstPrompt }: Props) {
  const rt = useSessionStore((s) => s.runtime[tabKey]);
  const messages = rt?.messages ?? [];
  const busy = rt?.busy ?? false;
  const commands = useSessionStore((s) => s.commands[adapter.id] ?? []);

  const ensure = useSessionStore((s) => s.ensure);
  const drop = useSessionStore((s) => s.drop);
  const appendUser = useSessionStore((s) => s.appendUser);
  const setMessages = useSessionStore((s) => s.setMessages);
  const bindSession = useSessionStore((s) => s.bindSession);
  const patch = useSessionStore((s) => s.patch);
  const setCommands = useSessionStore((s) => s.setCommands);

  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  // 恢复会话但日志缺失/损坏时降级提示（F-4-3）
  const [historyDegraded, setHistoryDegraded] = useState(false);
  // slash 补全：高亮项下标，-1 = 无（未展开或已收起）
  const [slashIdx, setSlashIdx] = useState(-1);
  const slashRef = useRef<HTMLTextAreaElement | null>(null);

  // slash 候选（F-4-7）：输入以 / 开头才计算
  const slashOpen = isSlashInput(input);
  const slashMatches = useMemo(
    () => (slashOpen ? filterCommands(commands, input) : []),
    [commands, input, slashOpen],
  );

  const sessionRef = useRef<AcpSession | null>(null);
  const permResolver = useRef<((d: "allow" | "reject") => void) | null>(null);
  // 恢复会话时已写过索引，续聊不应重写标题 → 标记为“已 prompt”
  const promptedOnce = useRef(Boolean(resumeSessionId));
  // steering：运行中打断时，待发消息暂存于此，当前 turn 结束后自动续跑
  const pendingTextRef = useRef<string | null>(null);
  // 当前 turn 的 blocks 累加器（流式事件 → 块结构，见 acp/turn.ts）
  const turnRef = useRef(newTurn());
  // 已落盘的消息条数（JSONL 日志增量追加的游标）
  const persistedRef = useRef(0);

  // 挂载：建立 store 运行时；恢复会话时先读本地日志回填 UI（不依赖进程，进程懒开）
  useEffect(() => {
    ensure(tabKey, adapter.id);
    if (resumeSessionId) {
      logRead(resumeSessionId)
        .then((raw) => {
          const msgs = parseLog(raw);
          if (msgs.length > 0) {
            setMessages(tabKey, msgs);
            persistedRef.current = msgs.length;
          } else {
            setHistoryDegraded(true);
          }
        })
        .catch(() => setHistoryDegraded(true));
    }
    return () => {
      sessionRef.current?.dispose().catch(() => {});
      drop(tabKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureSession() {
    if (sessionRef.current) return sessionRef.current;
    setStarting(true);
    try {
      const s = await openSession(
        adapter,
        async (params) => {
          patch(tabKey, { pending: params.toolCall.title ?? "（无标题工具调用）" });
          const decision = await new Promise<"allow" | "reject">((resolve) => {
            permResolver.current = resolve;
          });
          patch(tabKey, { pending: null });
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
        (words: CommandWord[]) => setCommands(adapter.id, words),
      );
      sessionRef.current = s;
      bindSession(tabKey, s.sessionId);
      return s;
    } finally {
      setStarting(false);
    }
  }

  async function submit() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setSlashIdx(-1);
    appendUser(tabKey, text);

    // steering：运行中发消息 → 取消当前 turn，把新消息排队，turn 结束后自动续跑
    if (busy) {
      await stop();
      pendingTextRef.current = text;
      return;
    }
    await runPrompt(text);
  }

  // slash 选中回填：命令名回填输入框，光标留在命令后（不自动发送）
function pickSlash(w: CommandWord) {
    setInput(completeCommand(w));
    setSlashIdx(-1);
    slashRef.current?.focus();
  }

  const runRef = useRef<{ promise: Promise<void> } | null>(null);

  async function runPrompt(text: string) {
    patch(tabKey, { busy: true });
    turnRef.current = newTurn();
    const p = (async () => {
      try {
        const session = await ensureSession();
        if (!promptedOnce.current) {
          promptedOnce.current = true;
          onFirstPrompt?.(text, session.sessionId);
        }
        await session.prompt(text, (e) => {
          if (e.type === "available_commands") {
            setCommands(adapter.id, e.commands);
            return;
          }
          const next = applyEvent(turnRef.current, e, Date.now);
          turnRef.current = next;
          useSessionStore.getState().updateLastAssistant(tabKey, () => next.blocks);
        });
        // turn 结束：摊平 blocks 到 store（applyEvent 已封口 thinking）
        useSessionStore.getState().updateLastAssistant(tabKey, () => turnRef.current.blocks);
      } catch (err) {
        const next: TurnAccumulator = {
          ...turnRef.current,
          blocks: [...turnRef.current.blocks, { kind: "text", text: `\n\n⚠️ ${String(err)}` }],
        };
        useSessionStore.getState().updateLastAssistant(tabKey, () => next.blocks);
      } finally {
        patch(tabKey, { busy: false });
        runRef.current = null;
        // 落盘增量（turn 结束一次性追加，避免流式期间高频 IO）
        persistNew();
        // steering 排队续跑
        const queued = pendingTextRef.current;
        pendingTextRef.current = null;
        if (queued) void runPrompt(queued);
      }
    })();
    runRef.current = { promise: p };
  }

  // —— 落盘：turn 结束一次性追加增量 ——
  function persistNew() {
    const sid = sessionRef.current?.sessionId;
    if (!sid) return;
    const msgs = useSessionStore.getState().runtime[tabKey]?.messages ?? [];
    const count = persistedRef.current;
    if (msgs.length <= count) return;
    const lines = serializeMessages(msgs.slice(count));
    persistedRef.current = msgs.length;
    logAppend(sid, lines).catch(() => {});
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

  const pending = rt?.pending ?? null;

  // 长会话虚拟列表（AC-P3-5 回归）：只渲染可见区消息
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => chatScrollRef.current,
    estimateSize: () => 120,
    overscan: 8,
  });

  const empty = messages.length === 0;

  return (
    <div className="panel">
      <div className="chat" ref={chatScrollRef}>
        {starting && <div className="hint">正在启动 {adapter.name}…</div>}
        {empty && !historyDegraded && <Welcome onSuggest={(t) => setInput(t)} />}
        {empty && historyDegraded && (
          <div className="hint degraded">⚠️ 上下文已恢复，历史消息未找到</div>
        )}
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const m = messages[vi.index];
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <MessageLine msg={m} adapter={adapter} busy={busy} isLast={vi.index === messages.length - 1} />
              </div>
            );
          })}
        </div>
        {pending && (
          <div className="perm">
            需要批准执行：<code>{pending}</code>
            <button onClick={() => onPerm("allow")}>允许</button>
            <button onClick={() => onPerm("reject")}>拒绝</button>
          </div>
        )}
      </div>

      <div className="harness-badge">正在和 {adapter.name} 对话</div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="input-wrap">
          {slashOpen && slashMatches.length > 0 && (
            <div className="slash-menu">
              {slashMatches.map((w, i) => (
                <button
                  type="button"
                  key={w.name}
                  className={i === slashIdx ? "slash-item active" : "slash-item"}
                  onMouseDown={(e) => {
                    e.preventDefault(); // 抢在 textarea blur 前选中
                    pickSlash(w);
                  }}
                >
                  <span className="slash-name">/{w.name}</span>
                  <span className="slash-desc">{w.description}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={slashRef}
            value={input}
            onChange={(e) => {
              setInput(e.currentTarget.value);
              setSlashIdx(-1); // 输入变化重置高亮
            }}
            onKeyDown={(e) => {
              if (slashOpen && slashMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIdx((i) => (i + 1) % slashMatches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashIdx((i) => (i <= 0 ? slashMatches.length - 1 : i - 1));
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  pickSlash(slashMatches[slashIdx >= 0 ? slashIdx : 0]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashIdx(-1);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={busy ? "运行中，输入将打断当前 turn…" : `给 ${adapter.name} 发消息…`}
            disabled={starting}
            rows={1}
          />
        </div>
        <button type="submit" disabled={starting}>
          {starting ? "启动中…" : busy ? "打断并发送" : "发送"}
        </button>
        <button type="button" onClick={stop} disabled={!busy}>
          停止
        </button>
      </form>
    </div>
  );
}

function Welcome({ onSuggest }: { onSuggest: (t: string) => void }) {
  const suggestions = [
    "帮我看看这个项目是做什么的",
    "总结当前目录的结构",
    "写一个 Hello World",
  ];
  return (
    <div className="welcome">
      <h2>你好！我可以帮你做什么？</h2>
      <div className="suggestions">
        {suggestions.map((s) => (
          <button key={s} className="suggestion" onClick={() => onSuggest(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// —— 消息行渲染：user 右气泡 / assistant 左气泡 + 头像 ——
function MessageLine({
  msg,
  adapter,
  busy,
  isLast,
}: {
  msg: ChatMsg;
  adapter: AdapterWithStatus;
  busy: boolean;
  isLast: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className="line user-line">
        <div className="bubble user-bubble">{msg.text}</div>
      </div>
    );
  }
  return (
    <div className="line assistant-line">
      <Avatar adapter={adapter} />
      <div className="bubble assistant-bubble">
        {msg.blocks.map((b, i) => (
          <BlockView
            key={i}
            block={b}
            live={busy && isLast && i === msg.blocks.length - 1 && b.kind === "thought" && b.ms === undefined}
          />
        ))}
      </div>
    </div>
  );
}

function Avatar({ adapter }: { adapter: AdapterWithStatus }) {
  const ch = adapter.name.trim().charAt(0).toUpperCase() || "?";
  const bg = adapter.logo || "#9e9e9e";
  return (
    <span className="avatar" style={{ background: bg }} title={adapter.name}>
      {ch}
    </span>
  );
}

function BlockView({ block, live }: { block: BlockMsg; live: boolean }) {
  switch (block.kind) {
    case "text":
      return (
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {block.text}
          </ReactMarkdown>
        </div>
      );
    case "thought":
      return <ThoughtView text={block.text} ms={block.ms} live={live} />;
    case "tool":
      return (
        <ToolBlock
          toolCallId={block.toolCallId}
          title={block.title}
          status={block.status}
          content={block.content}
        />
      );
  }
}

function ThoughtView({ text, ms, live }: { text: string; ms?: number; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => {
    // 流式结束（live true→false）自动折叠
    if (!live) setOpen(false);
  }, [live]);
  const summary =
    ms !== undefined ? `已思考 ${(ms / 1000).toFixed(0)} 秒` : "思考中…";
  return (
    <div className="thought" data-live={live ? "true" : "false"}>
      <button className="thought-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        <span className="thought-summary">{summary}</span>
      </button>
      {open && <div className="thought-body">{text}</div>}
    </div>
  );
}

function ToolBlock({
  title,
  status,
  content,
}: {
  toolCallId: string;
  title: string;
  status: string;
  content: ToolContent[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen((v) => !v)} title={title}>
        <span className="caret">{open ? "▾" : "▸"}</span>
        🔧 {title} <span className="status">{status}</span>
      </div>
      {open && content.length > 0 && (
        <div className="tool-body">
          {content.map((c, i) => (
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
      return (
        <DiffView path={content.diff.path} oldText={content.diff.oldText} newText={content.diff.newText} />
      );
    case "terminal":
      return <div className="tool-terminal">🖥 终端 {content.terminal.terminalId}</div>;
  }
}

function DiffView({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
}) {
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
