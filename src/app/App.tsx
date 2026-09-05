// ainone-ui 主界面：多 Tab 并行会话编排 + 左侧工作区分组侧栏（P5）。
// 每个 Tab = 一个 adapter + 一个独立会话（独立子进程），Tab 关闭时清理子进程。
// 侧栏按工作区归集会话；工作区右键：新建会话 / 重命名 / 移除。

import { useEffect, useMemo, useRef, useState } from "react";
import { Layout, Model, Actions, DockLocation, type TabNode, type Node } from "flexlayout-react";
import { listAdapters, type AdapterWithStatus } from "@/ipc/adapters";
import { sessionsList, sessionsUpsert, sessionsRemove, type SessionEntry } from "@/ipc/sessions";
import { workspacesList, workspacesUpsert, workspacesRemove, type Workspace } from "@/ipc/workspaces";
import { ChatPanel } from "@/chat/ChatPanel";
import { GlobalSearchDialog } from "@/app/GlobalSearchDialog";
import { SettingsModal } from "@/app/modals/SettingsModal";
import { NewSessionModal } from "@/app/modals/NewSessionModal";
import { EmptyState } from "@/components/EmptyState";
import { RightRail } from "@/sidebar/RightRail";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  WorkspaceIcon,
  WorkspaceOpenIcon,
  CloseIcon,
  PlusIcon,
  SettingsIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
} from "@/components/ui/icons";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { Toaster } from "@/components/ui/sonner";
import { resolveHistoryOpen, type Tab } from "@/app/logic/tabs";
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
import { splitShortcut, inEditable, resolveSplitTab, extractTabsFromModel, activeKeyOf } from "@/app/logic/layout";
import { logger } from "@/lib/logger";


/** 侧栏会话行 leading 槽：harness logo + 状态角标（F-8-1 收尾，融合 F-7-7 状态机） */
function SessionRowLeading({ adapter, st }: { adapter: AdapterWithStatus | undefined; st: SessionStatus }) {
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
  // 新建会话弹层：open + 预填工作区（右键新建时传入）
  const [newSession, setNewSession] = useState<{ open: boolean; workspaceId?: string | null }>({ open: false });
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  // 主题：light / dark / auto（默认 auto 跟随系统）
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("ainone-theme") ?? "auto");
  // F-15-7 左侧栏开合（持久化 localStorage，RightRail 同款交互）
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => localStorage.getItem("ainone-sidebar-open") !== "0");
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
  // F-10-3 flexlayout Model：布局 + tab 集合的单一真源（跨渲染稳定，重建会丢拖拽布局）
  const modelRef = useRef<Model | null>(null);

  const activeTab = tabs.find((t) => t.key === activeKey);
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

  /** 业务 Tab → flexlayout IJsonTabNode（config 存投影回业务所需字段） */
  function tabToJson(tab: Tab) {
    return {
      type: "tab",
      id: tab.key,
      name: tab.title,
      component: "chat",
      config: {
        adapterId: tab.adapterId,
        sessionId: tab.sessionId,
        cwd: tab.cwd,
        workspaceId: tab.workspaceId,
      },
    };
  }

  /** 从 flexlayout Model 投影回业务 tabs + activeKey（单向同步，不反向重建 model） */
  function syncFromModel() {
    const m = getModel();
    setTabs(extractTabsFromModel(m));
    setActiveKey(activeKeyOf(m));
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
   *  连续 Ctrl+D 等分而非二分。align = "row"（左右）| "col"（上下） */
  function equalizeAfterSplit(m: Model, orientation: "horz" | "vert") {
    const active = m.getActiveTabset();
    if (!active) return;
    const eq = equalizeSplitFor(active as never, orientation);
    if (!eq) return;
    m.doAction(Actions.adjustWeights(eq.rowId, eq.weights));
  }

  /** 分屏：Ctrl+D（左右）/ Ctrl+Shift+D（上下），新窗格 = 同 harness 同 cwd 新会话（DEC-23） */
  function splitCurrent(axis: "row" | "col") {
    const src = activeTab;
    if (!src || !activeAdapter) return;
    const st = resolveSplitTab({ adapterId: src.adapterId, workspaceId: src.workspaceId, cwd: src.cwd });
    const key = `tab-${nextKey.current++}`;
    const dir = axis === "row" ? DockLocation.RIGHT : DockLocation.BOTTOM;
    addTabToModel(
      { key, adapterId: st.adapterId, title: "新会话", workspaceId: st.workspaceId, cwd: st.cwd },
      dir,
      activeKey,
    );
    equalizeAfterSplit(getModel(), axis === "row" ? "horz" : "vert");
    logger.info("split", "split-pane", { axis, srcTabKey: activeKey, newTabKey: key });
  }

  // 快捷键监听：仅在编辑器区（非输入框）响应分屏快捷键（AC-P10-8）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const axis = splitShortcut(e);
      if (!axis) return;
      if (inEditable(document.activeElement)) return;
      e.preventDefault();
      splitCurrent(axis);
    }
    // F-11-2 全局搜索：Ctrl/Cmd+F（DEC-26；会话内搜索已改绑 Ctrl+Shift+F）
    const onGlobalSearch = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setGlobalSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onGlobalSearch);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onGlobalSearch);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, activeTab, activeAdapter]);

  // flexlayout tab 内容工厂：tab.id = tabKey，渲染 ChatPanel
  const factory = (node: TabNode) => {
    const t = tabs.find((x) => x.key === node.getId());
    if (!t) return null;
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

  // flexlayout 动作回调：任何模型变更（含用户关闭 tab / 拖拽 dock）→ 投影回 tabs
  function handleAction() {
    syncFromModel();
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

  return (
    // 复用 Tailwind 工具类（原手写 .container 与 Tailwind 内置 container 工具类同名冲突，
    // 被其 max-width/display 覆盖导致根布局塌陷、窗口放大内容不跟随——bug 根因）
    <main className="flex h-full min-h-0 flex-col box-border p-4">
      <div className="toolbar">
        <button className="inline-flex items-center gap-1.5" onClick={() => setNewSession({ open: true })}>
          <PlusIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
          新建会话
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
          <aside className="sidebar">
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
                        <SessionRowLeading adapter={hAdapter} st={st} />
                        {/* F-8-1 AC-P8-1：hover/聚焦显示 harness 名称 */}
                        {/* P17：行内按钮 draggable={false}——WebKit 下 button 会吞掉
                            父级 draggable 的拖拽启动（拖拽分屏无反应的根因） */}
                        <button
                          className="history-open"
                          draggable={false}
                          onClick={() => openFromHistory(h)}
                          title={hAdapter ? hAdapter.name : h.session_id}
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
          <div className="layout-host" data-dragging={false}>
            <Layout
              model={getModel()}
              factory={factory}
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

      <NewSessionModal
        open={newSession.open}
        adapters={adapters}
        workspaces={workspaces}
        presetWorkspaceId={newSession.workspaceId}
        onClose={() => setNewSession({ open: false })}
        onConfirm={confirmNewSession}
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
