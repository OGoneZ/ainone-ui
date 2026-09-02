// ainone-ui 主界面：多 Tab 并行会话编排 + 左侧工作区分组侧栏（P5）。
// 每个 Tab = 一个 adapter + 一个独立会话（独立子进程），Tab 关闭时清理子进程。
// 侧栏按工作区归集会话；工作区右键：新建会话 / 重命名 / 移除。

import { useEffect, useMemo, useRef, useState } from "react";
import { listAdapters, type AdapterWithStatus } from "./config/adapters";
import { sessionsList, sessionsUpsert, sessionsRemove, type SessionEntry } from "./config/sessions";
import { workspacesList, workspacesUpsert, workspacesRemove, type Workspace } from "./config/workspaces";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsModal } from "./components/SettingsModal";
import { NewSessionModal } from "./components/NewSessionModal";
import { EmptyState } from "./components/EmptyState";
import { AgentAvatar } from "./components/AgentAvatar";
import {
  WorkspaceIcon,
  WorkspaceOpenIcon,
  WorkingIcon,
  AwaitingIcon,
  DoneIcon,
  CloseIcon,
  PlusIcon,
  SettingsIcon,
} from "./components/ui/icons";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "./components/ui/context-menu";
import { resolveHistoryOpen, type Tab } from "./store/tabs";
import { groupSessions } from "./store/workspaceGroup";
import { useSessionStore } from "./store/sessionStore";
import { collectSignals, deriveStatus, type SessionStatus } from "./store/sessionStatus";
import "./App.css";

/** 侧栏会话行 leading 槽 22px 状态机（F-7-7 AC-P7-7-1/2） */
function StatusLeading({ st }: { st: SessionStatus }) {
  const base = "flex h-[22px] w-[22px] shrink-0 items-center justify-center";
  switch (st) {
    case "working":
      return (
        <span className={base} title="工作中">
          <WorkingIcon className="animate-spin" style={{ width: 14, height: 14, strokeWidth: 1.75, color: "var(--primary)" }} />
        </span>
      );
    case "awaiting_input":
      return (
        <span className={base} title="等待输入">
          <AwaitingIcon className="wiggle" style={{ width: 16, height: 16, strokeWidth: 1.75, color: "var(--warning)" }} />
        </span>
      );
    case "done":
    case "idle":
    default:
      return (
        <span className={base} title={st === "idle" ? "空闲" : "已完成"}>
          <DoneIcon style={{ width: 14, height: 14, strokeWidth: 1.75, color: st === "idle" ? "var(--text-disabled)" : "var(--text-secondary)" }} />
        </span>
      );
  }
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
  const nextKey = useRef(1);

  useEffect(() => {
    const root = document.documentElement;
    const isDark =
      theme === "dark" ||
      (theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.setAttribute("data-theme", isDark ? "dark" : "light");
    localStorage.setItem("ainone-theme", theme);
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

  const activeTab = tabs.find((t) => t.key === activeKey);
  const activeAdapter = activeTab ? adapters.find((a) => a.id === activeTab.adapterId) : undefined;

  function newTab(adapterId: string, workspaceId?: string | null, cwd?: string) {
    const key = `tab-${nextKey.current++}`;
    setTabs((ts) => [...ts, { key, adapterId, title: "新会话", workspaceId: workspaceId ?? null, cwd }]);
    setActiveKey(key);
  }

  function openFromHistory(entry: SessionEntry) {
    const r = resolveHistoryOpen(tabs, entry, `tab-${nextKey.current}`);
    if (r.newTab) {
      nextKey.current++;
      setTabs((ts) => [...ts, r.newTab!]);
    }
    setActiveKey(r.activateKey);
  }

  function closeTab(key: string) {
    setTabs((ts) => {
      const rest = ts.filter((t) => t.key !== key);
      if (activeKey === key && rest.length > 0) setActiveKey(rest[rest.length - 1].key);
      return rest;
    });
    // 子进程清理在 ChatPanel 卸载时由 session.dispose 兜底（见 ChatPanel 的 useEffect 清理）
  }

  // 首条消息 → 写会话索引（带上工作区归属与运行目录）
  function handleFirstPrompt(sessionId: string, adapterId: string, text: string, workspaceId?: string | null, cwd?: string) {
    sessionsUpsert({
      session_id: sessionId,
      adapter_id: adapterId,
      title: text.slice(0, 40) || "未命名会话",
      cwd: cwd ?? "",
      workspace_id: workspaceId ?? null,
      mtime_ms: Date.now(),
    }).then(reloadHistory);
  }

  function deleteHistory(id: string) {
    sessionsRemove(id).then(reloadHistory);
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

  // 会话状态（F-6-1）：非活跃 Tab 的 runtime 状态仍可读（zustand store）
  const runtime = useSessionStore((s) => s.runtime);
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
    <main className="container">
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
        <aside className="sidebar">
          <div className="sidebar-head">
            <h3>工作区</h3>
            <button className="add-ws" title="新建工作区" aria-label="新建工作区" onClick={() => setNewSession({ open: true })}>
              <PlusIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
            </button>
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
                    return (
                      <div
                        key={h.session_id}
                        className={`history-item status-${st} ${active ? "history-active" : ""}`}
                      >
                        <StatusLeading st={st} />
                        <button className="history-open" onClick={() => openFromHistory(h)} title={h.session_id}>
                          {h.title}
                        </button>
                        <button
                          className="history-del"
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

        <section className="tabs-area">
          <div className="tabs-bar">
            {tabs.map((t) => {
              const tAdapter = adapters.find((a) => a.id === t.adapterId);
              return (
                <button
                  key={t.key}
                  className={t.key === activeKey ? "tab active" : "tab"}
                  onClick={() => setActiveKey(t.key)}
                >
                  {tAdapter && <AgentAvatar adapterId={tAdapter.id} name={tAdapter.name} brandColor={tAdapter.logo} size={14} className="shrink-0" />}
                  {t.title}
                  <span className="tab-close" role="button" aria-label="关闭标签页" onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}>
                    <CloseIcon style={{ width: 12, height: 12, strokeWidth: 1.75 }} />
                  </span>
                </button>
              );
            })}
          </div>
          <div className="tab-content">
            {activeAdapter ? (
              <ChatPanel
                key={activeTab!.key}
                tabKey={activeTab!.key}
                adapter={activeAdapter}
                resumeSessionId={activeTab!.sessionId}
                cwd={activeTab!.cwd}
                onFirstPrompt={(text, sid) => handleFirstPrompt(sid, activeTab!.adapterId, text, activeTab!.workspaceId, activeTab!.cwd)}
              />
            ) : (
              <EmptyState
                title="开始新的对话"
                description="点击新建会话开始，或从左侧工作区恢复历史"
                actionLabel="新建会话"
                onAction={() => setNewSession({ open: true })}
              />
            )}
          </div>
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
    </main>
  );
}

export default App;
