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
import type * as acp from "@agentclientprotocol/sdk";
import { type AskAnswer, answersToContent, fieldsToQuestions, parseSchemaFields } from "../chat/logic/askCard";
import { PlanBar } from "@/chat/components/PlanBar";
import { FilePreview } from "@/sidebar/FilePreview";
import { QueueDock } from "@/chat/components/QueueDock";
import { QuotePanel, AttachList, DiffCommentsBar, EditBanner } from "@/chat/components/PanelStrips";
import { Composer } from "@/chat/composer/Composer";
import { QuickAskPopup } from "@/chat/composer/QuickAskPopup";
import { UsageBar } from "@/chat/components/UsageBar";
import { Welcome } from "@/chat/Welcome";
import { MessageLine } from "@/chat/message/MessageLine";
import { useTypewriter } from "@/chat/hooks/useTypewriter";
import { createStreamCommitThrottle } from "@/chat/hooks/streamCommitThrottle";
import { createFollowBottom } from "@/chat/hooks/followBottom";
import { ChevronDownIcon } from "@/components/ui/icons";
import { useQueueStore } from "@/store/queueStore";
import { logRead, logAppend, logTruncate, logCopy } from "@/ipc/sessions";
import { notifySend } from "@/ipc/notify";
import { shouldNotify, turnEndBody } from "@/chat/logic/notify";
import { parseLog, serializeMessages } from "@/acp/message-log";
import { newTurn, applyEvent, type TurnAccumulator } from "@/acp/turn";
import { completeCommand } from "../chat/logic/slash";
import {
  flattenWorkspaceFiles,
  filterAtFiles,
  applyAtToken,
} from "../chat/logic/atFile";
import { workspaceListDir } from "@/ipc/fslist";
import { gitCurrentBranch } from "@/ipc/gitmeta";
import { filterExcluded } from "@/lib/fileTree";
import { composeQuotedPrompt, type Quote } from "../chat/logic/quote";
import { composeFileReference, filterAbsoluteFiles, type FileRef } from "../chat/logic/fileRef";
import { truncateToMessageIndex } from "@/acp/rewind";
import { lastUserIndex, shouldShowLastPromptBubble, ellipsize } from "../chat/logic/lastPrompt";
import { doublePress, userIndices, nextUserCursor, matchShortcut, type ShortcutId } from "@/app/logic/keymap";
import { inEditable } from "@/app/logic/layout";
import { useKeymapStore } from "@/store/keymapStore";
import { truncateMessagesToEdit } from "../chat/logic/edit-resend";
import { canFork, capabilitySnapshot } from "../chat/logic/capabilities";
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
  type PermState,
} from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AskCard } from "@/chat/components/AskCard";
import { PermCard } from "@/chat/components/PermCard";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import "@/chat/chat.css";
import "@/chat/message/messages.css";
import "@/chat/composer/composer.css";

// 权限决策类型：selected = 用户选了某个 optionId；cancelled = 超时/turn 收口的
// 协议原生取消（RequestPermissionOutcome 支持 { outcome: "cancelled" }）
type PermDecision = { kind: "selected"; optionId: string } | { kind: "cancelled" };
// P24e：权限请求超时（对标 DeepChat DEFAULT_PERMISSION_TIMEOUT_MS）
const PERM_TIMEOUT_MS = 60_000;

interface Props {
  tabKey: string;  adapter: AdapterWithStatus;
  resumeSessionId?: string;
  /** 会话运行目录（工作区 cwd）；缺省用 adapter.cwd */
  cwd?: string;
  /** M5：当前 Tab 是否活跃（flexlayout 非激活窗格保持挂载，ref-file/拖拽等
   *  window 级事件必须只作用于活跃实例，否则多窗格互相串扰）。
   *  注意：这是「全局焦点」语义（App 只给 activeKey 的实例传 true）——
   *  分屏时非焦点窗格也屏幕可见，可见性走 visible。 */
  active?: boolean;
  /** P34 R1：当前 Tab 是否屏幕可见（= 其所在 tabset 的选中 tab，flexlayout
   *  positionTabPanels 的 visible 判定同源）。驱动虚拟列表 enabled——
   *  可见即计算，display:none 的非选中 tab 冻结。默认 true 向后兼容。
   *  R7 教训：enabled 曾绑 active（全局焦点），分屏失焦窗格被误冻结 → 白屏。 */
  visible?: boolean;
  onFirstPrompt?: (text: string, sessionId: string) => void;
  /** F-8-5 分叉：返回 (父 sessionId, 新 sessionId) 供 App 落索引 */
  onFork?: (fromSessionId: string, toSessionId: string) => void;
  /** F-11-5 分叉自动跳转：fork 成功后 App 以新 sessionId 开 Tab 并激活 */
  onForkNavigate?: (newSessionId: string) => void;
  /** F-8-6 回溯：启用用户消息「回溯到这里」入口 */
  onRewind?: (index: number) => void;
  /** P29 R5：活跃会话句柄上抛（App → RightRail → MetadataPanel 模型切换用）。
   *  建链/回收/重建时回调；null = 无活跃会话。 */
  onActiveSession?: (s: { setConfigOption?: (configId: string, value: string) => Promise<unknown> } | null) => void;
  /** P32d：session/list 句柄上抛（null = 未声明 list 能力 → 会话列表入口隐藏） */
  onSessionList?: (list: (() => Promise<Array<{ sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }>>) | null) => void;
}

export function ChatPanel({ tabKey, adapter, resumeSessionId, cwd, onFirstPrompt, onFork, onForkNavigate, onRewind, onActiveSession, onSessionList, active = true, visible = true}: Props) {
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
  // P4 启动期错误：常驻横幅（toast 一次即逝，带「打开设置」引导）
  const [startError, setStartError] = useState<string | null>(null);
  // F-8-2 批注：已收集的多段批注（原文 + 疑问）
  const [quotes, setQuotes] = useState<Quote[]>([]);
  // 恢复会话但日志缺失/损坏时的降级提示（F-4-3 → P24f 三态化）：
  // "ok" = 正常；"log-missing" = 日志空/损坏但模型上下文已恢复（仅影响回看）；
  // "context-lost" = 恢复链降级 new，模型上下文已丢失（降级 toast 在 ensureSession）
  const [historyState, setHistoryState] = useState<"ok" | "log-missing" | "context-lost">("ok");
  const slashRef = useRef<HTMLTextAreaElement | null>(null);

  // F-11-3 @ 文件联想：null = 未展开；展开时为 token 信息
  const [atMenu, setAtMenu] = useState<{ query: string; start: number; end: number } | null>(null);
  // @ 数据源：cwd 目录懒加载缓存（与 FileTree 共用 workspaceListDir，形状：路径→子项）
  const [atTree, setAtTree] = useState<Record<string, Array<{ name: string; is_dir: boolean }>>>({});
  const atMenuRef = useRef<HTMLDivElement | null>(null);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);

  const workspaceCwd = cwd && cwd.length > 0 ? cwd : adapter.cwd;

  // F-7-6 打字机 placeholder：80ms/字循环打出建议语；reduced-motion 直接显全文。
  // P32 R3：非激活窗格（display:none 渲染照跑）或用户已输入时暂停——
  // 旧实现无条件 12.5 渲染/s × 每 tab，后台窗格纯浪费。
  const typeText = useTypewriter(typewriterHint(adapter), active && input.length === 0);

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
  // F-21-4：决策值 = ACP optionId 原样回传（不再客户端猜 allow/reject 前缀，L12 废弃）。
  // P24e：决策升级为 PermDecision——cancelled 是协议原生 outcome（RequestPermissionOutcome），
  // 替代旧的「猜 reject 选项」收口启发式（无 reject 类选项时会误选可能是 allow 的首选项）
  const permResolver = useRef<((d: PermDecision) => void) | null>(null);
  // P24e 权限请求 60s 超时兜底：harness 撤回权限请求时不发任何通知，
  // 悬挂的 PermCard 会永远卡在界面上（DeepChat P0-1 同款修复）
  const permTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // 本地日志身份（事实源反转的最小落地）：与 harness sessionId 解绑。
  // 恢复链降级（load 失败 → new）会换 harness sessionId，但日志文件必须
  // 挂在原会话身份上，否则旧日志断链、新消息写进孤儿文件。初值 = 恢复侧栏
  // 历史时的 sessionId；全新会话在首次 bindSession 时固化。
  const logSidRef = useRef<string | null>(resumeSessionId ?? null);
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
  // F-8-7 悬浮窗：null=关闭；流式中/结果/错误三态（P27：loading→streaming，text 增量累积）
  const [quickPop, setQuickPop] = useState<{ state: "streaming" | "ok" | "error"; text: string } | null>(null);
  // F-11-6 快问悬浮窗点外关闭：DOM ref
  const quickPopRef = useRef<HTMLDivElement | null>(null);
  const quickSelRef = useRef<string | null>(null);
  quickSelRef.current = quickSel;
  // F-8-3 文件引用：待发送附件集（按钮选择 / 拖拽 同路径）
  const [files, setFiles] = useState<FileRef[]>([]);
  // P16 F-16-1 文件预览浮层：当前预览的绝对路径（null=关闭）
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  // P25：keydown 闭包来自挂载帧，previewPath 走 ref 镜像（同 editTargetRef 模式）
  const previewPathRef = useRef<string | null>(null);
  previewPathRef.current = previewPath;
  // 稳定引用：FilePreview 已 memo，内联箭头会击穿（P16a）
  const closePreview = useCallback(() => setPreviewPath(null), []);
  // F-8-3 拖拽悬停高亮
  const [dragging, setDragging] = useState(false);
  // F-8-6 回溯：待确认的目标消息下标（null = 无）
  const [rewindTarget, setRewindTarget] = useState<number | null>(null);
  // M5：active prop 镜像——window 级监听闭包来自挂载帧，读 ref 取最新活跃态
  const activeRef = useRef(active);
  activeRef.current = active ?? true;
  // P31 多 tab 模型独立切换：active 变为 true 时重抛当前会话句柄。
  // App 只给 activeKey 的 ChatPanel 传 setter，但句柄仅在会话绑定时上抛——
  // 切 tab 后 App.activeSession 可能仍持旧 tab 的句柄，侧栏切模型会打到
  // 旧 tab 的会话（set_config_option 发错 sessionId）。重抛修正归属。
  useEffect(() => {
    if (active) {
      onActiveSession?.(
        sessionRef.current
          ? { setConfigOption: sessionRef.current.setConfigOption ?? undefined }
          : null,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
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

  // —— P25 键盘导航 ——
  // 焦点域：composer=输入框（默认）| chat=聊天记录（↑↓/PgUp/PgDn/Home/End 滚动生效域）。
  // Ctrl+L 切换；点击输入框/聊天区聚焦输入框（p20f 现状）时自动回 composer。
  const [focusZone, setFocusZone] = useState<"composer" | "chat">("composer");
  const focusZoneRef = useRef(focusZone);
  focusZoneRef.current = focusZone;
  // Alt+↑↓ 用户消息跳转游标（-1 = 尚未跳过）
  const userCursorRef = useRef(-1);
  // 双击 Esc 中断的上次时间戳
  const lastEscRef = useRef(0);
  // P25：语音开关注册（VoiceInput → Composer 透传；ref 持最新回调供快捷键触发）
  const voiceToggleRef = useRef<(() => void) | null>(null);
  const registerVoiceToggle = useCallback((fn: () => void) => {
    voiceToggleRef.current = fn;
  }, []);
  // P25：Ctrl+O 全局展开/折叠覆写。三态循环：null→true(全展开)→false(全收起)→true；
  // 用户手动点单卡回调置 null（回局部态）
  const [activityOverride, setActivityOverride] = useState<boolean | null>(null);
  const clearActivityOverride = useCallback(() => setActivityOverride(null), []);

  // 挂载：建立 store 运行时；恢复会话时先读本地日志回填 UI（不依赖进程，进程懒开）
  useEffect(() => {
    ensure(tabKey, adapter.id);
    // F-15-6：拉取会话 cwd 的 git 分支（非 git 仓库 → null，侧栏显示「—」）
    gitCurrentBranch(workspaceCwd)
      .then((branch) => {
        if (branch) {
          logger.debug("meta", "branch", { branch });
          useSessionStore.getState().setBranch(tabKey, branch);
        }
      })
      .catch(() => {});
    if (resumeSessionId) {
      logRead(resumeSessionId)
        .then((raw) => {
          const msgs = parseLog(raw);
          if (msgs.length > 0) {
            setMessages(tabKey, msgs);
            persistedRef.current = msgs.length;
          } else {
            setHistoryState("log-missing");
          }
        })
        .catch(() => setHistoryState("log-missing"));
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
    // F-18-5：dragDropEnabled=false 后 Tauri 原生拖放事件不再派发，文件拖入
    // 改走 HTML5 dnd（dragover/drop 读 dataTransfer）；webview 级监听 →
    // panel 内监听天然按窗格隔离（无需 M5 active 守卫，事件落点即面板）。
    // 错误环境（jsdom / 浏览器预览无 drag 事件）静默降级。
    const panelEl = () => panelRef.current;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return; // 不拦截：flexlayout 的内部/外部拖拽不受影响
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      if (e.currentTarget === panelEl()) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      // WKWebView（macOS）在 dragDropEnabled=false 后 File 对象带 webkitRelativePath
      // 而非绝对路径；Electron 式 f.path 仅 Chromium 提供。macOS 下 HTML5 文件
      // 拖入拿不到绝对路径 → 走 File.name 兜底不可行，改为「读取文件内容」语义：
      // 直接读文本进附件不可靠（二进制），故 toast 引导改用 ＋ 按钮选择文件。
      const count = e.dataTransfer?.files?.length ?? 0;
      const anyPath = Array.from(e.dataTransfer?.files ?? []).some(
        (f) => typeof (f as File & { path?: string }).path === "string",
      );
      if (count > 0 && anyPath) {
        const paths = Array.from(e.dataTransfer!.files)
          .map((f) => (f as File & { path?: string }).path!)
          .filter(Boolean);
        const abs = filterAbsoluteFiles(paths.map((p) => ({ path: p })));
        if (abs.length > 0) addFiles(abs);
      } else if (count > 0) {
        toast.info("当前系统拿不到拖入文件的完整路径，请用 ＋ 按钮选择文件");
      }
    };
    // 挂载时 panelRef 尚未赋值（effect 在 render 后运行，panelRef.current 已可用）
    const host = panelEl();
    host?.addEventListener("dragover", onDragOver);
    host?.addEventListener("dragleave", onDragLeave);
    host?.addEventListener("drop", onDrop);
    // F-11-6 快问悬浮窗 Esc 关闭（F-15-2：会话内搜索已移除，全局搜索走 App 层 Ctrl+F）
    // P25：双击 Esc 中断也在此层——单 Esc 已被上方编辑态/快问窗消费的场景不再触发中断
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // P26b：模态浮层开着时 Esc 归浮层（Radix Dialog 关闭等），不进 pane 消费链
        const target = e.target as Element | null;
        if (target?.closest?.("[role='dialog'], [cmdk-root]")) return;
        if (editTargetRef.current) {
          cancelEdit();
          lastEscRef.current = 0; // 消费型 Esc 不参与双击
          return;
        }
        if (quickSelRef.current !== null) {
          setQuickSel(null);
          lastEscRef.current = 0;
          logger.debug("chat", "quick-pop-dismiss", { reason: "escape" });
          return;
        }
        // P25 双击 Esc 中断：非激活窗格忽略；IME composing 忽略；非 busy 忽略；
        // 预览浮层开着时单 Esc 先关预览（FilePreview 层），不进双击计数
        if (!(activeRef.current ?? true)) return;
        if (e.isComposing) return;
        const isBusy = useSessionStore.getState().runtime[tabKey]?.busy ?? false;
        if (!isBusy || previewPathRef.current) return;
        const now = Date.now();
        if (doublePress(now, lastEscRef.current, 500)) {
          lastEscRef.current = 0;
          logger.info("chat", "interrupt-double-esc", { tabKey });
          void stop();
        } else {
          lastEscRef.current = now;
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
    // P16 F-16-1 文件预览：RightRail 单击文件 → 打开窗格内预览浮层（active 守卫同 ref-file）
    const onOpenFile = (e: Event) => {
      if (!(activeRef.current ?? true)) return;
      const path = (e as CustomEvent<string>).detail;
      if (typeof path !== "string") return;
      setPreviewPath(path);
    };
    window.addEventListener("ainone:open-file", onOpenFile);
    // P16 F-16-2 历史 tab：跳转到第 N 条用户消息 / 请求回溯（CustomEvent，active 守卫同 ref-file）
    const onJumpMessage = (e: Event) => {
      if (!(activeRef.current ?? true)) return;
      const d = (e as CustomEvent<{ index?: number }>).detail;
      if (typeof d?.index !== "number" || d.index < 0) return;
      logger.info("history", "jump-recv", { index: d.index });
      jumpToIndex(d.index);
    };
    const onRewindRequest = (e: Event) => {
      if (!(activeRef.current ?? true)) return;
      const d = (e as CustomEvent<{ index?: number }>).detail;
      if (typeof d?.index !== "number" || d.index < 0) return;
      logger.info("history", "rewind-recv", { index: d.index });
      // 复用既有回溯链路：确认 Dialog + busy 保护（doRewind 内）
      setRewindTarget(d.index);
    };
    window.addEventListener("ainone:jump-message", onJumpMessage);
    window.addEventListener("ainone:rewind-request", onRewindRequest);
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
        // P29：回收后活跃会话句柄失效
        onActiveSession?.(null);
        // L7：时点修正——这里是「执行回收」，reopen 发生在下一次 ensureSession；
        // 原埋点把 recycle 记成 reopen，日志时间轴误导。
        logger.info("session", "recycle", { sessionId: s.sessionId });
        recycledRef.current = true;
        void s.recycle(lastActivityRef.current).catch(() => {});
      }
    }, 15_000);
    return () => {
      if (recycleTimerRef.current) clearInterval(recycleTimerRef.current);
      // P24e 路径 c：卸载时收口未决权限请求（清 timer + cancelled，防悬挂响应）
      if (permTimerRef.current) {
        clearTimeout(permTimerRef.current);
        permTimerRef.current = null;
      }
      permResolver.current?.({ kind: "cancelled" });
      permResolver.current = null;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("ainone:ref-file", onRefFile);
      window.removeEventListener("ainone:open-file", onOpenFile);
      window.removeEventListener("ainone:jump-message", onJumpMessage);
      window.removeEventListener("ainone:rewind-request", onRewindRequest);
      document.removeEventListener("mousedown", onDocMouseDown);
      unlisten?.();
      host?.removeEventListener("dragover", onDragOver);
      host?.removeEventListener("dragleave", onDragLeave);
      host?.removeEventListener("drop", onDrop);
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
    // H9（F3）：新建会话的 sessionId 只在 store 里（prop 的 resumeSessionId
    // 仅恢复侧栏历史时才有）。空闲回收 dispose 后重建必须走 session/load，
    // 否则 session/new 清零 harness 上下文——UI 消息完好但模型失忆，无感知。
    // 回溯/编辑重发链路（sessionRef 已断 + store sessionId 已被截断后重建）
    // 见下：截断时同步清 bindSession，落空即回 session/new，语义一致。
    const storeSessionId = useSessionStore.getState().runtime[tabKey]?.sessionId;
    const resumeId = resumeSessionId ?? storeSessionId ?? undefined;
    setStarting(true);
    try {
      const s = await openSession(
        adapter,
        async (params) => {
          // F-21-4：结构化 perm 入 store → PermCard 内嵌渲染（harness 选项全量透出）
          const perm: PermState = {
            title: params.toolCall.title ?? "（无标题工具调用）",
            options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind ?? null })),
          };
          patch(tabKey, { perm });
          // P33 F-32-1：窗口失焦时通知「等待权限批准」（决策在 shouldNotify 纯函数）
          {
            const decision = shouldNotify({ reason: "perm", windowFocused: document.hasFocus() });
            if (decision.send) {
              logger.info("notify", "fire", { reason: "perm", tabKey });
              void notifySend(`${adapter.name} 等待权限批准`, perm.title);
            }
          }
          // P24e：60s 超时兜底——harness 撤回请求不发通知，超时回协议原生
          // cancelled，不让 PermCard 永远卡在界面上（三条清 timer 路径：
          // a) onPerm 正常决策；b) finally turn 收口；c) 组件卸载 cleanup）
          if (permTimerRef.current) clearTimeout(permTimerRef.current);
          permTimerRef.current = setTimeout(() => {
            logger.warn("chat", "perm-timeout", { title: perm.title, timeoutMs: PERM_TIMEOUT_MS });
            permResolver.current?.({ kind: "cancelled" });
            permResolver.current = null;
          }, PERM_TIMEOUT_MS);
          const decision = await new Promise<PermDecision>((resolve) => {
            permResolver.current = resolve;
          });
          if (permTimerRef.current) {
            clearTimeout(permTimerRef.current);
            permTimerRef.current = null;
          }
          patch(tabKey, { perm: null });
          if (decision.kind === "cancelled") {
            return { outcome: { outcome: "cancelled" } as acp.RequestPermissionResponse["outcome"] };
          }
          // optionId 由 PermCard 原样回传；兜底 options[0]（harness 撤销选项的极端情况）
          const target = params.options.find((o) => o.optionId === decision.optionId);
          return {
            outcome: {
              outcome: "selected",
              optionId: target?.optionId ?? params.options[0].optionId,
            },
          };
        },
        resumeId,
        (words: CommandWord[]) => setCommands(adapter.id, words),
        cwd,
        // F-12-2 结构化提问：把 Elicitation 请求转成 store 状态 → AskCard 渲染
        // P30：schema 解析/键映射全部下沉 askCard.ts 纯函数（可单测防回归）——
        // 回传 content 以 schema 原始属性键为键（question_<n>[_custom]），
        // 桥的 per-question Other 字段并入所属题，不再渲染成独立问题
        async (params) => {
          // URL 模式 / 自定义模式本客户端不支持 → decline（不悬挂 agent）
          if (params.mode !== "form") {
            logger.info("chat", "ask-unsupported-mode", { mode: String(params.mode) });
            return { action: "decline" };
          }
          const schema = (params.requestedSchema ?? {}) as {
            properties?: Record<string, Record<string, unknown>>;
          };
          const fields = parseSchemaFields(schema.properties ?? {});
          const questions = fieldsToQuestions(fields);
          const propTypes: Record<string, string> = Object.fromEntries(
            fields.filter((f) => !f.isCustomAnswer).map((f) => [f.title, f.type]),
          );
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
          return { action: "accept", content: answersToContent(questions, answers, propTypes) };
        },
      );
      sessionRef.current = s;
      bindSession(tabKey, s.sessionId);
      // P29：session/new 存档的 configOptions（category="model" 即模型选择器）进 store
      if (s.configOptions) useSessionStore.getState().setConfigOptions(tabKey, s.configOptions);
      // P29 R5：活跃会话句柄上抛（模型切换面板的 set_config_option 通道）
      onActiveSession?.({ setConfigOption: s.setConfigOption ?? undefined });
      // 日志身份固化：全新会话（无恢复来源）首次建链时把 logSid 锚定为
      // harness sessionId；此后即使恢复链降级换 sessionId，日志文件身份不变
      if (logSidRef.current === null) logSidRef.current = s.sessionId;
      // capability 存档进 store（P32d：snapshot 五布尔——入口显隐与恢复链的单一事实源）
      patch(tabKey, {
        capabilities: s.capabilities ?? null,
        caps: s.capabilities ? capabilitySnapshot(s.capabilities) : null,
        degraded: null,
      });
      // P32d：session/list 句柄上抛（会话列表入口 gate = caps.list，句柄 null 即无能力）
      onSessionList?.(s.listSessions ?? null);
      // 恢复链降级（session/load 失败 → session/new）：模型上下文丢了，
      // 用户必须知道——toast 一次 + 常驻降级标记（横幅渲染处消费）
      if (s.sessionOrigin === "degraded-new") {
        const reason = s.loadError ?? "session/load 失败";
        logger.warn("session", "resume 降级 new", { requested: resumeId, reason });
        patch(tabKey, { degraded: { reason } });
        // 横幅三态：context-lost 优先于 log-missing（若日志也空，两个洞叠加时
        // 显示更严重的 context-lost 文案）
        setHistoryState("context-lost");
        toast.error("未能恢复模型上下文，已新建会话继续");
      }
      if (hadSession) {
        recycledRef.current = false;
        logger.info("session", "reopen after recycle", { sessionId: s.sessionId });
      }
      // M9：resume 会话（promptedOnce 初值 true）永远不拉 providers → 侧栏
      // apiType/baseUrl 恒空。ensureSession 建链后补拉一次（幂等，失败静默）。
      if (resumeId) {
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
      // P24f（隐藏 bug 修复）：编辑重发的文本此前从未落盘——旧实现把「替换后
      // 的列表长度」当游标 + 截日志保留 N 行（旧行是旧文本），编辑后的新文本
      // 永远写不进日志。改为：游标/截断都停在编辑目标之前（保留 target.index
      // 行），runPrompt 的 persistUserMessage 会把编辑后文本作为新行追加
      persistedRef.current = target.index;
      // H7：同 doRewind——await 截断完成，避免与新消息 append 竞态
      await truncateAndDetach(target.index);
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

    // P16 F-16-3（DEC-50）：busy 时不再 steering 打断——入队等待（运行中不能覆盖
    // 前一条消息）；队列消费时机不变（turn_stop 非 cancelled/user 自动 dequeue）。
    // steering 能力保留在队列条目「立即发」（sendNowSteer）。
    if (busy) {
      const ok = enqueueCommand(full);
      if (ok) toast.success(`已加入队列（第 ${(useQueueStore.getState().queues[tabKey] ?? []).length} 位）`);
      return;
    }
    follow.scrollToBottom(); // P33 AC-3.6：发送新消息强制回底并恢复跟随
    appendUser(tabKey, full);
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

  // P16 F-16-3（DEC-50）：「立即发」——打断当前 turn 并把该条作为 steering 立即发出。
  // M2 顺序保持：先赋值 pendingTextRef 再 stop（stop 返回后 finally 立即消费 ref）；
  // 该条先从队列移除，避免 finally 消费队列时重复发送。
  // H14（F4）：按 id 删条目（按文本匹配在重复文本时只会删到第一条）。
  async function sendNowSteer(text: string, id?: string) {
    if (id !== undefined) {
      useQueueStore.getState().remove(tabKey, id);
      logger.info("queue", "steer-from-queue", { id, busy });
    } else {
      // 兼容仅文本入口：找不到 id 时按文本兜底
      const q = useQueueStore.getState().queues[tabKey] ?? [];
      const entry = q.find((i) => i.text === text);
      if (entry) useQueueStore.getState().remove(tabKey, entry.id);
      logger.info("queue", "steer-from-queue", { id: entry?.id, busy });
    }
    if (busy) {
      pendingTextRef.current = text;
      await stop();
      return;
    }
    appendUser(tabKey, text);
    await runPrompt(text);
  }

  // —— 回溯/编辑重发的进程断开链路（DEC-35）共用：截 store 消息 + 截日志 ——
  // + 清 store sessionId（H9 配套：截断后重建必须走 session/new，
  //   session/load 只会恢复 harness 全量历史，截断就白做了）。
  // 失败时明确提示不静默（H7）。
  async function truncateAndDetach(keepCount: number) {
    // 日志身份走 logSidRef（降级会话的 harness sessionId 已换，不能用它截旧日志）
    const sid = logSidRef.current ?? sessionRef.current?.sessionId ?? resumeSessionId;
    if (sid) {
      try {
        await logTruncate(sid, keepCount);
      } catch (e) {
        logger.error("chat", "log-truncate 失败", { sid, keepLines: keepCount, error: String(e) });
        toast.error("日志截断失败，恢复会话时可能看到旧历史");
      }
    }
    // 清 sessionId：下次 ensureSession 落空 → session/new（load 会全量恢复历史）
    useSessionStore.getState().bindSessionClear(tabKey);
    // 断开当前子进程
    sessionRef.current?.dispose().catch(() => {});
    sessionRef.current = null;
    // 提示词不变：load 语义下「上下文已丢弃」本就虚假（F1 调研），降级提示
    toast.info("已在本地截断历史；模型侧上下文可能仍保留（协议限制）");
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
    // P16（DEC-50）：busy → 入队不打断（与 submit 同语义）
    if (busy) {
      enqueueCommand(text);
      return;
    }
    appendUser(tabKey, text);
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
    // P16（DEC-50）：busy → 入队不打断（与 submit 同语义）
    if (busy) {
      enqueueCommand(text);
      return;
    }
    appendUser(tabKey, text);
    void runPrompt(text);
  }

  // —— F-8-5 会话分叉：从当前状态 fork，新会话落索引（标注来源）——
  // F-11-5：fork 成功后复制父日志为新会话日志 + 回调 onForkNavigate 自动跳转新 Tab
  async function doFork() {
    if (busy) {
      toast.warning("当前 turn 运行中，等待结束后再分叉");
      return;
    }
    const fromSessionId = logSidRef.current ?? sessionRef.current?.sessionId ?? resumeSessionId;
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
    // H7：先 await 截断完成再继续（原 fire-and-forget 有「先 append 后 truncate」
    // 竞态——回溯后立即发消息时新消息可能被一并截掉）
    await truncateAndDetach(truncated.length);
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
    setQuickPop({ state: "streaming", text: "" });
    // P32 R6：delta 按帧合并提交——复用 streamCommitThrottle（与主聊天流式
    // 同一节流语义）。SSE 每条 delta 一次 setState → 悬浮窗所在 ChatPanel
    // 全量重渲染；rAF 合帧后 setState 频率与显示帧率对齐。完成/异常时 flush。
    let pendingText = "";
    const throttle = createStreamCommitThrottle(() => {
      setQuickPop((prev) =>
        prev && (prev.state === "streaming" || prev.state === "ok")
          ? { state: "streaming", text: pendingText }
          : prev,
      );
    });
    try {
      // P27 流式：Rust 侧 SSE 逐块推增量，悬浮窗实时渲染（不再整段等完）
      const out = await quickAsk(text, (delta) => {
        pendingText += delta;
        throttle.schedule();
      });
      throttle.dispose();
      setQuickPop({ state: "ok", text: out });
    } catch (e) {
      throttle.dispose();
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

  async function runPrompt(text: string, opts?: { queueItemId?: string; isRetry?: boolean }) {
    // F-8-1：刷新最近交互时间戳（回收判定的数据源）
    lastActivityRef.current = Date.now();
    // P30：lastEventAt 同步落定——首事件前静默时长以 prompt 发出时刻起算
    patch(tabKey, { busy: true, turnStartedAt: Date.now(), lastEventAt: Date.now() });
    turnRef.current = newTurn();
    // P31 流式提交节流：applyEvent 仍逐条累积到 turnRef（不丢事件），但
    // 「累积结果 → store」按渲染帧合并提交。实测 8 条/s 的 update 频率 ×
    // 每条全量重渲染是 WebView 满载主因（2026-09-08 事故），节流后每帧
    // 最多一次提交，流式期间的渲染次数与帧率对齐而非与事件到达率对齐。
    // P32 R1：lastEventAt 并入节流提交——旧实现每条内容事件都 patch 一次
    // lastEventAt（事件率 8-10/s），store 写频率未被 P31 节流覆盖，且 prop
    // 下传所有 MessageLine 击穿 memo。改为 commit 时一并写入（帧级），事件
    // 循环内只记到局部变量。
    let lastEventAtPending: number | undefined;
    const throttle = createStreamCommitThrottle(() => {
      useSessionStore.getState().updateLastAssistant(tabKey, () => turnRef.current.blocks);
      if (lastEventAtPending !== undefined) {
        useSessionStore.getState().patch(tabKey, { lastEventAt: lastEventAtPending });
        lastEventAtPending = undefined;
      }
    });
    const p = (async () => {
      try {
        const session = await ensureSession();
        // P24f（洞 A）：user 消息即时落盘——先日志后索引。旧时序里 user 消息
        // 要等整个 turn 结束才随 persistNew 落盘，期间强退 → 索引指向从未创建
        // 的日志文件 →「历史消息未找到」横幅。落点选在 ensureSession 之后、
        // session.prompt 之前（单一咽喉点，覆盖 submit/队列/steer/quotes 全部路径）
        await persistUserMessage();
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
          if (e.type === "config_options") {
            // P29：config_option_update 全量刷新（模型切换 currentValue 实时更新）
            useSessionStore.getState().setConfigOptions(tabKey, e.options);
            return;
          }
          if (e.type === "session_info") {
            // P32d：session_info_update——agent 生成的会话标题/更新时间
            useSessionStore.getState().patch(tabKey, {
              sessionInfo: {
                ...(e.title !== undefined ? { title: e.title } : {}),
                ...(e.updatedAt !== undefined ? { updatedAt: e.updatedAt } : {}),
              },
            });
            return;
          }
          const next = applyEvent(turnRef.current, e, Date.now);
          turnRef.current = next;
          // P30 AC-3.4：每个 turn 内容事件刷新「最近事件」时刻（静默感知数据源）。
          // P32 R1：不再逐事件 patch store（事件率写库击穿 memo），记到局部变量
          // 随节流提交（帧级），flush 时一并落定终态
          lastEventAtPending = Date.now();
          throttle.schedule();
        });
        // turn 结束：摊平 blocks 到 store（applyEvent 已封口 thinking）；
        // 空 turn（无事件）不新起 assistant 气泡（编辑重试后的静默重开场景）
        throttle.flush(); // 强制提交帧内未落的累积快照（终态必须可见）
        if (lastEventAtPending !== undefined) {
          // P32 R1：帧内事件无 pending 提交时（如 flush 前 schedule 未触发），终态 lastEventAt 仍落定
          useSessionStore.getState().patch(tabKey, { lastEventAt: lastEventAtPending });
          lastEventAtPending = undefined;
        }
        if (turnRef.current.blocks.length > 0) {
          useSessionStore.getState().updateLastAssistant(tabKey, () => turnRef.current.blocks);
        }
        // P33 F-32-1：窗口失焦时通知「任务完成」（用户自己取消不发——shouldNotify 决策）
        {
          const reason = stopReasonRef.current ?? "end_turn";
          const decision = shouldNotify({ reason: "turn_end", windowFocused: document.hasFocus(), stopReason: reason });
          if (decision.send) {
            logger.info("notify", "fire", { reason: "turn_end", tabKey, stopReason: reason });
            const lastText = [...turnRef.current.blocks].reverse().find((b) => b.kind === "text");
            void notifySend(
              `${adapter.name} 任务完成`,
              turnEndBody(lastText && lastText.kind === "text" ? lastText.text.split("\n")[0] : undefined),
            );
          }
        }
      } catch (err) {
        logger.error("chat", "prompt 失败", { tabKey, adapter: adapter.id, error: String(err) });
        toast.error(`出错了：${String(err)}`);
        // P4：启动期失败常驻横幅（toast 一次即逝，用户无从得知下一步动作）
        setStartError(String(err));
        throttle.dispose(); // 异常收口：撤销帧内 pending（catch 里直接提交终态快照）
        const next: TurnAccumulator = {
          ...turnRef.current,
          blocks: [...turnRef.current.blocks, { kind: "text", text: `\n\n⚠️ ${String(err)}` }],
        };
        useSessionStore.getState().updateLastAssistant(tabKey, () => next.blocks);
        if (lastEventAtPending !== undefined) {
          // P32 R1：异常收口同样落定 lastEventAt（finally 会清空，此写只为语义完整：
          // 静默计时基准在错误块渲染期间仍可用）
          useSessionStore.getState().patch(tabKey, { lastEventAt: lastEventAtPending });
          lastEventAtPending = undefined;
        }
        // 队列条目执行失败 → 回插队首（条目不丢）。重试语义：isRetry 防死循环
        //（retried 条目失败不再回插）；不撤 user 气泡——已发生的尝试是事实。
        if (opts?.queueItemId && !opts?.isRetry) {
          useQueueStore.getState().requeueHead(tabKey, {
            id: opts.queueItemId,
            text,
            retried: true,
          });
          toast.warning("该任务执行失败，已放回队列首位");
        }
      } finally {
        patch(tabKey, { busy: false, turnStartedAt: undefined, lastEventAt: undefined });
        runRef.current = null;
        // H10：turn 结束时未决的权限请求/提问卡一并收口（turn 已中止，
        // harness 不会再消费答案；resolver 悬挂会让 Dialog/AskCard 卡在界面上）。
        // P24e：收口语义统一为协议原生 cancelled（替代旧「猜 reject 选项」启发式——
        // 无 reject 类选项时会误选可能是 allow 的首选项）
        if (permResolver.current) {
          if (permTimerRef.current) {
            clearTimeout(permTimerRef.current);
            permTimerRef.current = null;
          }
          permResolver.current({ kind: "cancelled" });
          permResolver.current = null;
        }
        if (askResolver.current) {
          askResolver.current(null);
          askResolver.current = null;
        }
        patch(tabKey, { perm: null, ask: null });
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
          // M1：用户主动停止（stopReason=cancelled）→ 不续发，队列保留。
          // （L13："user" 不在 ACP StopReason 枚举里，死分支移除）
          const reason = stopReasonRef.current ?? "end_turn";
          stopReasonRef.current = null;
          const userCancelled = reason === "cancelled";
          const head = userCancelled ? null : useQueueStore.getState().dequeue(tabKey);
          if (head) {
            logger.info("queue", "consume", { id: head.id, retried: head.retried ?? false });
            // retried 条目重放：transcript 已有该 user 气泡 + 错误块，跳过 appendUser
            //（不重复气泡）；成功则新的 assistant turn 跟在错误块后，时间线自然
            if (!head.retried) appendUser(tabKey, head.text);
            void runPrompt(head.text, { queueItemId: head.id, isRetry: head.retried ?? false });
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
    // 日志身份走 logSidRef（与 harness sessionId 解绑，见 ref 定义处注释）
    const sid = logSidRef.current ?? sessionRef.current?.sessionId;
    if (!sid) return;
    const msgs = useSessionStore.getState().runtime[tabKey]?.messages ?? [];
    const count = persistedRef.current;
    if (msgs.length <= count) return;
    const lines = serializeMessages(msgs.slice(count));
    persistedRef.current = msgs.length;
    logAppend(sid, lines).catch((e) => {
      // P24f：失败不再静默——日志是唯一事实源，写失败必须留痕
      logger.error("chat", "logAppend 失败", { sid, lines: lines.length, error: String(e) });
    });
  }

  // —— P24f（洞 A）：user 消息即时落盘（turn 开始时调用）——
  // 语义：若游标下一条是 user 消息则立刻写盘并推进游标；失败 logger.error 显式留痕
  //（不中断 turn——消息已在 store，下轮 persistNew 仍会尝试写全量增量）
  async function persistUserMessage() {
    const sid = logSidRef.current ?? sessionRef.current?.sessionId;
    if (!sid) return;
    const msgs = useSessionStore.getState().runtime[tabKey]?.messages ?? [];
    const next = msgs[persistedRef.current];
    if (!next || next.role !== "user") return;
    try {
      await logAppend(sid, serializeMessages([next]));
      persistedRef.current += 1;
    } catch (e) {
      logger.error("chat", "user 消息落盘失败", { sid, error: String(e) });
    }
  }

  async function stop() {
    // P25：busy 走 store 快照而非闭包旧值（双击 Esc 快捷键与停止钮共用本函数）
    if (!(useSessionStore.getState().runtime[tabKey]?.busy ?? false)) return;
    try {
      await sessionRef.current?.cancel();
    } catch {
      /* ignore */
    }
  }

  // F-21-4：PermCard 决策入口（optionId 原样转传 resolver；P24e 路径 a：清超时 timer）
  function onPerm(optionId: string) {
    if (permTimerRef.current) {
      clearTimeout(permTimerRef.current);
      permTimerRef.current = null;
    }
    permResolver.current?.({ kind: "selected", optionId });
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
    // P16（DEC-50）：busy → 入队不打断（与 submit 同语义）
    if (busy) {
      enqueueCommand(text);
      return;
    }
    appendUser(tabKey, text);
    void runPrompt(text);
  }

  const perm = rt?.perm ?? null;

  // P24g capability gate：fork 入口按 initialize 握手能力显隐（没能力不显示入口，
  // 而不是点了报错）。回溯不 gate——软回溯是纯本地能力，与 harness 无关。
  const forkEnabled = canFork(rt?.capabilities ?? null);

  // 长会话虚拟列表（AC-P3-5 回归）：只渲染可见区消息。
  // P34 R1：enabled: visible——绑定「屏幕可见性」（本 tab 是其 tabset 的选中 tab）
  // 而非「全局焦点」。R7 曾绑 active（全局焦点）：分屏失焦窗格屏幕上明明可见，
  // 却被冻结 → calculateRange 短路 → 全部虚拟项卸载 → 白屏（用户实测）。
  // display:none 的非选中 tab（同 tabset 切走）真不可见，enabled=false 冻结：
  // 滚动容器 rect=0 会让 range=null → 虚拟项全卸载，切回时整列表重挂载 +
  // measureElement 全量重测 + Streamdown 重解析。enabled=false 时 virtualizer
  // 冻结（源码核实：scrollRect/scrollOffset 置 null、不挂 ResizeObserver、
  // 不消费 scrollElement），切回自动恢复观察。
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => chatScrollRef.current,
    estimateSize: () => 120,
    overscan: 8,
    enabled: visible,
  });

  // F-11-9 上一条指令回跳气泡
  const lastUserIdx = useMemo(() => lastUserIndex(messages), [messages]);
  const lastUserText = lastUserIdx >= 0 && messages[lastUserIdx].role === "user" ? messages[lastUserIdx].text : "";
  const [atBottom, setAtBottom] = useState(true);
  // P33 AC-3.x：自动滚动跟随——流式/折叠展开引起内容增高时贴底；wheel 向上/远端按下
  // 接管（跟随暂停）；滚回近底、点回底按钮、发送新消息恢复。逻辑在 followBottom.ts
  // （纯逻辑注入可测），此处只做事件接线 + atBottom 显隐合一（一个来源，同一阈值）。
  const followRef = useRef<ReturnType<typeof createFollowBottom> | null>(null);
  if (!followRef.current) {
    followRef.current = createFollowBottom({ getScroller: () => chatScrollRef.current });
  }
  const follow = followRef.current;
  useEffect(() => () => follow.dispose(), [follow]);
  // 滚动监听（raf 节流）：距底 >64px 显示气泡/回底按钮 + 跟随状态机消费 scroll
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        setAtBottom(dist <= 64);
        follow.onScroll();
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
  }, [follow]);
  // P33：用户手势接管——wheel 向上立即接管；按下（WKWebView 原生点击无 pointerdown，
  // 记忆 P23）用 mousedown/touchstart 双通道。passive 不阻断默认滚动行为。
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      follow.onWheel(e.deltaY);
    };
    const onPress = () => follow.onPress();
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("mousedown", onPress, { passive: true });
    el.addEventListener("touchstart", onPress, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("mousedown", onPress);
      el.removeEventListener("touchstart", onPress);
    };
  }, [follow]);
  // P33 AC-3.7：内容增高驱动跟随——虚拟容器（getTotalSize 撑高的节点）尺寸变化即
  // onContentGrow，rAF 合帧推底。流式 chunk 与 diff 展开/收起共用该路径。
  const streamContentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const content = streamContentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => follow.onContentGrow());
    ro.observe(content);
    return () => ro.disconnect();
  }, [follow]);
  // L2：回跳目标消息短暂高亮（与搜索命中高亮同型，1.2s 后退场）
  const [lastPromptFlash, setLastPromptFlash] = useState(-1);
  // P16 F-16-2：通用跳转（双 rAF 校跳——远端未测量条目首跳按 estimateSize 漂移，
  // 两帧后再跳一次；原逻辑在 jumpToLastPrompt 内联，抽出供历史锚点/回跳共用）
  function jumpToIndex(index: number) {
    virtualizer.scrollToIndex(index, { align: "start" });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(index, { align: "start" });
        setLastPromptFlash(index);
        window.setTimeout(() => setLastPromptFlash(-1), 1200);
      }),
    );
  }
  function jumpToLastPrompt() {
    if (lastUserIdx < 0) return;
    logger.debug("chat", "last-prompt-jump", { index: lastUserIdx });
    jumpToIndex(lastUserIdx);
  }

  // —— P25 键盘导航动作 ——

  /** 焦点域切换（Ctrl+L）：composer ↔ chat。→chat 时输入框 blur；→composer 时聚焦输入框 */
  function toggleFocusZone() {
    const next = focusZoneRef.current === "composer" ? "chat" : "composer";
    setFocusZone(next);
    focusZoneRef.current = next;
    if (next === "chat") {
      slashRef.current?.blur();
      logger.debug("chat", "focus-zone", { zone: "chat" });
    } else {
      slashRef.current?.focus();
      logger.debug("chat", "focus-zone", { zone: "composer" });
    }
  }

  /** 聊天记录滚动（zone=chat 时 ↑↓/PgUp/PgDn/Home/End）；非激活 tab（display:none）守卫 */
  function scrollChat(action: "line-up" | "line-down" | "page-up" | "page-down" | "top" | "bottom") {
    const el = chatScrollRef.current;
    if (!el) return;
    const LINE = 40; // 一行 ≈ 40px（消息行高量级）
    switch (action) {
      case "line-up": el.scrollTop -= LINE; break;
      case "line-down": el.scrollTop += LINE; break;
      case "page-up": el.scrollTop -= el.clientHeight * 0.9; break;
      case "page-down": el.scrollTop += el.clientHeight * 0.9; break;
      case "top": el.scrollTop = 0; break;
      case "bottom": el.scrollTop = el.scrollHeight; break;
    }
  }

  /** Alt+↑/↓ 跳转上/下一条用户消息（复用 jumpToIndex 双 rAF 校跳 + flash 高亮）。
   *  messages 从 store 快照读取——onPaneKey 监听闭包来自挂载帧，
   *  直接引 messages 会拿到旧数组（同 editTargetRef 模式的理由）。 */
  function jumpUserMessage(dir: 1 | -1) {
    const msgs = useSessionStore.getState().runtime[tabKey]?.messages ?? [];
    const idx = userIndices(msgs);
    const target = nextUserCursor(idx, userCursorRef.current, dir);
    if (target === null) return;
    userCursorRef.current = target;
    logger.debug("chat", "jump-user", { dir, index: target });
    jumpToIndex(target);
  }

  const empty = messages.length === 0;

  // P25 pane 级快捷键：非激活窗格忽略；键位从 keymapStore 取。
  // 分层守卫：
  //   - chat.voice-toggle（Alt+\）：语音开关属于 composer 功能，输入框内也响应；
  //   - chat.jump-prev/next-user：Alt+↑↓ 不覆盖（mac Option+↑↓ 是 textarea 词移动），
  //     输入框内不响应（inEditable 豁免）；
  //   - pane.scroll-*：仅 zone=chat 且焦点不在可编辑控件（xterm helper textarea
  //     天然命中 inEditable → 裸键落回终端，符合预期）；
  //   - pane.focus-zone（Ctrl+L）：组合键无字符输入，任何焦点下都响应。
  const keymapDefs = useKeymapStore((s) => s.defs);
  const keymapOverrides = useKeymapStore((s) => s.overrides);
  useEffect(() => {
    function onPaneKey(e: KeyboardEvent) {
      if (!(activeRef.current ?? true)) return;
      if (e.isComposing) return;
      // P26b：模态浮层（弹窗/下拉等）开着时让位——事件 target 在浮层内，
      // pane 快捷键不应响应（如新建会话弹窗里 ↑↓ 移动 cmdk 高亮，
      // 不应同时滚动背后 session 的聊天记录）
      const target = e.target as Element | null;
      if (target?.closest?.("[role='dialog'], [cmdk-root]")) return;
      const match = (id: ShortcutId) => matchShortcut(e, keymapDefs, id, keymapOverrides);
      if (match("pane.focus-zone")) {
        e.preventDefault();
        toggleFocusZone();
        return;
      }
      if (match("chat.voice-toggle")) {
        e.preventDefault();
        voiceToggleRef.current?.();
        return;
      }
      if (match("pane.activity-toggle-all")) {
        e.preventDefault();
        // 三态循环：无覆写→全展开→全收起→全展开
        setActivityOverride((v) => (v === null ? true : v === true ? false : true));
        return;
      }
      if (match("chat.jump-prev-user") || match("chat.jump-next-user")) {
        if (inEditable(document.activeElement)) return;
        e.preventDefault();
        jumpUserMessage(match("chat.jump-next-user") ? 1 : -1);
        return;
      }
      const scrollAction = match("pane.scroll-line-up")
        ? ("line-up" as const)
        : match("pane.scroll-line-down")
          ? ("line-down" as const)
          : match("pane.scroll-page-up")
            ? ("page-up" as const)
            : match("pane.scroll-page-down")
              ? ("page-down" as const)
              : match("pane.scroll-top")
                ? ("top" as const)
                : match("pane.scroll-bottom")
                  ? ("bottom" as const)
                  : null;
      if (scrollAction) {
        // 焦点域=chat 且焦点不在输入控件时才滚动；composer 域不拦截（光标自由移动）
        if (focusZoneRef.current !== "chat") return;
        if (inEditable(document.activeElement)) return;
        e.preventDefault();
        scrollChat(scrollAction);
      }
    }
    window.addEventListener("keydown", onPaneKey);
    return () => window.removeEventListener("keydown", onPaneKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keymapDefs, keymapOverrides]);

  // F-16-3（DEC-50）：dock 高度实测 → panel 级 CSS 变量 --dock-h，
  // .chat 的 padding-bottom 引用它，末条消息不再被输入框遮挡。
  // P18：非激活 tab display:none → offsetHeight=0，加 >0 守卫。
  // P19：--dock-h 语义改为「dock 底部距 panel 顶部的总占位」（rect.height +
  // bottom 偏移）——此前只算 offsetHeight，漏掉 bottom:10px 的偏移与 dock
  // 内部条带展开后的实际高度，实测仍遮挡。
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  // F-21-5：.panel DOM 节点作为 Composer 全屏编辑的 portal 宿主（ref 是非响应式的，
  // 用 state 桥接使首次挂载后触发一次重渲染把节点传下去）
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    const dock = dockRef.current;
    if (!panel || !dock) return;
    const apply = () => {
      const dockRect = dock.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      if (dockRect.height <= 0) return; // 非激活 tab（display:none）不写 0
      const total = panelRect.bottom - dockRect.top;
      if (total > 0) panel.style.setProperty("--dock-h", `${total}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(dock);
    // dock 的 transform 定位不触发自身 resize；panel 尺寸变化时总占位也要重算
    const roPanel = new ResizeObserver(apply);
    roPanel.observe(panel);
    return () => {
      ro.disconnect();
      roPanel.disconnect();
    };
  }, []);

  return (
    <div
      className="panel"
      ref={(el) => { panelRef.current = el; setPanelEl(el); }}
      data-dragging={dragging ? "true" : "false"}
      data-zone={focusZone}
    >
      {/* P16 F-16-1 文件预览浮层（DEC-48）：窗格内右侧 overlay，非模态 */}
      {previewPath && <FilePreview path={previewPath} onClose={closePreview} />}
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
        {startError && !starting && (
          <div className="hint degraded" role="alert">
            ⚠️ {adapter.name} 启动失败：{startError}
            <button className="hint-action" onClick={() => window.dispatchEvent(new CustomEvent("ainone:open-settings"))}>
              打开设置
            </button>
          </div>
        )}
        {empty && historyState === "ok" && <Welcome adapter={adapter} onSuggest={sendSuggestion} />}
        {empty && historyState === "log-missing" && (
          // P24f（洞 B）：文案准确化——session/load 成功时模型上下文其实完好，
          // 只是本地日志缺失（旧文案「上下文已恢复，历史消息未找到」暗示上下文丢失，误导）
          <div className="hint degraded">⚠️ 模型上下文已恢复；本地历史消息缺失，仅影响回看</div>
        )}
        {empty && historyState === "context-lost" && (
          <div className="hint degraded">⚠️ 未能恢复模型上下文，已新建会话；上方历史仅为本地存档</div>
        )}
        <div
          ref={streamContentRef}
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
                  // P32 R1：lastEventAt 只传末条——消费点（TurnElapsed）仅
                  // busy && isLast 需要；传所有行会让每次提交击穿全部 MessageLine 的 memo
                  lastEventAt={vi.index === messages.length - 1 ? rt?.lastEventAt : undefined}
                  onSelect={onSelectText}
                  onFork={forkEnabled && onFork ? doFork : undefined}
                  onRewind={onRewind ? () => askRewind(vi.index) : undefined}
                  onEdit={m.role === "user" ? () => startEdit(vi.index) : undefined}
                  diffComments={diffComments}
                  onAddDiffComment={addDiffComment}
                  activityOverride={activityOverride}
                  onActivityOverrideClear={clearActivityOverride}
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
        {/* F-21-4 权限审批内嵌卡：窗格内渲染替代全屏 modal（多分屏不再互相遮挡） */}
        {perm && (
          <PermCard title={perm.title} options={perm.options} onDecide={onPerm} />
        )}
        {/* P33 AC-3.4：回到底部悬浮按钮——接管（上翻）后出现，点击恢复跟随。
            与「你最后说的」回跳气泡互斥布局冲突小（一上一下），各自独立显隐。 */}
        {!atBottom && (
          <button
            type="button"
            className="scroll-to-bottom-btn"
            data-testid="scroll-to-bottom"
            aria-label="回到底部"
            title="回到底部"
            onClick={() => {
              follow.scrollToBottom();
              setAtBottom(true);
            }}
          >
            <ChevronDownIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
          </button>
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

      {/* F-15-1 底部悬浮 dock（DEC-41）：composer 及其上方条带群整体悬浮，
          .chat 独占整高，消息从浮层下方穿过——滚动到顶部输入区仍常驻可见。
          F-16-3（DEC-50）：ResizeObserver 实测 dock 高度写入 --dock-h，
          .chat 的 padding-bottom 动态跟随，条带增减不再遮挡末条消息。 */}
      <div className="composer-dock" ref={dockRef}>
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
        onVoice={(text) => setInput((prev) => (prev ? `${prev}\n${text}` : text))}
        onPickSlash={pickSlash}
        onPickAt={pickAt}
        expandPortalTarget={panelEl}
        registerVoiceToggle={registerVoiceToggle}
        />
      </div>

      {/* P16 F-16-3 队列悬浮 Dock（DEC-50）：右下角浮层，z 高于 composer-dock。
          「立即发」= steering 语义（M2：先赋值 pendingTextRef 再 stop，见 sendNowSteer） */}
      <QueueDock
        tabKey={tabKey}
        busy={busy}
        onSendNow={sendNowSteer}
      />    </div>
  );
}
