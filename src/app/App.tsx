// ainone-ui 主界面：多 Tab 并行会话编排 + 左侧工作区分组侧栏（P5）。
// 每个 Tab = 一个 adapter + 一个独立会话（独立子进程），Tab 关闭时清理子进程。
// 侧栏按工作区归集会话；工作区右键：新建会话 / 重命名 / 移除。

import { useEffect, useMemo, useRef, useState } from "react";
import { Layout, Model, Actions, DockLocation, type TabNode, type Node } from "flexlayout-react";
import { listAdapters, type AdapterWithStatus } from "@/ipc/adapters";
import { sessionsList, sessionsUpsert, sessionsRemove, type SessionEntry } from "@/ipc/sessions";
import { workspacesList, workspacesUpsert, workspacesRemove, type Workspace } from "@/ipc/workspaces";
import { ChatPanel } from "@/chat/ChatPanel";
import { TerminalPanel } from "@/terminal/TerminalPanel";
import { GlobalSearchDialog } from "@/app/GlobalSearchDialog";
import { SettingsModal } from "@/app/modals/SettingsModal";
import { NewSessionModal } from "@/app/modals/NewSessionModal";
import { DonateModal } from "@/app/modals/DonateModal";
import { EmptyState } from "@/components/EmptyState";
import { RightRail } from "@/sidebar/RightRail";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  WorkspaceIcon,
  WorkspaceOpenIcon,
  CloseIcon,
  PlusIcon,
  SettingsIcon,
  DonateIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  TerminalIcon,
} from "@/components/ui/icons";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { Toaster } from "@/components/ui/sonner";
import { resolveHistoryOpen, TERMINAL_ADAPTER_ID, type Tab } from "@/app/logic/tabs";
import {
  setExternalDragPayload,
  takeExternalDragPayload,
  clearExternalDragPayload,
  payloadToTab,
} from "@/app/logic/externalDrag";
import { equalizeSplitFor } from "@/app/logic/splitEqualize";
import { groupSessions } from "@/sidebar/logic/workspaceGroup";
import { useSessionStore } from "@/store/sessionStore";
import { collectSignals, deriveStatus, type SessionStatus } from "@/sidebar/logic/sessionStatus";
import { splitShortcut, closeTabShortcut, resolveSplitTab, extractTabsFromModel, activeKeyOf, focusArrowShortcut, pickFocusTarget, type TabsetRectLike } from "@/app/logic/layout";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { clampWidth, sidebarMaxWidth } from "@/lib/sidebarResize";
import { logger } from "@/lib/logger";


/** 侧栏会话行 leading 槽：harness logo + 状态角标（F-8-1 收尾，融合 F-7-7 状态机） */
/** 侧栏会话行 leading 槽：harness logo + 状态角标（F-8-1 收尾，融合 F-7-7 状态机）。
 *  P23：终端条目（adapter_id=terminal）画 TerminalIcon，无状态角标（终端无 busy/perm）。 */
function SessionRowLeading({ adapter, st, isTerminal }: { adapter: AdapterWithStatus | undefined; st: SessionStatus; isTerminal?: boolean }) {
  if (isTerminal) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full"
        style={{ width: 22, height: 22, background: "var(--bg-3)", color: "var(--text-primary)" }}
        title="终端"
      >
        <TerminalIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
      </span>
    );
  }
  const dot =
    st === "working" ? "dot-working" : st === "awaiting_input" ? "dot-awaiting_input" : "dot-done";
  return (
    <span className="relative inline-flex shrink-0" style={{ width: 22, height: 22 }}>
      <AgentAvatar
        adapterId={adapter?.id}
        name={adapter?.name}
        brandColor={adapter?.logo}
        size={22}
        className="shrink-0"
      />
      <span
        className={`status-dot ${dot}`}
        style={{ position: "absolute", right: -1, bottom: -1 }}
        aria-hidden="true"
      />
    </span>
  );
}

/** 取路径尾段（工作区 cwd 尾缀，F-7-7） */
function tailPath(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

function App() {
  const [adapters, setAdapters] = useState<AdapterWithStatus[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string>("");
  const [history, setHistory] = useState<SessionEntry[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // P22 打赏作者弹层
  const [donateOpen, setDonateOpen] = useState(false);
  // 新建会话弹层：open + 预填工作区（右键新建时传入）
  const [newSession, setNewSession] = useState<{ open: boolean; workspaceId?: string | null }>({ open: false });
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // 主题：light / dark / auto（默认 auto 跟随系统）
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("ainone-theme") ?? "auto");
  // F-15-7 左侧栏开合（持久化 localStorage，RightRail 同款交互）
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => localStorage.getItem("ainone-sidebar-open") !== "0");
  // F-21-6 左侧栏宽度（拖宽把手，持久化；clamp 200~min(520,40vw)）
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    clampWidth(Number(localStorage.getItem("ainone-sidebar-width")) || 240, 200, sidebarMaxWidth()),
  );
  useEffect(() => {
    localStorage.setItem("ainone-sidebar-open", sidebarOpen ? "1" : "0");
  }, [sidebarOpen]);
  // F-11-2 全局 session 搜索弹层
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  // M12：系统明暗实时快照（auto 主题的 Toaster 也跟随）
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // P4：聊天面板「打开设置」动作 → 打开设置弹层（自定义事件，避免 props 层层下钻）
  useEffect(() => {
    const on = () => setSettingsOpen(true);
    window.addEventListener("ainone:open-settings", on);
    return () => window.removeEventListener("ainone:open-settings", on);
  }, []);
  const nextKey = useRef(1);
  // F-19-3 dragend 丢失兜底的查询宿主
  const layoutHostRef = useRef<HTMLDivElement | null>(null);
  // F-10-3 flexlayout Model：布局 + tab 集合的单一真源（跨渲染稳定，重建会丢拖拽布局）
  const modelRef = useRef<Model | null>(null);

  const activeTab = tabs.find((t) => t.key === activeKey) ?? tabs[0];
  const activeAdapter = activeTab ? adapters.find((a) => a.id === activeTab.adapterId) : undefined;

  function getModel(): Model {
    if (!modelRef.current) {
      modelRef.current = Model.fromJson({
        global: { tabEnableClose: true, tabEnableDrag: true, tabSetEnableTabStrip: true },
        borders: [],
        layout: { type: "row", weight: 100, children: [] },
      });
    }
    return modelRef.current;
  }

  /** 业务 Tab → flexlayout IJsonTabNode（config 存投影回业务所需字段）。
   *  component 按种类分派（P23）：terminal tab 渲染 TerminalPanel。 */
  function tabToJson(tab: Tab) {
    return {
      type: "tab",
      id: tab.key,
      name: tab.title,
      component: tab.kind === "terminal" ? "terminal" : "chat",
      config: {
        adapterId: tab.adapterId,
        sessionId: tab.sessionId,
        cwd: tab.cwd,
        workspaceId: tab.workspaceId,
        kind: tab.kind,
      },
    };
  }

  /** 从 flexlayout Model 投影回业务 tabs + activeKey（单向同步，不反向重建 model） */
  function syncFromModel() {
    const m = getModel();
    setTabs(extractTabsFromModel(m));
    const key = activeKeyOf(m);
    // P20：拖拽/调整分栏过程中 flexlayout 的 getActiveTabset 可能短暂为空
    // （拖拽 tabset 尚未 set active）→ activeKey 抖成空串 → activeTab=undefined
    // → RightRail 随之卸载；若后续 action 不再触发（WKWebView dragend 丢失，
    // F-19-3 同族），侧栏停留消失态直到点其他 session。空串时保留上一值。
    if (key) setActiveKey(key);
  }

  /** 在 target tab 所在 tabset 内 dock 一个新 tab（默认 CENTER=叠入，select） */
  function addTabToModel(tab: Tab, location: DockLocation = DockLocation.CENTER, targetNodeId?: string) {
    const m = getModel();
    let to = targetNodeId ?? activeKey;
    // VS Code 式多开（bug 修复）：
    // flexlayout 的 applyAddTab 对 toNode 只接受 TabSetNode/BorderNode/RowNode/TabGroupNode
    // （instanceof 检查不过就静默不执行）。旧实现传 activeKey（tab 节点 id）→ 第二个起全部静默失败，
    // 表现为「tab 栏永远只有一个 session，侧栏点其他 session 无反应」。
    // 正确锚点 = 激活 tab 的所在 tabset id；空布局（无 tabset）才落到根 row。
    if (to) {
      const node = m.getNodeById(to);
      // 传进来的是 tab 节点 → 换成其父 tabset
      if (node && node.getType() === "tab") {
        const parent = node.getParent();
        if (parent && parent.getType() === "tabset") {
          to = parent.getId();
        } else {
          to = "";
        }
      } else if (!node) {
        to = "";
      }
    }
    if (!to) {
      const activeTabset = m.getActiveTabset();
      to = activeTabset?.getId() ?? m.getRootRow()?.getId() ?? "";
      location = DockLocation.CENTER;
    }
    m.doAction(Actions.addTab(tabToJson(tab), to, location, -1, true));
    syncFromModel();
  }

  /** F-16-5（DEC-52）：分屏后对新增 tabset 所在层级的同向 row 均分权重，
   *  连续分屏等分而非二分。align = "row"（左右）| "col"（上下） */
  function equalizeAfterSplit(m: Model, orientation: "horz" | "vert") {
    const active = m.getActiveTabset();
    if (!active) return;
    const eq = equalizeSplitFor(active as never, orientation);
    if (!eq) return;
    m.doAction(Actions.adjustWeights(eq.rowId, eq.weights));
  }

  /** 分屏：Ctrl+Shift+D（左右）/ Ctrl+Shift+E（上下）；Ctrl+D 关闭当前 tab。
   *  新窗格 = 同 harness 同 cwd 新会话（DEC-23，快捷键重映射见 p20n）。
   *  源 tab 是终端（P23）→ 新窗格 = 同 workspace/cwd 新终端（WARP 语义按种类对齐）。 */
  function splitCurrent(axis: "row" | "col") {
    const src = activeTab;
    if (!src) return;
    const key = `tab-${nextKey.current++}`;
    const dir = axis === "row" ? DockLocation.RIGHT : DockLocation.BOTTOM;
    if (src.kind === "terminal") {
      addTabToModel(
        { key, adapterId: TERMINAL_ADAPTER_ID, title: "终端", workspaceId: src.workspaceId, cwd: src.cwd, kind: "terminal" },
        dir,
        activeKey,
      );
      equalizeAfterSplit(getModel(), axis === "row" ? "horz" : "vert");
      logger.info("split", "split-pane-terminal", { axis, srcTabKey: activeKey, newTabKey: key });
      return;
    }
    if (!activeAdapter) return;
    const st = resolveSplitTab({ adapterId: src.adapterId, workspaceId: src.workspaceId, cwd: src.cwd });
    addTabToModel(
      { key, adapterId: st.adapterId, title: "新会话", workspaceId: st.workspaceId, cwd: st.cwd },
      dir,
      activeKey,
    );
    equalizeAfterSplit(getModel(), axis === "row" ? "horz" : "vert");
    logger.info("split", "split-pane", { axis, srcTabKey: activeKey, newTabKey: key });
  }

  /** P20d：激活目标窗格并把键盘焦点交给其输入框——Cmd+方向键/点击窗格共用。
   *  「切换焦点」的终点不是悬浮高亮而是能直接打字：selectTab 让 ChatPanel 接收
   *  active prop（window 级事件按 active 实例路由），focus 落到该窗格 composer
   *  的 textarea（tab 面板 DOM id = `flexlayout-tab-<tabKey>`，flexlayout 约定）。
   *  focus 用重试式：首次激活长会话渲染可超过一帧，textarea 就绪即聚焦，
   *  最多重试 ~0.5s。不用 rAF——窗口后台/完全遮挡时 WebKit 冻结 rAF（实测踩坑）。 */
  function activateTabsetAndComposer(tabsetId: string, selectedIdx?: number) {
    const m = getModel();
    const target = m.getNodeById(tabsetId);
    if (!target) return;
    m.doAction(Actions.setActiveTabset(tabsetId));
    const sel = (target as unknown as { getChildren: () => { getId(): string }[] }).getChildren();
    let tabKey: string | undefined;
    if (sel.length > 0) {
      const idx = selectedIdx !== undefined && selectedIdx >= 0 && selectedIdx < sel.length ? selectedIdx : 0;
      tabKey = sel[idx].getId();
      m.doAction(Actions.selectTab(tabKey));
    }
    syncFromModel();
    if (!tabKey) return;
    let tries = 0;
    const focusTick = () => {
      const textarea = layoutHostRef.current?.querySelector<HTMLTextAreaElement>(
        `#flexlayout-tab-${tabKey} textarea[aria-label='消息输入']`,
      );
      if (textarea) {
        textarea.focus();
        return;
      }
      if (++tries < 10) setTimeout(focusTick, 50);
    };
    setTimeout(focusTick, 60);
  }

  // 快捷键监听：仅在编辑器区（非输入框）响应分屏快捷键（AC-P10-8）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // p20n：Ctrl/Cmd+D = 关闭当前窗格的当前 tab（原分屏快捷键让位，见 layout.ts）
      // p20p：不再 inEditable 拦截——终端窗格的 xterm helper textarea 恒占焦点，
      // 拦截导致终端窗格内分屏快捷键「永不生效」（上下分屏从未生效的根因）；
      // 聊天输入框「有时不生效」同理。这些组合键（Cmd/Ctrl[+Shift]+D/E）不产生
      // 字符输入，在可编辑控件内拦截无副作用。
      if (closeTabShortcut(e)) {
        const m = getModel();
        const tabset = m.getActiveTabset();
        const sel = tabset?.getSelectedNode?.();
        if (!sel) return;
        e.preventDefault();
        m.doAction(Actions.deleteTab(sel.getId()));
        return;
      }
      const axis = splitShortcut(e);
      if (!axis) return;
      e.preventDefault();
      splitCurrent(axis);
    }    // P20 窗格焦点切换：Cmd/Ctrl+方向键在分屏窗格间移动（WARP/VS Code 语义）。
    // 输入框内也响应——用户在输入框聊天时依然可以用方向键切窗格。
    function onFocusMove(e: KeyboardEvent) {
      const dir = focusArrowShortcut(e);
      if (!dir) return;
      const m = getModel();
      const curTabset = m.getActiveTabset();
      if (!curTabset) return;
      // 收集全部 tabset 几何。优先 model rect（getRect，布局坐标系）；
      // flexlayout 仅在 redraw 后回填 rect，部分时序下为 Rect.empty()——
      // 全空时回退读 DOM（visitNodes 顺序与 tabset_container DOM 顺序一致）。
      const nodes: { id: string; getRect?: () => { x: number; y: number; width: number; height: number } }[] = [];
      m.visitNodes((n: unknown) => {
        const node = n as { getType(): string; getId(): string; getRect?: () => { x: number; y: number; width: number; height: number } };
        if (node.getType() === "tabset") nodes.push({ id: node.getId(), getRect: node.getRect });
      });
      if (nodes.length < 2) return;
      let rects: TabsetRectLike[] = nodes.map((n) => {
        const r = n.getRect?.();
        return { id: n.id, x: r?.x ?? 0, y: r?.y ?? 0, w: r?.width ?? 0, h: r?.height ?? 0 };
      });
      if (rects.every((r) => r.w === 0 || r.h === 0)) {
        const domRects = [...layoutHostRef.current?.querySelectorAll<HTMLElement>(".flexlayout__tabset_container") ?? []].map((el) => el.getBoundingClientRect());
        if (domRects.length !== nodes.length) return;
        rects = nodes.map((n, i) => ({
          id: n.id,
          x: domRects[i].left,
          y: domRects[i].top,
          w: domRects[i].width,
          h: domRects[i].height,
        }));
      }
      const curR = rects.find((r) => r.id === curTabset.getId());
      if (!curR || (curR.w === 0 && curR.h === 0)) return;
      const targetId = pickFocusTarget(curR, rects, dir);
      if (!targetId) return;
      e.preventDefault();
      activateTabsetAndComposer(targetId, curTabset.getSelected() ?? 0);
    }
    // F-11-2 全局搜索：Ctrl/Cmd+F（DEC-26；会话内搜索已改绑 Ctrl+Shift+F）
    const onGlobalSearch = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setGlobalSearchOpen((v) => !v);
      }
    };
    // P20f：点击窗格任意位置（含聊天内容区）即切焦点 + 聚焦输入框。
    // 三个坑（实测）：
    // ① flexlayout 0.10.8 的 tab 面板（.flexlayout__tab → .panel）挂在
    //    .flexlayout__layout 下，**不在** .flexlayout__tabset_container 内——
    //    closest 容器必然 miss。命中判定改为「closest 容器 或 closest tab 面板」
    //    双通道；tab 面板经 data-layout-path 去尾段反查所属 tabset。
    // ② flexlayout 自带 tab 面板 pointerdown → setActiveTabset（只切 active 不
    //    focus）；我们做的是 superset（切 active + focus 输入框），重复 doAction
    //    set active 幂等无害。
    // ③ p20m：macOS WKWebView 对**原生鼠标输入不派发 pointer events**（黑匣子
    //    实锤：trusted 点击只有 mousedown+click，零 pointerdown；PointerEvent
    //    构造器存在但仅合成派发可用）→ 监听 pointerdown 的 onPanePointerDown
    //    对真实点击永不触发（症状：Cmd+方向键能切、鼠标点不能切）。改为
    //    mousedown；同时保留 pointerdown 以覆盖只发 pointer 的环境（触屏等），
    //    同一真实按压两者都发时用 200ms 去重窗口防双触发。
    let lastPaneSwitchAt = 0;
    function paneSwitchFromEvent(e: MouseEvent) {
      if (e.button !== 0) return;
      const now = Date.now();
      if (now - lastPaneSwitchAt < 200) return; // pointerdown/mousedown 双发去重
      if (!(e.target instanceof Element)) return;
      const host = layoutHostRef.current;
      if (!host) return;
      const containers = [...host.querySelectorAll<HTMLElement>(".flexlayout__tabset_container")];
      // model tabset 节点（DOM containers 顺序 == visitNodes 顺序）
      const m0 = getModel();
      const allNodes: { id: string }[] = [];
      m0.visitNodes((n: unknown) => {
        const node = n as { getType(): string; getId(): string };
        if (node.getType() === "tabset") allNodes.push({ id: node.getId() });
      });
      if (allNodes.length < 2) return;

      // 通道 A：点在 tab 条/空窗格（container 内）
      const container = e.target.closest<HTMLElement>(".flexlayout__tabset_container");
      // 通道 B：点在聊天内容区（tab 面板内）→ path 反查
      const tab = e.target.closest<HTMLElement>(".flexlayout__tab");
      let nodeIdx = -1;
      if (container) {
        nodeIdx = containers.indexOf(container);
      } else if (tab) {
        const tabPath = tab.getAttribute("data-layout-path") ?? "";
        const tsPath = tabPath.replace(/\/t\d+$/, "");
        nodeIdx = allNodes.findIndex((n) => {
          const node = m0.getNodeById(n.id) as unknown as { getPath?: () => string } | null;
          return node?.getPath?.() === tsPath;
        });
      }
      if (nodeIdx < 0 || nodeIdx >= allNodes.length) return;
      const node = allNodes[nodeIdx];
      if (!node || m0.getActiveTabset()?.getId() === node.id) return;
      lastPaneSwitchAt = now;
      // p20o：点击 tab 面板内容时，聚焦目标必须是**被点击的面板**（e.target 所在
      // 的 tab），而不是该 tabset 的当前选中 tab——tabset 内叠多个 tab 时（如右侧
      // 窗格 = 终端 + chat 两个 tab，当前显示 chat），按旧逻辑 selectTab(选中项)
      // 会把 tabset 切回它的选中 tab（终端）= 用户看到的「点 session 自动跳到终端」。
      // 通道 A（tab 条/空窗格）无面板概念，维持 selectedIdx 语义。
      const clickedTabKey = tab?.id.startsWith("flexlayout-tab-") ? tab.id.slice("flexlayout-tab-".length) : undefined;
      let clickedIdx = -1;
      if (clickedTabKey) {
        const children = (m0.getNodeById(node.id) as unknown as { getChildren: () => { getId(): string }[] } | null)?.getChildren();
        clickedIdx = children ? children.findIndex((c) => c.getId() === clickedTabKey) : -1;
      }
      activateTabsetAndComposer(node.id, clickedIdx >= 0 ? clickedIdx : undefined);
    }
    function onPanePointerDown(e: PointerEvent) {
      paneSwitchFromEvent(e);
    }
    function onPaneMouseDown(e: MouseEvent) {
      paneSwitchFromEvent(e);
    }
    window.addEventListener("pointerdown", onPanePointerDown, true);
    window.addEventListener("mousedown", onPaneMouseDown, true); // p20m：WKWebView 原生点击不发 pointerdown
    window.addEventListener("keydown", onGlobalSearch);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onFocusMove);
    return () => {
      window.removeEventListener("pointerdown", onPanePointerDown, true);
      window.removeEventListener("mousedown", onPaneMouseDown, true);
      window.removeEventListener("keydown", onGlobalSearch);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onFocusMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, activeTab, activeAdapter]);

  // flexlayout tab 内容工厂：tab.id = tabKey，按 component 分派 ChatPanel / TerminalPanel（P23）
  const factory = (node: TabNode) => {
    const t = tabs.find((x) => x.key === node.getId());
    if (!t) return null;
    if (t.kind === "terminal" || node.getComponent() === "terminal") {
      return <TerminalPanel key={t.key} tabKey={t.key} cwd={t.cwd} active={t.key === activeKey} />;
    }
    const ad = adapters.find((a) => a.id === t.adapterId);
    if (!ad) return null;
    return (
      <ChatPanel
        key={t.key}
        tabKey={t.key}
        adapter={ad}
        resumeSessionId={t.sessionId}
        cwd={t.cwd}
        active={t.key === activeKey}
        onFirstPrompt={(text, sid) => handleFirstPrompt(sid, t.adapterId, text, t.workspaceId, t.cwd)}
        onFork={(fromId, toId) => handleFork(fromId, toId, t.adapterId, t.workspaceId, t.cwd)}
        onForkNavigate={(toId) => handleForkNavigate(toId, t.adapterId, t.workspaceId, t.cwd)}
        onRewind={() => {}}
      />
    );
  };

  // F-21-1：tab 标题前渲染 harness logo（AgentAvatar 四层降级链，size 14 即「Tab 徽标」档；
  // leading 是渲染回调，不受 renameTab 影响；adapter 从 tabs 反查，与 factory 同法。
  // P23：终端 tab 用 TerminalIcon 徽标，无状态角标）
  const renderTab = (node: TabNode, renderValues: { leading: React.ReactNode }) => {
    const t = tabs.find((x) => x.key === node.getId());
    if (t?.kind === "terminal") {
      renderValues.leading = (
        <TerminalIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} className="shrink-0" />
      );
      return;
    }
    const ad = t ? adapterById.get(t.adapterId) : undefined;
    if (ad) {
      renderValues.leading = (
        <AgentAvatar
          adapterId={ad.id}
          name={ad.name}
          brandColor={ad.logo}
          size={14}
          className="shrink-0"
        />
      );
    }
  };

  // flexlayout 动作回调：任何模型变更（含用户关闭 tab / 拖拽 dock）→ 投影回 tabs
  /** F-19-1：跨窗格拖动 tab（含 tabset 整体移动）后，所有「≥2 子节点的 row」
   *  按子节点数均分——拖走方残缺的权重、接收方的二分切割一并归位（DEC-52 扩展：
   *  等分不只发生在分屏动作后，布局任何变更后都保持等分栅格语义） */
  function equalizeAllRows() {
    const m = getModel();
    const rows: { id: string; n: number; weights: number[] }[] = [];
    m.visitNodes((n: unknown) => {
      const node = n as { getType(): string; getChildren(): { getWeight(): number; length: number }[]; getId(): string };
      if (node.getType() === "row") {
        const cn = node.getChildren();
        if (cn.length >= 2) {
          rows.push({ id: node.getId(), n: cn.length, weights: cn.map((c) => c.getWeight()) });
        }
      }
    });
    // P20：先在数据层面判断是否需要调整，再落 doAction——flexlayout 的 doAction
    // 会无条件广播 changeListeners（即使 setWeight 写入相同值），而 onModelChange
    // 回调就是 handleAction → equalizeAllRows 无条件 doAction 会形成同步递归
    // （Maximum update depth exceeded，实测发首条消息 renameTab 即触发）。
    for (const r of rows) {
      const even = 100 / r.n;
      const needs = r.weights.some((w) => Math.abs(w - even) > 0.01);
      if (needs) m.doAction(Actions.adjustWeights(r.id, Array(r.n).fill(even)));
    }
  }

  function handleAction() {
    syncFromModel();
    // 每次布局变更（拖动跨窗格/关闭 tab/拖入新 tab）后重排为等分栅格
    equalizeAllRows();
  }

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const root = document.documentElement;
    const apply = () => {
      const isDark = theme === "dark" || (theme === "auto" && mq.matches);
      root.setAttribute("data-theme", isDark ? "dark" : "light");
    };
    apply();
    localStorage.setItem("ainone-theme", theme);
    // M12：auto 模式下监听系统明暗变化实时切换（原实现只在 theme 变化时
    // 求值一次 matchMedia，OS 切换后 data-theme 不更新）
    if (theme === "auto") {
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  function reloadAdapters() {
    listAdapters().then(setAdapters);
  }
  function reloadHistory() {
    sessionsList().then(setHistory);
  }
  function reloadWorkspaces() {
    workspacesList().then(setWorkspaces);
  }
  useEffect(() => {
    reloadAdapters();
    reloadHistory();
    reloadWorkspaces();
  }, []);

  // 首条消息 → 写会话索引（带上工作区归属与运行目录）
  function handleFirstPrompt(sessionId: string, adapterId: string, text: string, workspaceId?: string | null, cwd?: string) {
    const title = text.slice(0, 40) || "未命名会话";
    sessionsUpsert({
      session_id: sessionId,
      adapter_id: adapterId,
      title,
      cwd: cwd ?? "",
      workspace_id: workspaceId ?? null,
      mtime_ms: Date.now(),
    }).then(reloadHistory);
    // M11：同步改名 flexlayout TabNode——reloadHistory 只刷侧栏，Tab 栏的
    // name 是 addTab 时固化的，不回写会一直停留在「新会话」
    renameTabBySessionId(sessionId, title);
  }

  /** M11：按 sessionId 找到对应 Tab 并改名 flexlayout TabNode（找不到则静默跳过） */
  function renameTabBySessionId(sessionId: string, title: string) {
    const m = getModel();
    const tab = tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    const node = m.getNodeById(tab.key);
    if (node && node.getType() === "tab") {
      m.doAction(Actions.renameTab(tab.key, title));
    }
  }

  /** F-15-3 侧栏会话拖入布局：dragstart 暂存载荷（dataTransfer 通道留给
   *  flexlayout 内部识别，见 externalDrag.ts 注释）。
   *  P17 排障：会话行内含 <button>（打开/删除）。WebKit（Tauri WebView）下
   *  从 button 上按下拖动常常不会启动父级 draggable 的拖拽（实测无反应根因），
   *  行内按钮已加 draggable={false}；dragend 兜底清载荷防泄漏。 */
  function onSessionDragStart(e: React.DragEvent, h: SessionEntry) {
    setExternalDragPayload({
      sessionId: h.session_id,
      adapterId: h.adapter_id,
      title: h.title,
      cwd: h.cwd ?? "",
      workspaceId: h.workspace_id ?? null,
      kind: h.kind,
    });
    // 拖拽图像用会话行本身即可；effectAllowed move 表达「移动开新窗」语义
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", h.title);
  }

  function onSessionDragEnd() {
    // drop 未发生（拖出窗口/取消）时兜底清理，防陈旧载荷挂到下次 drop
    clearExternalDragPayload();
  }

  /** F-15-3 flexlayout 外拖接入：返回 json 让 flexlayout 走原生 drop 预览，
   *  落点（叠入 tabset / 边缘分屏）由其 drop 判定，行为与内部 tab 拖拽一致。
   *  F-16-4（DEC-51）：拖到已有 session 窗格边缘 = 分屏、拖到中央/标题条 = 叠入，
   *  与 VS Code 语义一致——flexlayout findDropTargetNode 原生提供，无需额外代码。 */
  function handleExternalDrag(_e: React.DragEvent<HTMLElement>) {
    const p = takeExternalDragPayload();
    if (!p) return undefined;
    const key = `tab-${nextKey.current}`;
    const tab = payloadToTab(p, key);
    return {
      json: tabToJson(tab),
      onDrop: (dropped?: Node) => {
        nextKey.current++;
        // F-16-5（DEC-52）：落点确定后同向均分，避免连续拖入二分。
        // dropped = 落进的新 tabset/落点节点，按其父 row 方向均分。
        if (dropped) {
          const dockOrientation = dropped.getParent()?.getOrientation().getName();
          if (dockOrientation) equalizeSplitFor(dropped as never, dockOrientation);
        }
        syncFromModel();
        logger.info("layout", "external-drop", { sessionId: p.sessionId, tabKey: key });
      },
    };
  }

  /** F-19-3：flexlayout dragend 丢失兜底。WKWebView 偶发不派发 dragend
   *  （拖拽中源元素被 React 重渲染移除 / 系统取消），dragState 残留 →
   *  drop 预览矩形常驻，像一层蓝色遮罩挡住整个窗格（用户实测复现）。
   *  flexlayout 无对外清理接口，此处用 mouseup 兜底：拖拽结束后若预览
   *  矩形仍显示（display 未被置回），直接隐藏其 DOM（引用保留，下次拖拽
   *  positionElement 会重新赋样式，无副作用）。
   *  P20：兜底会误杀拖拽中的预览——mouseup 在拖拽刚启动时（手抖松开再按住/
   *  双击起拖）也派发，250ms 后 outline 被隐藏 → 整个拖拽期间无蓝色落点
   *  预览（用户实测「有时没有蓝色预览」）。加 dragstart/dragover 心跳标记：
   *  标记新鲜（<600ms）视为拖拽进行中，跳过本轮清理。 */
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    let lastDragBeat = 0;
    const beat = () => {
      lastDragBeat = Date.now();
    };
    const onAnyEnd = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        // 拖拽进行中（dragover 持续刷新心跳）→ 预览是合法显示，不清
        if (Date.now() - lastDragBeat < 600) return;
        const host = layoutHostRef.current;
        if (!host) return;
        // 遮罩本体：.flexlayout__layout_overlay（z1000 全窗格拦截层，挡一切点击）。
        // flexlayout 在 dragend/pointerup 才把它 display:none；dragend 丢失 →
        // 残留 flex → 症状「整个 session 区无法点击」。恢复只能靠它自己，
        // 这里 display:none 后，下次拖拽 Overlay 组件重渲染 display 会回来 ✓
        const overlay = host.querySelector<HTMLElement>(".flexlayout__layout_overlay");
        if (overlay && overlay.style.display !== "none") {
          overlay.style.display = "none";
          logger.warn("layout", "dragend-stall-fallback", { layer: "overlay" });
        }
        // drop 预览矩形（蓝色框，pointer-events:none 不挡点击但视觉残留）
        const outline = host.querySelector<HTMLElement>(".flexlayout__outline_rect");
        if (outline && outline.style.visibility !== "hidden" && outline.style.display !== "none") {
          outline.style.display = "none";
          logger.warn("layout", "dragend-stall-fallback", { layer: "outline" });
        }
        const dragRect = host.querySelector<HTMLElement>(".flexlayout__drag_rect");
        if (dragRect) dragRect.style.display = "none";
        // 边缘 dock 提示块（同 outline，视觉残留）
        host.querySelectorAll<HTMLElement>(".flexlayout__edge_rect").forEach((el) => {
          el.style.display = "none";
        });
      }, 250);
    };
    window.addEventListener("mouseup", onAnyEnd, true);
    window.addEventListener("dragend", onAnyEnd, true);
    window.addEventListener("drop", onAnyEnd, true);
    // 心跳：dragover 在拖拽全程高频派发；dragstart 也打一次（启动瞬间即保护）
    window.addEventListener("dragstart", beat, true);
    window.addEventListener("dragover", beat, true);
    return () => {
      window.removeEventListener("mouseup", onAnyEnd, true);
      window.removeEventListener("dragend", onAnyEnd, true);
      window.removeEventListener("drop", onAnyEnd, true);
      window.removeEventListener("dragstart", beat, true);
      window.removeEventListener("dragover", beat, true);
      if (t) clearTimeout(t);
    };
  }, []);

  function deleteHistory(id: string) {
    sessionsRemove(id).then(reloadHistory);
  }

  function newTab(adapterId: string, workspaceId?: string | null, cwd?: string) {
    const key = `tab-${nextKey.current++}`;
    addTabToModel(
      { key, adapterId, title: "新会话", workspaceId: workspaceId ?? null, cwd },
      DockLocation.CENTER,
      activeKey,
    );
  }

  /** 新建终端 tab（P23 F-23-1）：与 harness session 同级；落会话索引供侧栏恢复
   *  （终端无「首条消息」时机，创建即落；adapter_id 固定 terminal） */
  function newTerminalTab(workspaceId?: string | null, cwd?: string) {
    const key = `tab-${nextKey.current++}`;
    const sessionId = `term-${key}`;
    addTabToModel(
      {
        key,
        adapterId: TERMINAL_ADAPTER_ID,
        sessionId,
        title: "终端",
        workspaceId: workspaceId ?? null,
        cwd,
        kind: "terminal",
      },
      DockLocation.CENTER,
      activeKey,
    );
    sessionsUpsert({
      session_id: sessionId,
      adapter_id: TERMINAL_ADAPTER_ID,
      title: "终端",
      cwd: cwd ?? "",
      workspace_id: workspaceId ?? null,
      kind: "terminal",
      mtime_ms: Date.now(),
    }).then(reloadHistory);
  }

  function openFromHistory(entry: SessionEntry) {
    const r = resolveHistoryOpen(tabs, entry, `tab-${nextKey.current}`);
    if (r.newTab) {
      nextKey.current++;
      addTabToModel(r.newTab, DockLocation.CENTER, activeKey);
    } else {
      setActiveKey(r.activateKey);
      getModel().doAction(Actions.selectTab(r.activateKey));
    }
  }

  // F-8-5 分叉：新 sessionId 落索引（标题标「从 XX 分叉」，与父会话同工作区/目录）
  function handleFork(fromSessionId: string, toSessionId: string, adapterId: string, workspaceId?: string | null, cwd?: string) {
    const parent = history.find((h) => h.session_id === fromSessionId);
    const title = parent ? `从「${parent.title}」分叉` : "分叉会话";
    sessionsUpsert({
      session_id: toSessionId,
      adapter_id: adapterId,
      title,
      cwd: cwd ?? "",
      workspace_id: workspaceId ?? null,
      mtime_ms: Date.now(),
    }).then(reloadHistory);
    // M11：新 Tab 由 handleForkNavigate 创建（title 固化「分叉会话」），改名对齐
    renameTabBySessionId(toSessionId, title);
  }

  // F-11-5 分叉自动跳转：以新 sessionId 新开 Tab（同 adapter/workspace/cwd）并激活。
  // ChatPanel 已先 logCopy 父日志 → 新 Tab 挂载时 logRead 回填历史 + session/load 恢复上下文。
  function handleForkNavigate(toSessionId: string, adapterId: string, workspaceId?: string | null, cwd?: string) {
    const entry: SessionEntry = {
      session_id: toSessionId,
      adapter_id: adapterId,
      title: "分叉会话", // reloadHistory 后会被 handleFork 写入的标题覆盖（侧栏以此为准）
      cwd: cwd ?? "",
      workspace_id: workspaceId ?? null,
      mtime_ms: Date.now(),
    };
    const r = resolveHistoryOpen(tabs, entry, `tab-${nextKey.current}`);
    if (r.newTab) {
      nextKey.current++;
      addTabToModel(r.newTab, DockLocation.CENTER, activeKey);
    } else {
      setActiveKey(r.activateKey);
      getModel().doAction(Actions.selectTab(r.activateKey));
    }
  }

  function confirmNewSession(adapterId: string, workspaceId: string | null, cwd?: string) {
    newTab(adapterId, workspaceId, cwd);
  }

  function renameWorkspace(id: string, name: string) {
    const w = workspaces.find((x) => x.id === id);
    if (!w || !name.trim()) return;
    workspacesUpsert({ ...w, name: name.trim() }).then(() => {
      reloadWorkspaces();
      reloadHistory(); // upsert 按 cwd 以新换旧，可能换了 id → 会话重绑定
    });
  }

  function removeWorkspace(id: string) {
    workspacesRemove(id).then(() => {
      reloadWorkspaces();
      reloadHistory(); // 其下会话已移入未归组，刷新
    });
  }

  // 分组：侧栏渲染用
  const groups = useMemo(() => groupSessions(workspaces, history), [workspaces, history]);

  // adapterId → adapter 表：会话行 harness logo（F-8-1 AC-P8-1 按 adapter_id 解析）
  const adapterById = useMemo(() => new Map(adapters.map((a) => [a.id, a])), [adapters]);

  // 会话状态（F-6-1）：非活跃 Tab 的 runtime 状态仍可读（zustand store）
  const runtime = useSessionStore((s) => s.runtime);
  // F-11-7 右栏数据：当前活跃 Tab 的消息（文件树「M」徽标）
  const activeMessages = (activeTab && runtime[activeTab.key]?.messages) || [];
  const statusBySession = useMemo(() => {
    const signals = collectSignals(tabs, runtime);
    const out = new Map<string, SessionStatus>();
    for (const [sid, sigs] of signals) {
      out.set(sid, deriveStatus(sigs));
    }
    return out;
  }, [tabs, runtime]);

  function statusOf(sessionId: string): SessionStatus {
    return statusBySession.get(sessionId) ?? "done";
  }

  // 活跃会话高亮（F-7-7）：当前 Tab 若已绑定 sessionId，则侧栏对应行加品牌色竖条
  const activeSessionId = activeTab?.sessionId;

  // P20i：光晕唯一性驱动——把 data-active 打在「全局焦点窗格」的 tab 面板上。
  // flexlayout 的 selected 是 per-tabset 的（分屏后每个窗格各有选中面板），
  // CSS 无法区分「窗格内选中」与「全局焦点」；activeKey 变化（点击/Cmd+方向键/
  // 侧栏点开共用 syncFromModel）时在这里统一标记，CSS 只对 [data-active] 发光。
  // 用 activeTab.key（= activeKey）反查 model activeTabset 的 selected tab id。
  useEffect(() => {
    const host = layoutHostRef.current;
    if (!host) return;
    const markTab = (tabKey: string | null) => {
      host.querySelectorAll<HTMLElement>(".flexlayout__tab[data-active]").forEach((el) => {
        el.removeAttribute("data-active");
      });
      if (!tabKey) return;
      const panel = host.querySelector<HTMLElement>(`#flexlayout-tab-${tabKey}`);
      if (panel) panel.setAttribute("data-active", "true");
    };
    const m = getModel();
    const activeTabset = m.getActiveTabset();
    const selected = activeTabset?.getSelectedNode();
    markTab(selected ? selected.getId() : null);
  }, [activeKey, tabs]);

  return (
    // 复用 Tailwind 工具类（原手写 .container 与 Tailwind 内置 container 工具类同名冲突，
    // 被其 max-width/display 覆盖导致根布局塌陷、窗口放大内容不跟随——bug 根因）
    <main className="flex h-full min-h-0 flex-col box-border p-4">
      <div className="toolbar">
        <button className="inline-flex items-center gap-1.5" onClick={() => setNewSession({ open: true })}>
          <PlusIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
          新建会话
        </button>
        {/* P23 F-23-1：新建终端——直接开一个本地 shell 终端 tab */}
        <button
          className="inline-flex items-center gap-1.5"
          onClick={() => newTerminalTab(activeTab?.workspaceId ?? null, activeTab?.cwd)}
        >
          <TerminalIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
          新建终端
        </button>
        {/* P22 打赏入口（右上角，设置左侧） */}
        <button className="donate-btn inline-flex items-center gap-1.5" onClick={() => setDonateOpen(true)}>
          <DonateIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
          打赏作者
        </button>
        <button className="settings-btn inline-flex items-center gap-1.5" onClick={() => setSettingsOpen(true)}>
          <SettingsIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
          设置
        </button>
        <label className="theme-select">
          主题：
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="auto">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
      </div>

      <div className="workspace">
        {sidebarOpen ? (
          <aside className="sidebar" style={{ width: sidebarWidth }}>
            <div className="sidebar-head">
              <h3>工作区</h3>
              <div className="sidebar-head-actions">
                <button className="add-ws" title="新建工作区" aria-label="新建工作区" onClick={() => setNewSession({ open: true })}>
                  <PlusIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
                </button>
                <button className="add-ws sidebar-collapse" title="收起侧栏" aria-label="收起侧栏" onClick={() => setSidebarOpen(false)}>
                  <SidebarCollapseIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
                </button>
              </div>
            </div>
          {groups.map((g) => {
            const wsKey = g.workspace?.id ?? "__ungrouped__";
            const hasWorkspace = Boolean(g.workspace);
            const GroupIcon = hasWorkspace ? WorkspaceOpenIcon : WorkspaceIcon;
            return (
              <div key={wsKey} className="ws-group">
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div className="ws-head">
                      <GroupIcon
                        className="ws-icon shrink-0"
                        style={{ width: 14, height: 14, strokeWidth: 1.75, color: "var(--text-secondary)" }}
                      />
                      {renaming && renaming.id === wsKey ? (
                        <input
                          autoFocus
                          className="ws-rename"
                          defaultValue={renaming.name}
                          onBlur={(e) => {
                            const id = renaming.id;
                            if (id !== "__ungrouped__") renameWorkspace(id, e.target.value);
                            setRenaming(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          }}
                        />
                      ) : (
                        <>
                          <span className="ws-name" title={g.workspace?.cwd}>
                            {g.workspace?.name ?? "未归组"}
                          </span>
                          {hasWorkspace && g.workspace!.cwd && tailPath(g.workspace!.cwd) !== g.workspace!.name && (
                            <span className="ws-cwd">{tailPath(g.workspace!.cwd)}</span>
                          )}
                        </>
                      )}
                      <span className="ws-count">{g.sessions.length}</span>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={() => setNewSession({ open: true, workspaceId: g.workspace?.id ?? null })}>
                      新建会话
                    </ContextMenuItem>
                    {/* P23 F-23-1：工作区右键新建终端（cwd = 工作区目录） */}
                    <ContextMenuItem
                      onSelect={() =>
                        newTerminalTab(
                          g.workspace?.id ?? null,
                          g.workspace?.cwd ?? activeTab?.cwd,
                        )
                      }
                    >
                      新建终端
                    </ContextMenuItem>
                    {hasWorkspace && (
                      <>
                        <ContextMenuItem
                          onSelect={() => {
                            const w = workspaces.find((x) => x.id === g.workspace!.id);
                            if (w) setRenaming({ id: g.workspace!.id, name: w.name });
                          }}
                        >
                          重命名
                        </ContextMenuItem>
                        <ContextMenuItem variant="destructive" onSelect={() => removeWorkspace(g.workspace!.id)}>
                          移除工作区
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
                <div className="ws-sessions">
                  {g.sessions.map((h) => {
                    const st = statusOf(h.session_id);
                    const active = h.session_id === activeSessionId;
                    const isTerminalRow = h.kind === "terminal";
                    const hAdapter = adapterById.get(h.adapter_id);
                    return (
                      <div
                        key={h.session_id}
                        className={`history-item status-${st} ${active ? "history-active" : ""}`}
                        // F-15-3 拖入布局开 tab / 分屏（载荷走模块级暂存，DEC-43）
                        draggable
                        onDragStart={(e) => onSessionDragStart(e, h)}
                        onDragEnd={onSessionDragEnd}
                      >
                        <SessionRowLeading adapter={hAdapter} st={st} isTerminal={isTerminalRow} />
                        {/* F-8-1 AC-P8-1：hover/聚焦显示 harness 名称 */}
                        {/* P17：行内按钮 draggable={false}——WebKit 下 button 会吞掉
                            父级 draggable 的拖拽启动（拖拽分屏无反应的根因） */}
                        <button
                          className="history-open"
                          draggable={false}
                          onClick={() => openFromHistory(h)}
                          title={isTerminalRow ? "终端" : hAdapter ? hAdapter.name : h.session_id}
                        >
                          {h.title}
                        </button>
                        <button
                          className="history-del"
                          draggable={false}
                          aria-label="删除会话"
                          onClick={() => deleteHistory(h.session_id)}
                        >
                          <CloseIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
                        </button>
                      </div>
                    );
                  })}
                  {g.sessions.length === 0 && <div className="hint ws-empty">（空）</div>}
                </div>
              </div>
            );
          })}
          {groups.length === 0 && (
              <EmptyState
                icon={WorkspaceIcon}
                title="暂无工作区"
                description="点击新建会话并选择目录开始"
                actionLabel="新建会话"
                onAction={() => setNewSession({ open: true })}
              />
            )}
            <SidebarResizeHandle
              edge="right"
              min={200}
              max={() => sidebarMaxWidth()}
              width={sidebarWidth}
              onResize={setSidebarWidth}
              onResizeEnd={(w) => localStorage.setItem("ainone-sidebar-width", String(w))}
              label="拖拽调整侧栏宽度"
            />
          </aside>
        ) : (
          // F-15-7 折叠态：细栏杆（展开 + 新建两个图标位）
          <aside className="sidebar sidebar-collapsed">
            <button className="add-ws" title="展开侧栏" aria-label="展开侧栏" onClick={() => setSidebarOpen(true)}>
              <SidebarExpandIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
            </button>
            <button className="add-ws" title="新建工作区" aria-label="新建工作区" onClick={() => setNewSession({ open: true })}>
              <PlusIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
            </button>
          </aside>
        )}

        <section className="tabs-area">
          {/* F-10-3 flexlayout 分屏窗格：替换原 tabs-bar + tab-content 区域 */}
          <div className="layout-host" ref={layoutHostRef} data-dragging={false}>
            <Layout
              model={getModel()}
              factory={factory}
              onRenderTab={renderTab}
              onModelChange={handleAction}
              realtimeResize
              onExternalDrag={handleExternalDrag}
            />
          </div>
          {/* F-11-7 右侧侧边栏：元数据 / 文件 双 tab（替换原独立 MetadataPanel） */}
          {activeAdapter && activeTab && (
            <RightRail
              tabKey={activeTab.key}
              adapter={activeAdapter}
              sessionId={activeTab.sessionId ?? null}
              cwd={activeTab.cwd}
              messages={activeMessages}
            />
          )}
        </section>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={reloadAdapters}
      />

      <DonateModal open={donateOpen} onClose={() => setDonateOpen(false)} />

      <NewSessionModal
        open={newSession.open}
        adapters={adapters}
        workspaces={workspaces}
        presetWorkspaceId={newSession.workspaceId}
        onClose={() => setNewSession({ open: false })}
        onConfirm={confirmNewSession}
        onOpenTerminal={newTerminalTab}
        onWorkspaceCreated={reloadWorkspaces}
      />

      {/* F-11-2 全局 session 搜索（Ctrl+F，悬浮中上） */}
      <GlobalSearchDialog
        open={globalSearchOpen}
        onOpenChange={setGlobalSearchOpen}
        onPick={openFromHistory}
      />

      {/* 全局 toast（sonner，右下 3s）：错误 / 复制成功提示（F-7-8） */}
      <Toaster
        theme={systemDark && theme === "auto" ? "dark" : theme === "dark" ? "dark" : "light"}
        position="bottom-right"
        duration={3000}
      />
    </main>
  );
}

export default App;
