// 单会话聊天面板：独立的 AcpSession 进程 + 全局 store 里的运行时。
// 由 App 作为多 Tab 编排的单元（tabKey 唯一）。消息状态不在本组件内，
// 而在 zustand store（F-4-8），切换 Tab 不丢失消息；另有 JSONL 日志兜底持久化（F-4-3）。
//
// P4 渲染升级（F-4-1/F-4-2）：
//   - 用户消息右侧气泡；agent 消息左侧气泡 + 品牌色首字母头像
//   - 一轮 agent 回复内部 blocks 顺序渲染：text / thought / tool
//   - thinking 流式中浅色小字展开，结束后自动折叠为「已思考 N 秒」，可点击展开

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { PhotoProvider, PhotoView } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
// ansi-to-react 是 CJS 单导出（exports.default），ESM interop 后需再取一层 default
import AnsiPkg from "ansi-to-react";
const Ansi = (AnsiPkg as unknown as { default?: typeof AnsiPkg }).default ?? AnsiPkg;
import { useVirtualizer } from "@tanstack/react-virtual";
import { openSession, type AcpSession } from "../acp/session";
import { type AskAnswer, type AskQuestion } from "../acp/askCard";
import { PlanBar } from "./PlanBar";
import { CommandQueuePanel } from "./CommandQueuePanel";
import { VoiceInput } from "./VoiceInput";
import { UsageBar } from "./UsageBar";
import { useQueueStore } from "../store/queueStore";
import { logRead, logAppend, logTruncate, logCopy } from "../config/sessions";
import { parseLog, serializeMessages, type BlockMsg } from "../acp/message-log";
import { newTurn, applyEvent, type TurnAccumulator } from "../acp/turn";
import { isSlashInput, filterCommands, completeCommand } from "../acp/slash";
import {
  detectAtToken,
  flattenWorkspaceFiles,
  filterAtFiles,
  applyAtToken,
} from "../acp/atFile";
import { workspaceListDir } from "../config/fslist";
import { filterExcluded } from "../acp/fileTree";
import { composeQuotedPrompt, type Quote } from "../acp/quote";
import { composeFileReference, filterAbsoluteFiles, type FileRef } from "../acp/fileRef";
import { truncateToMessageIndex } from "../acp/rewind";
import { lastUserIndex, shouldShowLastPromptBubble, ellipsize } from "../acp/lastPrompt";
import { truncateMessagesToEdit } from "../acp/edit-resend";
import { composeDiffComments, type DiffComment } from "../acp/diffComments";
import { buildActivityGroups, type RenderItem } from "../acp/activity";
import { aggregateFileChanges } from "../acp/fileChanges";
import { searchMessages } from "../acp/search";
import { prettyJson } from "../acp/toolFormat";
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
import { AskCard } from "./AskCard";
import {
  CommentIcon,
  EditIcon,
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
  // slash 补全：高亮项下标；菜单展开时默认 0（F-11-1：直接 Enter 即选中首项）
  const [slashIdx, setSlashIdx] = useState(-1);
  const slashRef = useRef<HTMLTextAreaElement | null>(null);

  // F-11-3 @ 文件联想：null = 未展开；展开时为 token 信息
  const [atMenu, setAtMenu] = useState<{ query: string; start: number; end: number } | null>(null);
  const [atIdx, setAtIdx] = useState(0);
  // @ 数据源：cwd 目录懒加载缓存（与 FileTree 共用 workspaceListDir，形状：路径→子项）
  const [atTree, setAtTree] = useState<Record<string, Array<{ name: string; is_dir: boolean }>>>({});
  const atMenuRef = useRef<HTMLDivElement | null>(null);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);

  const workspaceCwd = cwd && cwd.length > 0 ? cwd : adapter.cwd;

  // F-7-6 打字机 placeholder：80ms/字循环打出建议语；reduced-motion 直接显全文
  const typeText = useTypewriter(typewriterHint(adapter));

  // slash 候选（F-4-7 / F-11-1 模糊匹配）：输入以 / 开头才计算
  // L1：Esc 显式关闭 slash 菜单（下次输入变化时重置重新可开）
  const [slashClosed, setSlashClosed] = useState(false);
  const slashOpen = isSlashInput(input) && !slashClosed;
  const slashMatches = useMemo(
    () => (slashOpen ? filterCommands(commands, input) : []),
    [commands, input, slashOpen],
  );
  // F-11-1：菜单展开时默认高亮第 0 项（直接 Enter 即选中）
  const slashHighlight = slashIdx >= 0 && slashIdx < slashMatches.length ? slashIdx : 0;

  // @ 候选（F-11-3）：菜单展开才计算（扁平化 + fuzzy 过滤）
  const atMatches = useMemo(() => {
    if (!atMenu) return [];
    const files = flattenWorkspaceFiles(workspaceCwd, atTree);
    return filterAtFiles(files, atMenu.query);
  }, [atMenu, atTree, workspaceCwd]);
  const atHighlight = atIdx >= 0 && atIdx < atMatches.length ? atIdx : 0;

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

  // F-11-1/F-11-3：键盘导航时滚动跟随（菜单容器内滚，不滚页面）
  useEffect(() => {
    if (!slashOpen) return;
    const el = slashMenuRef.current?.querySelector(".slash-item.active") as HTMLElement | null;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [slashHighlight, slashOpen]);
  useEffect(() => {
    if (!atMenu) return;
    const el = atMenuRef.current?.querySelector(".slash-item.active") as HTMLElement | null;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [atHighlight, atMenu]);

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
  // F-9-2 搜索：关键词 + 命中列表 + 当前命中下标
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  // F-11-6 Esc 判定用的最新值镜像（state 声明后同步）
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
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
          closeSearch();
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
        logger.info("session", "reopen after recycle", { sessionId: s.sessionId });
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
      setSlashIdx(-1);
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
    setSlashIdx(-1);
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
    setSlashIdx(-1);
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
      setAtIdx(0);
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
    setAtIdx(0);
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

  // F-9-2 搜索：命中列表（随关键词变化）
  const searchHits = searchOpen ? searchMessages(messages, searchKeyword) : [];
  const currentHit = searchHits.length > 0 ? searchHits[searchIdx % searchHits.length] : null;
  const searchCurIndex = currentHit ? currentHit.index : -1;

  // F-9-2 跳转：滚动到命中消息索引（虚拟列表按索引定位到序）。
  // M8：远端条目未测量前按 estimateSize 估计，scrollToIndex 落点会漂移——
  // 首跳后等两帧（测量已随渲染发生）再校跳一次，长消息场景落点基本准确。
  function jumpToSearch(index: number) {
    logger.info("chat", "search-jump", { index });
    virtualizer.scrollToIndex(index, { align: "start" });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(index, { align: "start" });
      }),
    );
  }
  function nextHit(delta: 1 | -1) {
    if (searchHits.length === 0) return;
    const next = (searchIdx + delta + searchHits.length) % searchHits.length;
    setSearchIdx(next);
    jumpToSearch(searchHits[next].index);
  }
  function closeSearch() {
    setSearchOpen(false);
    setSearchKeyword("");
    setSearchIdx(0);
  }
  // M8：搜索条出现时聚焦（原实现焦点留在原地，键盘流断裂）
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // 长会话虚拟列表（AC-P3-5 回归）：只渲染可见区消息
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => chatScrollRef.current,
    estimateSize: () => 120,
    overscan: 8,
  });

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
  function jumpToLastPrompt() {
    if (lastUserIdx < 0) return;
    logger.debug("chat", "last-prompt-jump", { index: lastUserIdx });
    virtualizer.scrollToIndex(lastUserIdx, { align: "start" });
  }

  const empty = messages.length === 0;

  return (
    <div className="panel" data-dragging={dragging ? "true" : "false"}>
      {/* F-11-9 上一条指令回跳气泡（悬浮于消息区顶部；贴底/无指令时隐藏） */}
      {shouldShowLastPromptBubble(lastUserIdx >= 0, atBottom ? 0 : 9999) && (
        <button
          type="button"
          className="last-prompt-bubble"
          title={lastUserText}
          data-testid="last-prompt-bubble"
          onClick={jumpToLastPrompt}
        >
          <span className="last-prompt-label">你最后说的：</span>
          <span className="last-prompt-text">{ellipsize(lastUserText)}</span>
          ↑
        </button>
      )}
      {/* F-9-2 会话内搜索条 */}
      {searchOpen && (
        <div className="search-bar">
          <input
            ref={searchInputRef}
            aria-label="搜索会话"
            className="search-input"
            placeholder="搜索会话内容…（Enter 下一条 / Shift+Enter 上一条）"
            value={searchKeyword}
            onChange={(e) => {
              setSearchKeyword(e.target.value);
              setSearchIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                nextHit(1);
              } else if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                nextHit(-1);
              }
            }}
          />
          <span className="search-count">
            {searchKeyword.trim()
              ? searchHits.length > 0
                ? `${searchIdx % searchHits.length + 1} / ${searchHits.length}`
                : "无结果"
              : ""}
          </span>
          <button type="button" className="search-close" aria-label="关闭搜索" onClick={closeSearch}>
            <CloseIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
          </button>
        </div>
      )}
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
                data-search-hit={vi.index === searchCurIndex ? "true" : "false"}
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
          <div
            className="quick-pop"
            ref={quickPopRef}
            data-testid="quick-pop"
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

      {/* F-9-3 命令队列面板（计划栏之下，DEC-19） */}
      <CommandQueuePanel tabKey={tabKey} />

      {/* F-11-7：文件树移入 RightRail；通过 CustomEvent 接收其「引用」动作注入附件 */}
      {/*（监听挂载在下方 useEffect） */}

      {/* F-12-5 diff 行内评论条带：待发评论徽标 + 展开/删除/单独发送 */}
      {diffComments.length > 0 && (
        <div className="diff-comments-bar">
          <button
            type="button"
            aria-expanded={diffCommentsOpen}
            className="diff-comments-toggle"
            style={{ transitionDuration: "var(--motion-fast)" }}
            onClick={() => setDiffCommentsOpen((v) => !v)}
          >
            {diffComments.length} 条 diff 评论
          </button>
          {diffCommentsOpen && (
            <div className="diff-comments-list">
              {diffComments.map((c, i) => (
                <div key={i} className="diff-comment-item" title={`${c.path}:${c.line} · ${c.lineText}`}>
                  <span className="diff-comment-loc">
                    {c.path.split("/").filter(Boolean).pop()}
                    {c.line > 0 ? `:${c.line}` : ""}
                  </span>
                  <span className="diff-comment-text">{c.comment}</span>
                  <button
                    type="button"
                    aria-label={`删除评论 ${i + 1}`}
                    onClick={() => removeDiffComment(i)}
                    className="diff-comment-remove"
                  >
                    <CloseIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className="diff-comments-send"
            style={{ transitionDuration: "var(--motion-fast)" }}
            onClick={sendDiffComments}
          >
            发送评论
          </button>
        </div>
      )}


      {/* F-12-2 结构化提问卡：agent 请求输入时插入消息区与输入框之间 */}
      {rt?.ask && (
        <AskCard
          questions={rt.ask.questions}
          onAnswer={(answers) => askResolver.current?.(answers)}
          onDecline={() => askResolver.current?.(null)}
        />
      )}

      {/* F-12-1 编辑态横幅：发送后从该条重新对话（独立条带，位于输入框上方） */}
      {editTarget && (
        <div className="edit-banner" data-testid="edit-banner">
          <span>正在编辑第 {editTarget.index + 1} 条消息，发送后将从此处重新对话</span>
          <button
            type="button"
            aria-label="取消编辑"
            onClick={cancelEdit}
            style={{ transitionDuration: "var(--motion-fast)" }}
          >
            取消（Esc）
          </button>
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
        <VoiceInput onTranscribed={(text) => setInput((prev) => (prev ? `${prev}\n${text}` : text))} />
        <div className="input-wrap">
          {slashOpen && slashMatches.length > 0 && (
            <div className="slash-menu" ref={slashMenuRef}>
              {slashMatches.map((w, i) => (
                <button
                  type="button"
                  key={w.name}
                  aria-selected={i === slashHighlight}
                  className={i === slashHighlight ? "slash-item active" : "slash-item"}
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
          {/* F-11-3 @ 文件联想菜单（复用 slash 菜单结构） */}
          {atMenu && atMatches.length > 0 && (
            <div className="slash-menu at-menu" ref={atMenuRef}>
              {atMatches.map((f, i) => (
                <button
                  type="button"
                  key={f.rel}
                  aria-selected={i === atHighlight}
                  className={i === atHighlight ? "slash-item active" : "slash-item"}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickAt(f);
                  }}
                >
                  <span className="slash-name">{f.isDir ? "📁" : "📄"} {f.rel}</span>
                  <span className="slash-desc">{f.isDir ? "目录" : "文件"}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={slashRef}
            aria-label="消息输入"
            value={input}
            onChange={(e) => {
              const v = e.currentTarget.value;
              const caret = e.currentTarget.selectionStart ?? v.length;
              setInput(v);
              setSlashIdx(-1); // 输入变化重置高亮
              setSlashClosed(false); // L1：输入变化重新允许 slash 菜单展开
              // F-11-3：@ 联想开合（词首 @ 才触发）。
              // M3：与 slash 互斥——行首 / 命令输入时不开 @ 菜单（两个菜单同帧
              // 展开会重叠渲染，键盘链互相吞噬）
              const token = isSlashInput(v) ? null : detectAtToken(v, caret);
              if (token) {
                setAtMenu((m) => (m ? { ...token } : token));
                setAtIdx(0);
              } else {
                setAtMenu(null);
              }
            }}
            onKeyDown={(e) => {
              // M4：IME 组合中（中文输入法选词）不触发菜单选中/发送——
              // 组合中的 Enter 是确认候选，不是提交意图
              if (e.nativeEvent.isComposing) return;
              // F-11-3 @ 菜单键盘导航（与 slash 互斥：同帧只开一个菜单）
              if (atMenu && atMatches.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setAtIdx((i) => (i + 1) % atMatches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setAtIdx((i) => (i <= 0 ? atMatches.length - 1 : i - 1));
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  pickAt(atMatches[atHighlight]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setAtMenu(null);
                  return;
                }
              }
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
                  pickSlash(slashMatches[slashHighlight]);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  // L1：Esc 语义与 @ 菜单对齐——关闭菜单（原只重置高亮，菜单仍开，
                  // Enter 会误选第 0 项）。重开靠再次输入 /。
                  setSlashClosed(true);
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
        {/* F-9-3 命令队列：排队追加按钮（区别于立即发送） */}
        <button
          type="button"
          disabled={!input.trim() || starting}
          aria-label="排队发送"
          title="加入命令队列"
          className="inline-flex h-9 px-2.5 shrink-0 items-center justify-center rounded-full text-xs"
          style={{ backgroundColor: "var(--bg-2)", color: "var(--text-secondary)", transitionDuration: "var(--motion-default)" }}
          onClick={() => {
            const t = input.trim();
            if (t) {
              enqueueCommand(t);
              setInput("");
            }
          }}
        >
          排队
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
// P11 F-R7（AC-R7-1）：React.memo 包裹——流式新 chunk 只更新末条消息，
// 历史消息 props 引用不变（store 保证非末条 block 引用稳定）→ 跳过重渲染，
// 也就跳过 Streamdown 对长文本的全量重解析。导出供测试。
export const MessageLine = memo(function MessageLine({
  msg,
  adapter,
  busy,
  isLast,
  onSelect,
  onFork,
  onRewind,
  onEdit,
  diffComments,
  onAddDiffComment,
}: {
  msg: ChatMsg;
  adapter: AdapterWithStatus;
  busy: boolean;
  isLast: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
  onFork?: () => void;
  onRewind?: () => void;
  /** F-12-1 编辑重试：仅 user 消息传入 */
  onEdit?: () => void;
  /** F-12-5 diff 行内评论：待发评论集（已评论行标记用）+ 收集回调 */
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="group flex justify-end my-1.5">
        <div className="user-bubble max-w-[75%] px-3.5 py-2.5" style={{ backgroundColor: "var(--message-user-bg)", color: "#fff", borderRadius: "var(--radius-lg)", borderBottomRightRadius: "4px" }}>
          <span className="whitespace-pre-wrap break-words">{msg.text}</span>
        </div>
        {/* hover 操作行：F-12-1 编辑 + F-8-6 回溯 */}
        <div className="ml-2 self-center flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {onEdit && (
            <button
              type="button"
              aria-label="编辑并重发"
              className="rounded-md px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
              style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
              onClick={onEdit}
            >
              <EditIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
              编辑
            </button>
          )}
          {onRewind && (
            <button
              type="button"
              aria-label="回溯到这里"
              className="rounded-md px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
              style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
              onClick={onRewind}
            >
              ↩ 回溯
            </button>
          )}
        </div>
      </div>
    );
  }
  // F-12-3 活动组：连续已完成 thought/tool 聚合为一张卡（DEC-36）
  // 流式末条 turn 的运行中块不入组（isSettled 判定 + live 判定在渲染项内处理）
  const renderItems = buildActivityGroups(msg.blocks);
  return (
    <div className="group flex gap-2.5 my-2.5">
      <AgentAvatar adapterId={adapter.id} name={adapter.name} brandColor={adapter.logo} size={32} className="shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        {renderItems.map((item, i) =>
          item.type === "block" ? (
            <BlockView
              key={i}
              block={item.block}
              live={busy && isLast && i === renderItems.length - 1 && (item.block.kind === "thought" ? item.block.ms === undefined : item.block.kind === "text")}
              onSelect={onSelect}
              diffComments={diffComments}
              onAddDiffComment={onAddDiffComment}
            />
          ) : (
            <ActivityGroupCard key={i} item={item} onSelect={onSelect} diffComments={diffComments} onAddDiffComment={onAddDiffComment} />
          ),
        )}
        {/* hover 浮现操作行（F-8-5 分叉 + F-7-4 复制） */}
        <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {onFork && (
            <button
              type="button"
              aria-label="从这里分叉"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
              style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
              onClick={onFork}
            >
              ⑂ 分叉
            </button>
          )}
          <button
            type="button"
            aria-label="复制回复"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
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
    </div>
  );
});

/** P11：assistant 正文 markdown 渲染（导出供测试与复用；批注选区监听在容器上） */
export function MarkdownView({
  text,
  live,
  onSelect,
}: {
  text: string;
  live: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="md"
      onMouseUp={(e) => {
        // F-8-2（用法1）+ F-8-7（快问）：选中 assistant 正文文字 → 记录选区
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const t = sel.toString().trim();
        if (t) onSelect?.(t, e);
      }}
    >
      {/* P11（DEC-21）：Streamdown 替代 ReactMarkdown——GFM/代码块(Shiki)/Mermaid/
          KaTeX/不完整块兜底/内部 memo 一体化；shikiTheme 双主题走 CSS 变量，
          深色由 data-theme 驱动（@custom-variant dark 对齐）。
          H1 修复：parseIncompleteMarkdown 仅在 mode="streaming" 下生效（库实现），
          live 块必须用 streaming 模式，静态消息保持 static（走 memo 快路径）。 */}
      {/* F-R5 图片 lightbox（DEC-24）：md 内 img 全部可点击放大（缩放/Esc 关闭） */}
      <PhotoProvider>
        <Streamdown
          mode={live ? "streaming" : "static"}
          parseIncompleteMarkdown={live}
          plugins={{ code, mermaid, math }}
          shikiTheme={["github-light", "github-dark"]}
          components={{
            img: ({ src, alt }) => (
              <PhotoView src={typeof src === "string" ? src : undefined}>
                <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} loading="lazy" />
              </PhotoView>
            ),
          }}
        >
          {text}
        </Streamdown>
      </PhotoProvider>
    </div>
  );
}

function BlockView({
  block,
  live,
  onSelect,
  diffComments,
  onAddDiffComment,
}: {
  block: BlockMsg;
  live: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  switch (block.kind) {
    case "text":
      return <MarkdownView text={block.text} live={live} onSelect={onSelect} />;
    case "thought":
      return <ThoughtView text={block.text} ms={block.ms} live={live} />;
    case "tool":
      return (
        <ToolBlock
          toolCallId={block.toolCallId}
          title={block.title}
          status={block.status}
          content={block.content}
          diffComments={diffComments}
          onAddDiffComment={onAddDiffComment}
        />
      );
  }
}

/** F-12-3 活动组卡：折叠态摘要 + 展开态时间线（含 F-12-4 文件变更子卡） */
function ActivityGroupCard({
  item,
  onSelect,
  diffComments,
  onAddDiffComment,
}: {
  item: Extract<RenderItem, { type: "activity_group" }>;
  onSelect?: (text: string, e: React.MouseEvent) => void;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  const [open, setOpen] = useState(false);
  const seconds = (item.ms / 1000).toFixed(0);
  const parts: string[] = [];
  if (item.thoughts > 0) parts.push(`思考 ${item.thoughts} 次`);
  if (item.tools > 0) parts.push(`工具 ${item.tools} 个`);
  const summary = parts.join(" · ") || "活动";
  // F-12-4 文件变更聚合：组内 tool 块的 diff content 按路径去重
  const diffs = item.blocks.flatMap((b) =>
    b.kind === "tool" ? b.content.filter((c): c is Extract<typeof c, { kind: "diff" }> => c.kind === "diff") : [],
  );
  const fileChanges = aggregateFileChanges(
    diffs.map((d) => ({ path: d.diff.path, oldText: d.diff.oldText, newText: d.diff.newText })),
  );
  return (
    <div className="activity-group my-1.5">
      <button
        type="button"
        aria-expanded={open}
        className="activity-head inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="inline-flex transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)", transitionTimingFunction: "var(--ease-out-soft)" }}
        >
          <ChevronRightIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
        </span>
        <ToolIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
        <span>{summary}</span>
        {seconds !== "0" && <span>· 用时 {seconds} 秒</span>}
      </button>
      {open && (
        <div
          className="activity-body"
          style={{
            borderLeft: "2px solid var(--border)",
            marginLeft: "10px",
            paddingLeft: "12px",
            marginTop: "4px",
          }}
        >
          {fileChanges.length > 0 && (
            <div className="file-changes my-1.5 rounded-md px-2.5 py-2" style={{ backgroundColor: "var(--bg-2)" }}>
              <div className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
                文件变更
              </div>
              {fileChanges.map((f) => (
                <FileChangeRow key={f.path} change={f} diffs={diffs} diffComments={diffComments} onAddDiffComment={onAddDiffComment} />
              ))}
            </div>
          )}
          {item.blocks.map((b, i) => (
            <BlockView key={i} block={b} live={false} onSelect={onSelect} diffComments={diffComments} onAddDiffComment={onAddDiffComment} />
          ))}
        </div>
      )}
    </div>
  );
}

/** F-12-4 文件变更行：路径 + 增删徽标，点击展开该文件 diff */
function FileChangeRow({
  change,
  diffs,
  diffComments,
  onAddDiffComment,
}: {
  change: { path: string; added: number; removed: number };
  diffs: Array<Extract<ToolContent, { kind: "diff" }>>;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = change.path.split("/").filter(Boolean).pop() ?? change.path;
  const own = diffs.filter((d) => d.diff.path === change.path);
  return (
    <div className="file-change-row">
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-[var(--bg-hover)]"
        style={{ color: "var(--text-primary)", transitionDuration: "var(--motion-fast)" }}
        onClick={() => setOpen((v) => !v)}
      >
        <span title={change.path}>{name}</span>
        {change.added > 0 && <span style={{ color: "var(--success)" }}>+{change.added}</span>}
        {change.removed > 0 && <span style={{ color: "var(--danger)" }}>−{change.removed}</span>}
      </button>
      {open && (
        <div className="mt-1">
          {own.map((d, i) => (
            <DiffView
              key={i}
              path={d.diff.path}
              oldText={d.diff.oldText}
              newText={d.diff.newText}
              diffComments={diffComments}
              onAddDiffComment={onAddDiffComment}
            />
          ))}
        </div>
      )}
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
          }}
        >
          {/* P11 F-R8（DEC-25）：thinking 展开体走 markdown 渲染（thinking 同样可能
              含代码围栏/公式/列表）；小字号沿用外层 13px。不用 PhotoProvider
              （AC-R8-3：thinking 是过程性内容，批注选区明确降级不开放）。 */}
          <Streamdown
            mode={live ? "streaming" : "static"}
            parseIncompleteMarkdown={live}
            plugins={{ code, math }}
            shikiTheme={["github-light", "github-dark"]}
          >
            {text}
          </Streamdown>
        </div>
      )}
    </div>
  );
}

function ToolBlock({
  title,
  status,
  content,
  diffComments,
  onAddDiffComment,
}: {
  toolCallId: string;
  title: string;
  status: string;
  content: ToolContent[];
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
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
            <ToolContentView key={i} content={c} diffComments={diffComments} onAddDiffComment={onAddDiffComment} />
          ))}
        </div>
      )}
    </div>
  );
}

/** P11 F-R6：工具 text 内容渲染——JSON pretty / ANSI 彩色 / 纯文本三分支，
 *  超长输出默认折叠（AC-R6-1..4）。导出供测试。 */
export const TOOL_TEXT_FOLD_LIMIT = 2000;

export function ToolTextView({ text }: { text: string }) {
  const foldable = text.length > TOOL_TEXT_FOLD_LIMIT;
  const [expanded, setExpanded] = useState(false);
  // 折叠态截断渲染（ansi-to-react 与 JSON.stringify 对超长文本都慢，先截断再处理）。
  // M10：截断要同时作用于 JSON 分支——原实现 pretty 用全量原文、截断只影响
  // ANSI 路径，折叠按钮点了没效果，超大 JSON 直接冻结面板。
  const shown = foldable && !expanded ? text.slice(0, TOOL_TEXT_FOLD_LIMIT) : text;
  const pretty = useMemo(() => (expanded ? prettyJson(text) : prettyJson(shown)), [shown, text, expanded]);
  const body =
    pretty !== null ? (
      <pre className="tool-text">
        <code>{pretty}</code>
      </pre>
    ) : (
      <AnsiView text={shown} />
    );
  return (
    <div className="tool-text-view">
      {body}
      {foldable && (
        <button
          type="button"
          className="tool-text-fold"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : `展开全部（${text.length} 字符）`}
        </button>
      )}
    </div>
  );
}

/** ANSI 转义渲染（DEC-23：ansi-to-react）；无 ANSI 码时原样文本 */
function AnsiView({ text }: { text: string }) {
  // ansi-to-react 仅在含转义序列时产生彩色 span，否则整段直出——这里直接交给它
  return (
    <pre className="tool-text">
      <Ansi>{text}</Ansi>
    </pre>
  );
}

function ToolContentView({
  content,
  diffComments,
  onAddDiffComment,
}: {
  content: ToolContent;
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  switch (content.kind) {
    case "text":
      return <ToolTextView text={content.text} />;
    case "diff":
      return (
        <DiffView
          path={content.diff.path}
          oldText={content.diff.oldText}
          newText={content.diff.newText}
          diffComments={diffComments}
          onAddDiffComment={onAddDiffComment}
        />
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
  diffComments,
  onAddDiffComment,
}: {
  path: string;
  oldText?: string | null;
  newText: string;
  /** F-12-5 行内评论：待发评论集（已评论行标记）+ 收集回调；缺省 = 不启用评论入口 */
  diffComments?: DiffComment[];
  onAddDiffComment?: (c: DiffComment) => void;
}) {
  const oldLines = (oldText ?? "").split("\n");
  const newLines = newText.split("\n");
  const rows: { type: "del" | "add" | "ctx"; line: string; /** 该行在 newText 中的 1 基行号；del 行 0 */ newLine: number }[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  let newLineNo = 0;
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      if (n !== undefined) newLineNo += 1;
      rows.push({ type: "ctx", line: o ?? "", newLine: n !== undefined ? newLineNo : 0 });
    } else {
      if (o !== undefined) rows.push({ type: "del", line: o, newLine: 0 });
      if (n !== undefined) {
        newLineNo += 1;
        rows.push({ type: "add", line: n, newLine: newLineNo });
      }
    }
  }
  const commented = (ln: number, lineText: string) =>
    diffComments?.some((c) => c.path === path && c.line === ln && c.lineText === lineText) ?? false;
  return (
    <div className="diff">
      <div className="diff-path">{path}</div>
      {rows.map((r, i) => (
        <div key={i} className={`diff-line group/diff ${r.type}`} data-commented={commented(r.newLine, r.line) ? "true" : "false"}>
          <span className="diff-sign">{r.type === "add" ? "+" : r.type === "del" ? "-" : " "}</span>
          {r.line}
          {/* F-12-5：hover 行尾浮现评论入口（del 行无新行号，不支持评论） */}
          {onAddDiffComment && r.newLine > 0 && (
            <button
              type="button"
              aria-label={`评论 ${path}:${r.newLine}`}
              className="diff-comment-btn ml-auto inline-flex items-center rounded px-1 text-[11px] opacity-0 transition-opacity group-hover/diff:opacity-100 hover:bg-[var(--bg-hover)]"
              style={{ color: "var(--text-secondary)", transitionDuration: "var(--motion-fast)" }}
              onClick={() => {
                const comment = window.prompt(`评论 ${path}:${r.newLine}`);
                if (comment && comment.trim()) {
                  onAddDiffComment({ path, line: r.newLine, lineText: r.line, comment: comment.trim() });
                }
              }}
            >
              <CommentIcon style={{ width: 11, height: 11, strokeWidth: 1.75 }} />
              评论
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
