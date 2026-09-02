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
import { composeQuotedPrompt, type Quote } from "../acp/quote";
import { composeFileReference, filterAbsoluteFiles, type FileRef } from "../acp/fileRef";
import { welcomeGreeting, suggestionsFor, typewriterHint } from "../store/welcome";
import { shouldRecycleSession, RECYCLE_THRESHOLD_MS } from "../store/recycle";
import { logger } from "../lib/logger";
import { quickAsk, quickAskConfigGet } from "../config/quickask";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  useSessionStore,
  type ChatMsg,
  type CommandWord,
} from "../store/sessionStore";
import type { ToolContent } from "../acp/session-core";
import type { AdapterWithStatus } from "../config/adapters";
import { AgentAvatar } from "./AgentAvatar";
import {
  ThinkingIcon,
  ChevronRightIcon,
  CopyIcon,
  TerminalIcon,
  ToolIcon,
  ArrowRightIcon,
  SendIcon,
  StopIcon,
  CloseIcon,
} from "./ui/icons";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { toast } from "sonner";

interface Props {
  tabKey: string;
  adapter: AdapterWithStatus;
  resumeSessionId?: string;
  /** 会话运行目录（工作区 cwd）；缺省用 adapter.cwd */
  cwd?: string;
  onFirstPrompt?: (text: string, sessionId: string) => void;
}

// F-7-6 打字机 placeholder：80ms/字循环打出；prefers-reduced-motion 直接显全文（AC-P7-6-1/6）
function useTypewriter(full: string): string {
  const [n, setN] = useState(0);
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (reduced) {
      setN(full.length);
      return;
    }
    setN(0);
    const t = setInterval(() => setN((i) => (i >= full.length ? 0 : i + 1)), 80);
    return () => clearInterval(t);
  }, [full, reduced]);
  if (reduced) return full;
  return full.slice(0, n);
}

export function ChatPanel({ tabKey, adapter, resumeSessionId, cwd, onFirstPrompt }: Props) {
  const rt = useSessionStore((s) => s.runtime[tabKey]);
  const messages = rt?.messages ?? [];
  const busy = rt?.busy ?? false;
  // 订阅整个 commands 对象（稳定引用）再取本 adapter 的列表——避免 `?? []`
  // 每次返回新数组触发 zustand「getSnapshot 未缓存」无限重渲染（白屏根因）。
  const commandsMap = useSessionStore((s) => s.commands);
  const commands = commandsMap[adapter.id] ?? [];

  const ensure = useSessionStore((s) => s.ensure);
  const drop = useSessionStore((s) => s.drop);
  const appendUser = useSessionStore((s) => s.appendUser);
  const setMessages = useSessionStore((s) => s.setMessages);
  const bindSession = useSessionStore((s) => s.bindSession);
  const patch = useSessionStore((s) => s.patch);
  const setCommands = useSessionStore((s) => s.setCommands);

  const [input, setInput] = useState("");
  const [starting, setStarting] = useState(false);
  // F-8-2 批注：已收集的多段批注（原文 + 疑问）
  const [quotes, setQuotes] = useState<Quote[]>([]);
  // 恢复会话但日志缺失/损坏时降级提示（F-4-3）
  const [historyDegraded, setHistoryDegraded] = useState(false);
  // slash 补全：高亮项下标，-1 = 无（未展开或已收起）
  const [slashIdx, setSlashIdx] = useState(-1);
  const slashRef = useRef<HTMLTextAreaElement | null>(null);

  // F-7-6 打字机 placeholder：80ms/字循环打出建议语；reduced-motion 直接显全文
  const typeText = useTypewriter(typewriterHint(adapter));

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
  // F-8-1 空闲回收：最近一次交互时间戳（prompt 发起时刷新）+ 定时器句柄
  const lastActivityRef = useRef(0);
  const recycleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // F-8-7 快问：是否已配置快问模型（未配置则入口禁用）
  const [quickAskReady, setQuickAskReady] = useState(false);
  // F-8-7 快问：选中的待解释文本 + 悬浮窗口坐标
  const [quickSel, setQuickSel] = useState<string | null>(null);
  const [quickAnchor, setQuickAnchor] = useState({ x: 120, y: 80 });
  // F-8-7 悬浮窗：null=关闭；加载中/结果/错误三态
  const [quickPop, setQuickPop] = useState<{ state: "loading" | "ok" | "error"; text: string } | null>(null);
  // F-8-3 文件引用：待发送附件集（按钮选择 / 拖拽 同路径）
  const [files, setFiles] = useState<FileRef[]>([]);
  // F-8-3 拖拽悬停高亮
  const [dragging, setDragging] = useState(false);

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
    // F-8-7 快问：读配置判定入口是否可用（未配置则禁用）
    quickAskConfigGet()
      .then((c) => setQuickAskReady(Boolean(c.base_url.trim() && c.model.trim())))
      .catch(() => setQuickAskReady(false));
    // F-8-3 拖拽：监听 Tauri 原生拖拽事件（enter/drop/leave）转附件
    // 错误环境（jsdom 测试 / 浏览器预览）静默降级——拖拽是增强能力，非必需
    let unlisten: (() => void) | undefined;
    try {
      const wv = getCurrentWebview();
      if (wv && typeof wv.onDragDropEvent === "function") {
        wv
          .onDragDropEvent(async (ev) => {
            if (ev.payload.type === "enter") setDragging(true);
            else if (ev.payload.type === "leave") setDragging(false);
            else if (ev.payload.type === "drop") {
              setDragging(false);
              const abs = filterAbsoluteFiles(ev.payload.paths.map((p) => ({ path: p })));
              if (abs.length > 0) addFiles(abs);
            }
          })
          .then((fn) => {
            unlisten = fn;
          })
          .catch(() => {});
      }
    } catch {
      /* ignore */
    };
    // F-8-1 空闲超时回收：周期检查，空闲超阈值且无运行中 turn → 回收子进程
    recycleTimerRef.current = setInterval(() => {
      const s = sessionRef.current;
      if (!s) return;
      // 读 store 快照的 busy（闭包里的 busy 是挂载时的旧值）
      const isBusy = useSessionStore.getState().runtime[tabKey]?.busy ?? false;
      if (shouldRecycleSession(lastActivityRef.current, Date.now(), RECYCLE_THRESHOLD_MS, isBusy)) {
        sessionRef.current = null;
        logger.info("session", "reopen after recycle", { sessionId: s.sessionId });
        void s.recycle(lastActivityRef.current).catch(() => {});
      }
    }, 15_000);
    return () => {
      if (recycleTimerRef.current) clearInterval(recycleTimerRef.current);
      unlisten?.();
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
        cwd,
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
    // F-8-3：组装文件引用 → 拼入发送文本（传路径语义，@file:/abs/path）
    const filePart = files.length > 0 ? composeFileReference(files) : "";
    const full = [filePart, text].filter(Boolean).join("\n\n");
    if (!full.trim()) return;
    setInput("");
    setSlashIdx(-1);
    setFiles([]);
    if (files.length > 0) logger.info("chat", "send-with-files", { count: files.length });
    appendUser(tabKey, full);

    // steering：运行中发消息 → 取消当前 turn，把新消息排队，turn 结束后自动续跑
    if (busy) {
      await stop();
      pendingTextRef.current = full;
      return;
    }
    await runPrompt(full);
  }

  // —— F-8-3 文件引用：按钮选择 / 拖拽 同一条「待发送附件」路径 ——
  async function pickFiles() {
    const picked = await open({ multiple: true, directory: false });
    const paths = picked ? (Array.isArray(picked) ? picked : [picked]) : [];
    const abs = filterAbsoluteFiles(paths.map((p) => ({ path: p })));
    addFiles(abs);
  }
  function addFiles(list: FileRef[]) {
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.path));
      const merged = [...prev];
      for (const f of list) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        merged.push(f);
        logger.info("chat", "attach-file", { path: f.path, count: merged.length });
      }
      return merged;
    });
  }
  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  // 建议 prompt 直接发送（F-6-3，不经输入框）
  function sendSuggestion(text: string) {
    appendUser(tabKey, text);
    if (busy) {
      pendingTextRef.current = text;
      return;
    }
    void runPrompt(text);
  }

  // —— F-8-2 批注引用：选中 → 批注卡 → 统一发送 ——
  function addQuote(text: string) {
    setQuotes((qs) => [...qs, { text, question: "" }]);
  }
  function setQuoteQuestion(idx: number, question: string) {
    setQuotes((qs) => qs.map((q, i) => (i === idx ? { ...q, question } : q)));
  }
  function removeQuote(idx: number) {
    setQuotes((qs) => qs.filter((_, i) => i !== idx));
  }
  function sendQuotes() {
    if (quotes.length === 0) return;
    const text = composeQuotedPrompt(quotes);
    setQuotes([]);
    logger.info("chat", "annotate-send", { quoteCount: quotes.length });
    appendUser(tabKey, text);
    // 与 steering 兼容：运行中发送 → 打断当前 turn 后新发起（复用打断队列）
    if (busy) {
      void stop();
      pendingTextRef.current = text;
      return;
    }
    void runPrompt(text);
  }

  // —— F-8-7 快问：选中 → 快速解释 → 悬浮窗（不进入会话、不写日志）——
  function onSelectText(text: string, e?: React.MouseEvent) {
    setQuickSel(text);
    // 悬浮窗锚定到选区附近
    setQuickAnchor({ x: e?.clientX ?? 120, y: e?.clientY ?? 80 });
    setQuickPop(null);
  }
  async function runQuickAsk() {
    if (!quickSel) return;
    const text = quickSel;
    logger.info("chat", "quick-ask", { textLen: text.length });
    setQuickPop({ state: "loading", text: "" });
    try {
      const out = await quickAsk(text);
      setQuickPop({ state: "ok", text: out });
    } catch (e) {
      setQuickPop({ state: "error", text: String(e) });
    }
  }

  // slash 选中回填：命令名回填输入框，光标留在命令后（不自动发送）
function pickSlash(w: CommandWord) {
    setInput(completeCommand(w));
    setSlashIdx(-1);
    slashRef.current?.focus();
  }

  const runRef = useRef<{ promise: Promise<void> } | null>(null);

  async function runPrompt(text: string) {
    // F-8-1：刷新最近交互时间戳（回收判定的数据源）
    lastActivityRef.current = Date.now();
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
        logger.error("chat", "prompt 失败", { tabKey, adapter: adapter.id, error: String(err) });
        toast.error(`出错了：${String(err)}`);
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
    <div className="panel" data-dragging={dragging ? "true" : "false"}>
      <div className="chat" ref={chatScrollRef}>
        {starting && <div className="hint">正在启动 {adapter.name}…</div>}
        {empty && !historyDegraded && <Welcome adapter={adapter} onSuggest={sendSuggestion} />}
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
                <MessageLine
                  msg={m}
                  adapter={adapter}
                  busy={busy}
                  isLast={vi.index === messages.length - 1}
                  onSelect={onSelectText}
                />
              </div>
            );
          })}
        </div>
        {/* F-8-7 快问悬浮窗 */}
        {quickSel && (
          <div
            className="quick-pop"
            style={{
              position: "absolute",
              top: quickAnchor.y,
              left: quickAnchor.x,
              zIndex: 40,
            }}
          >
            {!quickPop ? (
              <>
                <div className="quick-pop-title">对选中文本：</div>
                <div className="quick-pop-sel" title={quickSel}>{quickSel}</div>
                <div className="quick-pop-actions">
                  {/* 统一入口（ideas IDEA-001）：批注＝加入批注卡；快速解释＝独立轻量模型 */}
                  <button
                    type="button"
                    onClick={() => {
                      addQuote(quickSel);
                      setQuickSel(null);
                    }}
                  >
                    批注
                  </button>
                  <button
                    type="button"
                    disabled={!quickAskReady}
                    title={quickAskReady ? "" : "未配置快问模型"}
                    onClick={runQuickAsk}
                  >
                    快速解释
                  </button>
                  <button type="button" onClick={() => setQuickSel(null)}>关闭</button>
                </div>
              </>
            ) : quickPop.state === "loading" ? (
              <div className="quick-pop-body">解释中…</div>
            ) : quickPop.state === "error" ? (
              <div className="quick-pop-body quick-pop-error">解释失败：{quickPop.text}</div>
            ) : (
              <>
                <div className="quick-pop-body">{quickPop.text}</div>
                <div className="quick-pop-actions">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(quickPop.text).then(
                        () => toast.success("已复制"),
                        () => toast.error("复制失败"),
                      );
                    }}
                  >
                    复制
                  </button>
                  <button type="button" onClick={() => setQuickSel(null)}>关闭</button>
                </div>
              </>
            )}
          </div>
        )}
        {pending && (
          <Dialog open onOpenChange={() => {}}>
            <DialogContent className="max-w-md" showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>需要批准执行</DialogTitle>
              </DialogHeader>
              <p className="perm-code">
                <code>{pending}</code>
              </p>
              <DialogFooter>
                <Button variant="outline" onClick={() => onPerm("reject")}>拒绝</Button>
                <Button onClick={() => onPerm("allow")}>允许</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="harness-badge inline-flex items-center gap-2">
        <AgentAvatar adapterId={adapter.id} name={adapter.name} brandColor={adapter.logo} size={16} className="shrink-0" />
        <span>正在和 {adapter.name} 对话</span>
      </div>

      {/* F-8-2 批注卡列表：多段批注 + 统一发送 */}
      {quotes.length > 0 && (
        <div className="quote-panel">
          {quotes.map((q, i) => (
            <div key={i} className="quote-card">
              <span className="quote-index">引用 {i + 1}</span>
              <div className="quote-text" title={q.text}>{q.text}</div>
              <input
                aria-label={`批注疑问 ${i + 1}`}
                className="quote-input"
                placeholder="填写疑问或评论…"
                value={q.question}
                onChange={(e) => setQuoteQuestion(i, e.target.value)}
              />
              <button type="button" className="quote-remove" aria-label={`移除引用 ${i + 1}`} onClick={() => removeQuote(i)}>
                <CloseIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
              </button>
            </div>
          ))}
          <div className="quote-actions">
            <span className="quote-hint">已选 {quotes.length} 处</span>
            <button type="button" className="quote-send" onClick={sendQuotes}>发送批注</button>
          </div>
        </div>
      )}

      {/* F-8-3 附件胶囊列表：文件名 + × 移除（拖拽高亮反馈） */}
      {files.length > 0 && (
        <div className="attach-list">
          {files.map((f, i) => (
            <span key={f.path} className="attach-chip">
              <span className="attach-name" title={f.path}>
                {f.path.split("/").filter(Boolean).pop() ?? f.path}
              </span>
              <button
                type="button"
                className="attach-remove"
                aria-label={`移除附件 ${i + 1}`}
                onClick={() => removeFile(i)}
              >
                <CloseIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
              </button>
            </span>
          ))}
        </div>
      )}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button
          type="button"
          className="attach-btn"
          aria-label="添加文件"
          title="添加文件"
          onClick={pickFiles}
        >
          ＋
        </button>
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
            aria-label="消息输入"
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
            placeholder={busy ? "运行中，输入将打断当前 turn…" : typeText}
            disabled={starting}
            rows={1}
          />
        </div>
        <button
          type="submit"
          disabled={starting}
          aria-label="发送"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: "var(--primary)", color: "var(--primary-foreground)", transitionDuration: "var(--motion-default)" }}
        >
          <SendIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
        </button>
        <button
          type="button"
          onClick={stop}
          disabled={!busy}
          aria-label="停止"
          className={`stop-btn inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            busy ? "run-pulse" : ""
          }`}
          style={{
            backgroundColor: "var(--bg-2)",
            color: busy ? "var(--danger)" : "var(--text-secondary)",
            transitionDuration: "var(--motion-default)",
          }}
        >
          <StopIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
        </button>
      </form>
    </div>
  );
}

function Welcome({ adapter, onSuggest }: { adapter: AdapterWithStatus; onSuggest: (t: string) => void }) {
  const greeting = welcomeGreeting(new Date().getHours());
  const suggestions = suggestionsFor(adapter);
  return (
    <div className="welcome">
      <h2>{greeting}！我可以帮你做什么？</h2>
      <div className="suggestions">
        {suggestions.map((s) => (
          <button key={s} className="suggestion group inline-flex items-center gap-1" onClick={() => onSuggest(s)}>
            <span>{s}</span>
            {/* F-7-6 AC-P7-6-3：hover 箭头从左滑入 */}
            <ArrowRightIcon
              className="opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0"
              style={{ width: 14, height: 14, strokeWidth: 1.75, transitionDuration: "var(--motion-fast)" }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

// —— 消息行渲染：user 右气泡 / assistant 左（全宽）+ 头像 + hover 复制（F-7-4）——
function MessageLine({
  msg,
  adapter,
  busy,
  isLast,
  onSelect,
}: {
  msg: ChatMsg;
  adapter: AdapterWithStatus;
  busy: boolean;
  isLast: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end my-1.5">
        <div className="user-bubble max-w-[75%] px-3.5 py-2.5" style={{ backgroundColor: "var(--message-user-bg)", color: "#fff", borderRadius: "var(--radius-lg)", borderBottomRightRadius: "4px" }}>
          <span className="whitespace-pre-wrap break-words">{msg.text}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="group flex gap-2.5 my-2.5">
      <AgentAvatar adapterId={adapter.id} name={adapter.name} brandColor={adapter.logo} size={32} className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        {msg.blocks.map((b, i) => (
          <BlockView
            key={i}
            block={b}
            live={busy && isLast && i === msg.blocks.length - 1 && b.kind === "thought" && b.ms === undefined}
            onSelect={onSelect}
          />
        ))}
        {/* hover 浮现复制按钮（F-7-4 AC-P7-4-2） */}
        <button
          type="button"
          aria-label="复制回复"
          className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
          onClick={() => {
            const text = msg.blocks
              .map((b) => (b.kind === "text" ? b.text : b.kind === "thought" ? b.text : ""))
              .filter(Boolean)
              .join("\n");
            navigator.clipboard?.writeText(text).then(
              () => toast.success("已复制"),
              () => toast.error("复制失败"),
            );
          }}
        >
          <CopyIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
          复制
        </button>
      </div>
    </div>
  );
}

function BlockView({
  block,
  live,
  onSelect,
}: {
  block: BlockMsg;
  live: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
}) {
  switch (block.kind) {
    case "text":
      return (
        <div
          className="md"
          onMouseUp={(e) => {
            // F-8-2（用法1）+ F-8-7（快问）：选中 assistant 正文文字 → 记录选区
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) return;
            const text = sel.toString().trim();
            if (text) onSelect?.(text, e);
          }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
            }}
          >
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

/** 代码块包装：hover 右上角浮现复制按钮（F-7-10 AC-P7-10-2） */
function CodeBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div className="code-block-wrap" ref={ref}>
      <pre>{children}</pre>
      <button
        type="button"
        aria-label="复制代码"
        className="code-copy"
        onClick={() => {
          const code = ref.current?.querySelector("code")?.textContent ?? "";
          navigator.clipboard?.writeText(code).then(
            () => toast.success("代码已复制"),
            () => toast.error("复制失败"),
          );
        }}
      >
        <CopyIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
        复制
      </button>
    </div>
  );
}

function ThoughtView({ text, ms, live }: { text: string; ms?: number; live: boolean }) {
  const [open, setOpen] = useState(live);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    // 流式结束（live true→false）自动折叠
    if (!live) setOpen(false);
  }, [live]);
  // 实时计时（AC-P7-5-1）：思考中每秒跳动；reduced-motion 不影响计时（只关动画）
  useEffect(() => {
    if (!live) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const isThinking = ms === undefined && live;
  const summary = ms !== undefined ? `已思考 ${(ms / 1000).toFixed(0)} 秒` : `思考中… ${elapsed}s`;
  return (
    <div
      className="my-1.5"
      data-live={live ? "true" : "false"}
      style={{ fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.7 }}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 hover:bg-[var(--bg-hover)]"
        style={{ color: isThinking ? "var(--warning)" : "var(--text-secondary)" }}
        onClick={() => setOpen((v) => !v)}
      >
        {/* chevron 0.2s 旋转（AC-P7-5-3） */}
        <span
          className="inline-flex transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)", transitionTimingFunction: "var(--ease-out-soft)" }}
        >
          <ChevronRightIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
        </span>
        <ThinkingIcon
          className={isThinking ? "animate-pulse" : ""}
          style={{ width: 13, height: 13, strokeWidth: 1.75 }}
        />
        <span>{summary}</span>
        {/* 思考中 pulse 省略号（AC-P7-5-1） */}
        {isThinking && (
          <span className="animate-pulse" aria-hidden="true">
            …
          </span>
        )}
      </button>
      {open && (
        <div
          style={{
            backgroundColor: "var(--thought-bg)",
            borderRadius: "var(--radius-sm)",
            padding: "8px 12px",
            marginLeft: "20px",
            marginTop: "2px",
            whiteSpace: "pre-wrap",
          }}
        >
          {text}
        </div>
      )}
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
        <span className="caret inline-flex transition-transform" style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)" }}>
          <ChevronRightIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
        </span>
        <ToolIcon
          style={{
            width: 14,
            height: 14,
            strokeWidth: 1.75,
            flexShrink: 0,
            display: "inline-block",
            verticalAlign: "middle",
          }}
        />
        <span>{title}</span>
        <span className="status">{status}</span>
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
      return (
        <div className="tool-terminal inline-flex items-center gap-1">
          <TerminalIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
          终端 {content.terminal.terminalId}
        </div>
      );
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
