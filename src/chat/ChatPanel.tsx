// 单会话聊天面板：独立的 AcpSession 进程 + 全局 store 里的运行时。
// 由 App 作为多 Tab 编排的单元（tabKey 唯一）。消息状态不在本组件内，
// 而在 zustand store（F-4-8），切换 Tab 不丢失消息；另有 JSONL 日志兜底持久化（F-4-3）。
//
// P13 C3 拆分：消息渲染树在 chat/message/（MessageLine/BlockView/MarkdownView/…），
// 欢迎页在 chat/Welcome.tsx，打字机 hook 在 chat/hooks/useTypewriter.ts。
// 本文件只保留会话生命周期编排 + 状态接线 + 输入区（composer 内联待后续拆出）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openSession, type AcpSession } from "@/acp/session";
import { type AskAnswer, type AskQuestion } from "../chat/logic/askCard";
import { PlanBar } from "@/chat/components/PlanBar";
import { CommandQueuePanel } from "@/chat/components/CommandQueuePanel";
import { SearchBar } from "@/chat/components/SearchBar";
import { QuotePanel, AttachList, DiffCommentsBar, EditBanner } from "@/chat/components/PanelStrips";
import { Composer } from "@/chat/composer/Composer";
import { QuickAskPopup } from "@/chat/composer/QuickAskPopup";
import { UsageBar } from "@/chat/components/UsageBar";
import { Welcome } from "@/chat/Welcome";
import { MessageLine } from "@/chat/message/MessageLine";
import { useTypewriter } from "@/chat/hooks/useTypewriter";
import { useChatSearch } from "@/chat/hooks/useChatSearch";
import { useQueueStore } from "@/store/queueStore";
import { logRead, logAppend, logTruncate, logCopy } from "@/ipc/sessions";
import { parseLog, serializeMessages } from "@/acp/message-log";
import { newTurn, applyEvent, type TurnAccumulator } from "@/acp/turn";
import { completeCommand } from "../chat/logic/slash";
import {
  flattenWorkspaceFiles,
  filterAtFiles,
  applyAtToken,
} from "../chat/logic/atFile";
import { workspaceListDir } from "@/ipc/fslist";
import { filterExcluded } from "@/lib/fileTree";
import { composeQuotedPrompt, type Quote } from "../chat/logic/quote";
import { composeFileReference, filterAbsoluteFiles, type FileRef } from "../chat/logic/fileRef";
import { truncateToMessageIndex } from "@/acp/rewind";
import { lastUserIndex, shouldShowLastPromptBubble, ellipsize } from "../chat/logic/lastPrompt";
import { truncateMessagesToEdit } from "../chat/logic/edit-resend";
import { composeDiffComments, type DiffComment } from "../chat/logic/diffComments";
import { typewriterHint } from "../chat/logic/welcome";
import { shouldRecycleSession, RECYCLE_THRESHOLD_MS } from "../sidebar/logic/recycle";
import { logger } from "@/lib/logger";
import { quickAsk, quickAskConfigGet } from "@/ipc/quickask";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  useSessionStore,
  type CommandWord,
} from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AskCard } from "@/chat/components/AskCard";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import "@/chat/chat.css";
import "@/chat/message/messages.css";
import "@/chat/composer/composer.css";

interface Props {
  tabKey: string;
  adapter: AdapterWithStatus;
  resumeSessionId?: string;
  /** 会话运行目录（工作区 cwd）；缺省用 adapter.cwd */
  cwd?: string;
  /** M5：当前 Tab 是否活跃（flexlayout 非激活窗格保持挂载，ref-file/拖拽等
   *  window 级事件必须只作用于活跃实例，否则多窗格互相串扰） */
  active?: boolean;
  onFirstPrompt?: (text: string, sessionId: string) => void;
  /** F-8-5 分叉：返回 (父 sessionId, 新 sessionId) 供 App 落索引 */
  onFork?: (fromSessionId: string, toSessionId: string) => void;
  /** F-11-5 分叉自动跳转：fork 成功后 App 以新 sessionId 开 Tab 并激活 */
  onForkNavigate?: (newSessionId: string) => void;
  /** F-8-6 回溯：启用用户消息「回溯到这里」入口 */
  onRewind?: (index: number) => void;
}

export function ChatPanel({ tabKey, adapter, resumeSessionId, cwd, onFirstPrompt, onFork, onForkNavigate, onRewind, active = true}: Props) {
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
  const slashRef = useRef<HTMLTextAreaElement | null>(null);

  // F-11-3 @ 文件联想：null = 未展开；展开时为 token 信息
  const [atMenu, setAtMenu] = useState<{ query: string; start: number; end: number } | null>(null);
  // @ 数据源：cwd 目录懒加载缓存（与 FileTree 共用 workspaceListDir，形状：路径→子项）
  const [atTree, setAtTree] = useState<Record<string, Array<{ name: string; is_dir: boolean }>>>({});
  const atMenuRef = useRef<HTMLDivElement | null>(null);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);

  const workspaceCwd = cwd && cwd.length > 0 ? cwd : adapter.cwd;

  // F-7-6 打字机 placeholder：80ms/字循环打出建议语；reduced-motion 直接显全文
  const typeText = useTypewriter(typewriterHint(adapter));

  // @ 候选（F-11-3）：菜单展开才计算（扁平化 + fuzzy 过滤）
  const atMatches = useMemo(() => {
    if (!atMenu) return [];
    const files = flattenWorkspaceFiles(workspaceCwd, atTree);
    return filterAtFiles(files, atMenu.query);
  }, [atMenu, atTree, workspaceCwd]);
  // @ 菜单展开时确保根目录已加载（懒加载一层；目录选中仅插入路径不展开）
  useEffect(() => {
    if (!atMenu || !workspaceCwd || atTree[workspaceCwd]) return;
    let alive = true;
    workspaceListDir(workspaceCwd)
      .then((entries) => {
        if (alive && Array.isArray(entries)) {
          setAtTree((t) => ({ ...t, [workspaceCwd]: filterExcluded(entries) }));
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [atMenu, workspaceCwd, atTree]);

  const sessionRef = useRef<AcpSession | null>(null);
  const permResolver = useRef<((d: "allow" | "reject") => void) | null>(null);
  // 恢复会话时已写过索引，续聊不应重写标题 → 标记为“已 prompt”
  const promptedOnce = useRef(Boolean(resumeSessionId));
  // steering：运行中打断时，待发消息暂存于此，当前 turn 结束后自动续跑
  const pendingTextRef = useRef<string | null>(null);
  // M1：当前 turn 的 stopReason（turn_stop 时写入；finally 中消费后清空）
  const stopReasonRef = useRef<string | null>(null);
  // 当前 turn 的 blocks 累加器（流式事件 → 块结构，见 acp/turn.ts）
  const turnRef = useRef(newTurn());
  // 已落盘的消息条数（JSONL 日志增量追加的游标）
  const persistedRef = useRef(0);
  // F-8-1 空闲回收：最近一次交互时间戳（prompt 发起时刷新）+ 定时器句柄
  const lastActivityRef = useRef(0);
  // L7：回收发生后置 true，ensureSession 重建成功时消费（reopen 埋点的判据）
  const recycledRef = useRef(false);
  const recycleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // F-8-7 快问：是否已配置快问模型（未配置则入口禁用）
  const [quickAskReady, setQuickAskReady] = useState(false);
  // F-8-7 快问：选中的待解释文本 + 悬浮窗口坐标
  const [quickSel, setQuickSel] = useState<string | null>(null);
  const [quickAnchor, setQuickAnchor] = useState({ x: 120, y: 80 });
  // F-8-7 悬浮窗：null=关闭；加载中/结果/错误三态
  const [quickPop, setQuickPop] = useState<{ state: "loading" | "ok" | "error"; text: string } | null>(null);
  // F-11-6 快问悬浮窗点外关闭：DOM ref
  const quickPopRef = useRef<HTMLDivElement | null>(null);
  const quickSelRef = useRef<string | null>(null);
  quickSelRef.current = quickSel;
  // F-8-3 文件引用：待发送附件集（按钮选择 / 拖拽 同路径）
  const [files, setFiles] = useState<FileRef[]>([]);
  // F-8-3 拖拽悬停高亮
  const [dragging, setDragging] = useState(false);
  // F-8-6 回溯：待确认的目标消息下标（null = 无）
  const [rewindTarget, setRewindTarget] = useState<number | null>(null);
  // M5：active prop 镜像——window 级监听闭包来自挂载帧，读 ref 取最新活跃态
  const activeRef = useRef(active);
  activeRef.current = active ?? true;
  // F-12-1 编辑重试：null = 非编辑态；否则为 {index, original}（index 处消息被替换）
  const [editTarget, setEditTarget] = useState<{ index: number; original: string } | null>(null);
  // F-12-5 diff 行内评论：待发评论集（随 tabKey 独立，按组件实例隔离）
  const [diffComments, setDiffComments] = useState<DiffComment[]>([]);
  // F-12-5 评论条带展开态
  const [diffCommentsOpen, setDiffCommentsOpen] = useState(false);
  // F-12-2 提问卡：待回答状态 + resolver
  const askResolver = useRef<((a: Record<string, AskAnswer> | null) => void) | null>(null);
  // F-12-1 Esc 判定用的最新值镜像（state 声明后同步）
  const editTargetRef = useRef<{ index: number; original: string } | null>(null);
  editTargetRef.current = editTarget;

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
            // M5：Tauri 拖拽事件是 webview 级广播，多窗格都挂着监听——
            // 非活跃实例忽略，文件只落进用户正看着的那个面板
            if (!(activeRef.current ?? true)) return;
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
    }
    // F-9-2 搜索 + F-11-6 快问悬浮窗 Esc 关闭（会话内搜索已改绑 Ctrl+Shift+F，DEC-26）
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") {
        if (editTargetRef.current) {
          cancelEdit();
        } else if (quickSelRef.current !== null) {
          setQuickSel(null);
          logger.debug("chat", "quick-pop-dismiss", { reason: "escape" });
        } else if (searchOpenRef.current) {
          closeSearchRef.current();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    // F-11-7 RightRail 文件树「引用」→ 注入附件（CustomEvent，与 Rail 解耦）
    const onRefFile = (e: Event) => {
      // M5：只接受发给自己所在 Tab 的事件（非活跃窗格忽略，防多窗格串扰）
      if (!(activeRef.current ?? true)) return;
      const path = (e as CustomEvent<string>).detail;
      if (typeof path !== "string") return;
      logger.info("fs", "ref-file", { path });
      setFiles((prev) => {
        const seen = new Set(prev.map((f) => f.path));
        if (seen.has(path)) return prev;
        return [...prev, { path }];
      });
    };
    window.addEventListener("ainone:ref-file", onRefFile);
    // F-11-6 快问悬浮窗点外关闭：document mousedown + outside 判定（Esc 走 onKeyDown）
    const onDocMouseDown = (e: MouseEvent) => {
      if (quickSelRef.current === null) return;
      const pop = quickPopRef.current;
      if (pop && e.target instanceof Node && pop.contains(e.target)) return;
      setQuickSel(null);
      setQuickPop(null);
      logger.debug("chat", "quick-pop-dismiss", { reason: "outside" });
    };
    document.addEventListener("mousedown", onDocMouseDown);
    // F-8-1 空闲超时回收：周期检查，空闲超阈值且无运行中 turn → 回收子进程
    recycleTimerRef.current = setInterval(() => {
      const s = sessionRef.current;
      if (!s) return;
      // 读 store 快照的 busy（闭包里的 busy 是挂载时的旧值）
      const isBusy = useSessionStore.getState().runtime[tabKey]?.busy ?? false;
      if (shouldRecycleSession(lastActivityRef.current, Date.now(), RECYCLE_THRESHOLD_MS, isBusy)) {
        sessionRef.current = null;
        // L7：时点修正——这里是「执行回收」，reopen 发生在下一次 ensureSession；
        // 原埋点把 recycle 记成 reopen，日志时间轴误导。
        logger.info("session", "recycle", { sessionId: s.sessionId });
        recycledRef.current = true;
        void s.recycle(lastActivityRef.current).catch(() => {});
      }
    }, 15_000);
    return () => {
      if (recycleTimerRef.current) clearInterval(recycleTimerRef.current);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("ainone:ref-file", onRefFile);
      document.removeEventListener("mousedown", onDocMouseDown);
      unlisten?.();
      sessionRef.current?.dispose().catch(() => {});
      drop(tabKey);
      // H4：tabKey 是内存递增（tab-N），重启后会被新 Tab 复用——关闭 Tab 必须清队列，
      // 否则残留队列挂到无关新会话上首次 turn 结束自动发出
      useQueueStore.getState().clear(tabKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureSession() {
    if (sessionRef.current) return sessionRef.current;
    // L7：hadSession = 回收/回溯后重建链路 → 这才是 reopen 时点
    const hadSession = recycledRef.current;
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
        // F-12-2 结构化提问：把 Elicitation 请求转成 store 状态 → AskCard 渲染
        async (params) => {
          // URL 模式 / 自定义模式本客户端不支持 → decline（不悬挂 agent）
          if (params.mode !== "form") {
            logger.info("chat", "ask-unsupported-mode", { mode: String(params.mode) });
            return { action: "decline" };
          }
          const schema = (params.requestedSchema ?? {}) as {
            properties?: Record<string, Record<string, unknown>>;
          };
          const props = schema.properties ?? {};
          const questions: AskQuestion[] = Object.entries(props).map(([key, raw]) => {
            const p = raw as {
              title?: string | null;
              type?: string;
              enum?: string[] | null;
              oneOf?: Array<{ const: string; title?: string }> | null;
              items?: { enum?: string[] } | null;
            };
            const title = p.title ?? key;
            if (p.type === "array") {
              return { question: title, options: p.items?.enum ?? [], multi: true };
            }
            if (p.type === "string") {
              const options = p.oneOf
                ? p.oneOf.map((o) => o.title ?? o.const)
                : (p.enum ?? []);
              return { question: title, options, multi: false };
            }
            // number/integer/boolean → 自由文本输入（单选 Other 兜底渲染）
            return { question: title, options: [], multi: false };
          });
          logger.info("chat", "ask-open", { questions: questions.length });
          patch(tabKey, { ask: { questions, mode: params.mode } });
          const answers = await new Promise<Record<string, AskAnswer> | null>((resolve) => {
            askResolver.current = resolve;
          });
          patch(tabKey, { ask: null });
          if (answers === null) {
            logger.info("chat", "ask-decline");
            return { action: "decline" };
          }
          logger.info("chat", "ask-answer", { picked: Object.keys(answers).length });
          return { action: "accept", content: answers };
        },
      );
      sessionRef.current = s;
      bindSession(tabKey, s.sessionId);
      if (hadSession) {
        recycledRef.current = false;
        logger.info("session", "reopen after recycle", { sessionId: s.sessionId });
      }
      // M9：resume 会话（promptedOnce 初值 true）永远不拉 providers → 侧栏
      // apiType/baseUrl 恒空。ensureSession 建链后补拉一次（幂等，失败静默）。
      if (resumeSessionId) {
        void s
          .listProviders()
          .then((providers) => {
            const cur = providers.find((p) => p.current?.baseUrl)?.current;
            if (cur) useSessionStore.getState().setMeta(tabKey, cur);
          })
          .catch(() => {});
      }
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
    // F-12-1 编辑重试：编辑态发送 = 截断到该条（替换文本）+ 走回溯的进程断开链路
    if (editTarget) {
      const target = editTarget;
      setEditTarget(null);
      const truncated = truncateMessagesToEdit(messages, target.index, full);
      if (!truncated) {
        toast.error("编辑失败：消息状态已变化，请重试");
        return;
      }
      logger.warn("chat", "edit-resend", {
        index: target.index,
        oldLen: target.original.length,
        newLen: full.length,
      });
      useSessionStore.getState().setMessages(tabKey, truncated);
      persistedRef.current = truncated.length;
      const sid = sessionRef.current?.sessionId ?? resumeSessionId;
      // H7：同 doRewind——await 截断完成，避免与新消息 append 竞态
      if (sid) {
        try {
          await logTruncate(sid, truncated.length);
        } catch (e) {
          logger.error("chat", "log-truncate 失败", { sid, keepLines: truncated.length, error: String(e) });
          toast.error("日志截断失败，恢复会话时可能看到旧历史");
        }
      }
      // 断开当前子进程，下次 prompt 重新 session/load 恢复（与回溯同链路，DEC-35）
      sessionRef.current?.dispose().catch(() => {});
      sessionRef.current = null;
      setInput("");
      setAtMenu(null);
      setFiles([]);
      if (busy) {
        pendingTextRef.current = full;
        return;
      }
      await runPrompt(full);
      return;
    }
    setInput("");
    setAtMenu(null);
    setFiles([]);
    if (files.length > 0) logger.info("chat", "send-with-files", { count: files.length });
    appendUser(tabKey, full);

    // steering：运行中发消息 → 取消当前 turn，把新消息排队，turn 结束后自动续跑
    // M2：先赋值再 stop——stop() 返回后 finally 可能立即消费 pendingTextRef，
    // 后赋值会丢消息并让队列错误前进
    if (busy) {
      pendingTextRef.current = full;
      await stop();
      return;
    }
    await runPrompt(full);
  }

  // F-9-3 命令队列：追加指令（运行中/空闲均可，容量满 toaster 提示不静默丢弃）
  function enqueueCommand(text: string): boolean {
    const ok = useQueueStore.getState().enqueue(tabKey, { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text });
    if (ok) {
      // L10：日志语义修正——id=新条目 id，len=入队后长度，total=容量上限
      const q = useQueueStore.getState().queues[tabKey] ?? [];
      const item = q[q.length - 1];
      logger.info("queue", "enqueue", { id: item?.id, len: q.length, total: 10 });
    } else {
      logger.warn("queue", "full", { cap: 10 });
      toast.warning("命令队列已满（10 条），请先消费或删除");
    }
    return ok;
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
    // 与 steering 兼容：运行中发送 → 打断当前 turn 后新发起（复用打断队列）。
    // M2：先赋值再 stop（同 submit——stop 后 finally 可能立即消费 ref）
    if (busy) {
      pendingTextRef.current = text;
      void stop();
      return;
    }
    void runPrompt(text);
  }

  // —— F-8-5 会话分叉：从当前状态 fork，新会话落索引（标注来源）——
  // F-11-5：fork 成功后复制父日志为新会话日志 + 回调 onForkNavigate 自动跳转新 Tab
  async function doFork() {
    if (busy) {
      toast.warning("当前 turn 运行中，等待结束后再分叉");
      return;
    }
    const fromSessionId = sessionRef.current?.sessionId ?? resumeSessionId;
    if (!fromSessionId) {
      toast.error("会话尚未建立（请先发送一条消息）");
      return;
    }
    try {
      const s = await ensureSession();
      const cwdAbs = cwd ?? adapter.cwd;
      const newId = await s.fork(cwdAbs);
      logger.info("session", "fork", { fromSessionId, toSessionId: newId });
      await logCopy(fromSessionId, newId).catch((e) => {
        // 日志复制失败不阻塞分叉（新 Tab 会走「历史缺失」降级，但上下文仍正确）
        logger.warn("session", "log-copy 失败", { fromSessionId, newId, error: String(e) });
      });
      onFork?.(fromSessionId, newId);
      onForkNavigate?.(newId);
      toast.success("已分叉出新会话，已跳转");
    } catch (e) {
      logger.error("session", "fork 失败", { fromSessionId, error: String(e) });
      toast.error(`分叉失败：${String(e)}`);
    }
  }

  // —— F-8-6 消息回溯：确认后截断消息列表 + 本地日志 ——
  function askRewind(index: number) {
    setRewindTarget(index);
  }
  async function doRewind() {
    if (rewindTarget === null) return;
    // H7：busy 保护——运行中回溯会 dispose 在跑的 turn，排队内容还会以全量上下文续跑
    if (busy) {
      toast.warning("当前 turn 运行中，请先停止或等待结束再回溯");
      return;
    }
    const target = rewindTarget;
    setRewindTarget(null);
    logger.warn("chat", "rewind", { toIndex: target, withFiles: false });
    // 情况一（M）：只回上下文 —— 截 store 消息 + 截本地日志
    const truncated = truncateToMessageIndex(messages, target);
    useSessionStore.getState().setMessages(tabKey, truncated);
    persistedRef.current = truncated.length;
    const sid = sessionRef.current?.sessionId ?? resumeSessionId;
    // H7：先 await 截断完成再继续（原 fire-and-forget 有「先 append 后 truncate」
    // 竞态——回溯后立即发消息时新消息可能被一并截掉）；失败明确提示不静默。
    if (sid) {
      try {
        await logTruncate(sid, truncated.length);
      } catch (e) {
        logger.error("chat", "log-truncate 失败", { sid, keepLines: truncated.length, error: String(e) });
        toast.error("日志截断失败，恢复会话时可能看到旧历史");
      }
    }
    // 断开当前子进程，下次 prompt 时重新 session/load 恢复（不丢已截断历史）
    sessionRef.current?.dispose().catch(() => {});
    sessionRef.current = null;
    toast.success(`已回溯到第 ${target + 1} 条消息之前`);
  }

  // —— F-8-7 快问：选中 → 快速解释 → 悬浮窗（不进入会话、不写日志）——
  // P11 F-R7：useCallback 稳定引用，避免 memo 化的 MessageLine 因回调新引用而失效
  const onSelectText = useCallback((text: string, e?: React.MouseEvent) => {
    setQuickSel(text);
    // H6：悬浮窗是 absolute 定位（祖先 = .layout-host），clientX/Y 是视口坐标，
    // 直接塞会恒定偏移侧栏+工具栏。换算为 .chat 内容区相对坐标。
    const chat = chatScrollRef.current;
    if (chat && e) {
      const rect = chat.getBoundingClientRect();
      setQuickAnchor({
        x: Math.max(8, e.clientX - rect.left),
        y: Math.max(8, e.clientY - rect.top),
      });
    } else {
      setQuickAnchor({ x: 120, y: 80 });
    }
    setQuickPop(null);
  }, []);
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
    slashRef.current?.focus();
  }

  // F-11-3 @ 选中：替换 @ token 为 @file: 路径，同步附件胶囊（复用 F-8-3 files）
  function pickAt(entry: { rel: string; abs: string; isDir: boolean }) {
    if (!atMenu) return;
    // M6：目录项 = 展开该目录（懒加载子项进 atTree + 把 query 推进到「@rel/」），
    // 菜单保持打开，深层文件因此可达；文件项 = 关闭菜单并落 token/胶囊。
    if (entry.isDir) {
      const relPrefix = `${entry.rel}/`;
      setAtMenu({ query: relPrefix, start: atMenu.start, end: atMenu.end });
      if (!atTree[entry.abs]) {
        workspaceListDir(entry.abs)
          .then((entries) => {
            if (Array.isArray(entries)) {
              setAtTree((t) => ({ ...t, [entry.abs]: filterExcluded(entries) }));
            }
          })
          .catch(() => {});
      }
      return;
    }
    const nextText = applyAtToken(input, atMenu, entry);
    setInput(nextText);
    setAtMenu(null);
    // M7：文件只走「文本 token」路径——submit 时 composeFileReference 会把
    // 附件胶囊再拼一遍 @file:，同一路径会出现两次引用。文本已含该路径 →
    // 不进胶囊。
    const tokenized = `@file:${entry.abs}`;
    if (!nextText.includes(tokenized)) {
      addFiles([{ path: entry.abs }]);
    }
    requestAnimationFrame(() => slashRef.current?.focus());
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
          // F-8-4：建会话后拉一次 provider 路由（apiType/baseUrl）填侧栏
          void session
            .listProviders()
            .then((providers) => {
              const cur = providers.find((p) => p.current?.baseUrl)?.current;
              useSessionStore.getState().setMeta(tabKey, cur ?? null);
            })
            .catch(() => {});
        }
        await session.prompt(text, (e) => {
          if (e.type === "available_commands") {
            setCommands(adapter.id, e.commands);
            return;
          }
          if (e.type === "turn_stop") {
            // M1：区分停止原因——用户取消（cancel）后不再自动消费队列下一条，
            // 只允许 steering 续跑（用户主动输入的意图必须被尊重）
            stopReasonRef.current = e.stopReason;
            return;
          }
          if (e.type === "usage") {
            // F-8-4：usage_update → 存 store（侧栏订阅）
            logger.debug("session", "usage", { used: e.used, size: e.size, cost: e.cost });
            useSessionStore.getState().setUsage(tabKey, { used: e.used, size: e.size, cost: e.cost });
            return;
          }
          if (e.type === "plan") {
            // F-9-1：plan 全量替换（DEC-16）
            logger.debug("session", "plan", {
              entries: e.entries.length,
              done: e.entries.filter((x) => x.status === "completed").length,
              total: e.entries.length,
            });
            useSessionStore.getState().setPlan(tabKey, e.entries);
            return;
          }
          const next = applyEvent(turnRef.current, e, Date.now);
          turnRef.current = next;
          useSessionStore.getState().updateLastAssistant(tabKey, () => next.blocks);
        });
        // turn 结束：摊平 blocks 到 store（applyEvent 已封口 thinking）；
        // 空 turn（无事件）不新起 assistant 气泡（编辑重试后的静默重开场景）
        if (turnRef.current.blocks.length > 0) {
          useSessionStore.getState().updateLastAssistant(tabKey, () => turnRef.current.blocks);
        }
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
        // F-9-1 计划栏：turn 结束清除 plan，不悬挂下一轮（AC-P9-3）
        useSessionStore.getState().setPlan(tabKey, null);
        // 落盘增量（turn 结束一次性追加，避免流式期间高频 IO）
        persistNew();
        // steering 排队续跑
        const queued = pendingTextRef.current;
        pendingTextRef.current = null;
        if (queued) {
          void runPrompt(queued);
        } else {
          // F-9-3 命令队列：turn 结束后自动按序消费下一条（AC-P9-9）。
          // M1：用户主动停止（stopReason=cancelled/user）→ 不续发，队列保留。
          const reason = stopReasonRef.current ?? "end_turn";
          stopReasonRef.current = null;
          const userCancelled = reason === "cancelled" || reason === "user";
          const head = userCancelled ? null : useQueueStore.getState().dequeue(tabKey);
          if (head) {
            logger.info("queue", "consume", { id: head.id });
            appendUser(tabKey, head.text);
            void runPrompt(head.text);
          } else if (userCancelled) {
            logger.info("queue", "hold-on-cancel", { reason });
          }
        }
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

  // —— F-12-1 编辑重试：进入编辑态（回填输入框 + 聚焦） ——
  function startEdit(index: number) {
    const msg = messages[index];
    if (!msg || msg.role !== "user") return;
    setEditTarget({ index, original: msg.text });
    setInput(msg.text);
    slashRef.current?.focus();
    logger.debug("chat", "edit-start", { index });
  }
  // Esc 退出编辑态（不改动消息列表）；判定走 ref（keydown 监听闭包来自首帧挂载）
  function cancelEdit() {
    const cur = editTargetRef.current;
    if (!cur) return;
    logger.debug("chat", "edit-cancel", { index: cur.index });
    setEditTarget(null);
    setInput("");
  }

  // —— F-12-5 diff 行内评论：收集 → 随消息发送 → 清空 ——
  function addDiffComment(c: DiffComment) {
    setDiffComments((prev) => [...prev, c]);
    logger.info("chat", "diff-comment-add", { path: c.path, line: c.line });
  }
  function removeDiffComment(idx: number) {
    setDiffComments((prev) => prev.filter((_, i) => i !== idx));
  }
  function sendDiffComments() {
    if (diffComments.length === 0) return;
    const text = composeDiffComments(diffComments);
    setDiffComments([]);
    setDiffCommentsOpen(false);
    logger.info("chat", "diff-comment-send", { count: diffComments.length });
    appendUser(tabKey, text);
    if (busy) {
      pendingTextRef.current = text;
      void stop();
      return;
    }
    void runPrompt(text);
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

  // F-9-2 会话内搜索（状态机见 chat/hooks/useChatSearch.ts）
  const {
    searchOpen, setSearchOpen, searchKeyword, setSearchKeyword, setSearchIdx,
    searchHits, searchCurIndex, searchIdx, nextHit, closeSearch, searchInputRef,
  } = useChatSearch(messages, virtualizer);

  // Esc 判定用的最新值镜像（keydown 闭包来自挂载帧；hook state 需逐帧同步）
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  const closeSearchRef = useRef<() => void>(() => {});
  closeSearchRef.current = closeSearch;

  // F-11-9 上一条指令回跳气泡
  const lastUserIdx = useMemo(() => lastUserIndex(messages), [messages]);
  const lastUserText = lastUserIdx >= 0 && messages[lastUserIdx].role === "user" ? messages[lastUserIdx].text : "";
  const [atBottom, setAtBottom] = useState(true);
  // 滚动监听（raf 节流）：距底 >64px 显示气泡
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        setAtBottom(dist <= 64);
        // H6：选中悬浮窗锚定的是内容坐标，滚动后锚点失效 → 直接关闭（残留修复）
        if (quickSelRef.current !== null) {
          setQuickSel(null);
          setQuickPop(null);
        }
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);
  // L2：回跳目标消息短暂高亮（与搜索命中高亮同型，1.2s 后退场）
  const [lastPromptFlash, setLastPromptFlash] = useState(-1);
  function jumpToLastPrompt() {
    if (lastUserIdx < 0) return;
    logger.debug("chat", "last-prompt-jump", { index: lastUserIdx });
    virtualizer.scrollToIndex(lastUserIdx, { align: "start" });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(lastUserIdx, { align: "start" });
        setLastPromptFlash(lastUserIdx);
        window.setTimeout(() => setLastPromptFlash(-1), 1200);
      }),
    );
  }

  const empty = messages.length === 0;

  return (
    <div className="panel" data-dragging={dragging ? "true" : "false"}>
      <SearchBar
        keyword={searchKeyword}
        onKeywordChange={(v) => {
          setSearchKeyword(v);
          setSearchIdx(0);
        }}
        countText={
          searchKeyword.trim()
            ? searchHits.length > 0
              ? `${searchIdx % searchHits.length + 1} / ${searchHits.length}`
              : "无结果"
            : ""
        }
        inputRef={searchInputRef}
        onHit={nextHit}
        onClose={closeSearch}
      />
      <div className="chat" ref={chatScrollRef}>
        {/* F-11-9 上一条指令回跳气泡（L2：sticky 于消息区顶部，显隐不再推拉内容；
            传真实阈值 64px，不再用 0/9999 伪造参数绕过纯函数语义） */}
        {shouldShowLastPromptBubble(lastUserIdx >= 0, atBottom ? 0 : 64) && (
          <button
            type="button"
            className="last-prompt-bubble last-prompt-sticky"
            title={lastUserText}
            data-testid="last-prompt-bubble"
            onClick={jumpToLastPrompt}
          >
            <span className="last-prompt-label">你最后说的：</span>
            <span className="last-prompt-text">{ellipsize(lastUserText)}</span>
            ↑
          </button>
        )}
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
                data-search-hit={vi.index === searchCurIndex ? "true" : "false"}
                data-flash={vi.index === lastPromptFlash ? "true" : "false"}
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
                  onFork={onFork ? doFork : undefined}
                  onRewind={onRewind ? () => askRewind(vi.index) : undefined}
                  onEdit={m.role === "user" ? () => startEdit(vi.index) : undefined}
                  diffComments={diffComments}
                  onAddDiffComment={addDiffComment}
                />
              </div>
            );
          })}
        </div>
        {/* F-8-7 快问悬浮窗（F-11-6：点外/Esc 关闭，无「关闭」按钮） */}
        {quickSel && (
          <QuickAskPopup
            state={{ quickSel, quickPop, anchor: quickAnchor, ready: quickAskReady }}
            popRef={quickPopRef}
            onAnnotate={() => {
              addQuote(quickSel);
              setQuickSel(null);
            }}
            onQuickAsk={runQuickAsk}
            onClose={() => setQuickSel(null)}
          />
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
        {/* F-8-6 回溯确认（破坏性操作，二次确认） */}
        <Dialog open={rewindTarget !== null} onOpenChange={() => setRewindTarget(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>回溯到这里？</DialogTitle>
            </DialogHeader>
            <p className="perm-code">
              将截断到第 {rewindTarget} 条消息之前，之后的消息与上下文都会被丢弃。此操作不可撤销。
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRewindTarget(null)}>取消</Button>
              <Button variant="destructive" onClick={doRewind}>确认回溯</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="harness-badge inline-flex items-center gap-2">
        <AgentAvatar adapterId={adapter.id} name={adapter.name} brandColor={adapter.logo} size={16} className="shrink-0" />
        <span>正在和 {adapter.name} 对话</span>
        {/* F-12-6a 上下文用量进度条（无 usage 数据不渲染） */}
        <UsageBar usage={rt?.usage ?? null} />
      </div>

      {/* F-9-1 计划栏（输入框上方最上层，DEC-19） */}
      <PlanBar tabKey={tabKey} />

      <QuotePanel quotes={quotes} onSetQuestion={setQuoteQuestion} onRemove={removeQuote} onSend={sendQuotes} />

      <AttachList files={files} onRemove={removeFile} />

      {/* F-9-3 命令队列面板（计划栏之下，DEC-19） */}
      <CommandQueuePanel tabKey={tabKey} />

      {/* F-11-7：文件树移入 RightRail；通过 CustomEvent 接收其「引用」动作注入附件 */}
      {/*（监听挂载在下方 useEffect） */}

      <DiffCommentsBar count={diffComments.length} comments={diffComments} open={diffCommentsOpen} onToggle={() => setDiffCommentsOpen((v) => !v)} onRemove={removeDiffComment} onSend={sendDiffComments} />

      {/* F-12-2 结构化提问卡：agent 请求输入时插入消息区与输入框之间 */}
      {rt?.ask && (
        <AskCard
          questions={rt.ask.questions}
          onAnswer={(answers) => askResolver.current?.(answers)}
          onDecline={() => askResolver.current?.(null)}
        />
      )}

      <EditBanner target={editTarget} onCancel={cancelEdit} />

      <Composer
        input={input}
        setInput={setInput}
        textareaRef={slashRef}
        busy={busy}
        starting={starting}
        typeText={typeText}
        commands={commands}
        atMenu={atMenu}
        setAtMenu={setAtMenu}
        atMatches={atMatches}
        slashMenuRef={slashMenuRef}
        atMenuRef={atMenuRef}
        onSubmit={submit}
        onStop={stop}
        onPickFiles={pickFiles}
        onEnqueue={(t) => {
          enqueueCommand(t);
          setInput("");
        }}
        onVoice={(text) => setInput((prev) => (prev ? `${prev}\n${text}` : text))}
        onPickSlash={pickSlash}
        onPickAt={pickAt}
      />
    </div>
  );
}
