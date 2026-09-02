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
import { resolveHistoryOpen, type Tab } from "./store/tabs";
import { groupSessions } from "./store/workspaceGroup";
import { useSessionStore } from "./store/sessionStore";
import { collectSignals, deriveStatus, type SessionStatus } from "./store/sessionStatus";
import "./App.css";

// 工作区右键菜单状态
interface ContextMenu {
  x: number;
  y: number;
  workspaceId: string | null; // null = 未归组（仅有新建会话）
}

function statusLabel(st: SessionStatus): string {
  switch (st) {
    case "working":
      return "工作中";
    case "awaiting_input":
      return "等待输入";
    case "done":
      return "已完成";
    case "idle":
      return "空闲";
  }
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
  const [ctxMenu, setCtxMenu] = useState<ContextMenu | null>(null);
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
    workspacesUpsert({ ...w, name: name.trim() }).then(reloadWorkspaces);
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

  return (
    <main className="container">
      <h1>ainone-ui · Agent in One</h1>

      <div className="toolbar">
        <button onClick={() => setNewSession({ open: true })}>＋ 新建会话</button>
        <button className="settings-btn" onClick={() => setSettingsOpen(true)}>
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
            <button className="add-ws" title="新建工作区" onClick={() => setNewSession({ open: true })}>
              ＋
            </button>
          </div>
          {groups.map((g) => (
            <div key={g.workspace?.id ?? "__ungrouped__"} className="ws-group">
              <div
                className="ws-head"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, workspaceId: g.workspace?.id ?? null });
                }}
              >
                <span className="ws-icon">{g.workspace ? "📁" : "📂"}</span>
                {renaming && renaming.id === (g.workspace?.id ?? "__ungrouped__") ? (
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
                  <span className="ws-name" title={g.workspace?.cwd}>
                    {g.workspace?.name ?? "未归组"}
                  </span>
                )}
                <span className="ws-count">{g.sessions.length}</span>
              </div>
              <div className="ws-sessions">
                {g.sessions.map((h) => {
                  const st = statusOf(h.session_id);
                  return (
                    <div key={h.session_id} className={`history-item status-${st}`}>
                      <span className={`status-dot dot-${st}`} title={statusLabel(st)} />
                      <button className="history-open" onClick={() => openFromHistory(h)} title={h.session_id}>
                        {h.title}
                      </button>
                      <button className="history-del" onClick={() => deleteHistory(h.session_id)}>
                        ×
                      </button>
                    </div>
                  );
                })}
                {g.sessions.length === 0 && <div className="hint ws-empty">（空）</div>}
              </div>
            </div>
          ))}
          {groups.length === 0 && <div className="hint">暂无工作区，点击 ＋ 新建会话并选择目录</div>}
        </aside>

        <section className="tabs-area">
          <div className="tabs-bar">
            {tabs.map((t) => (
              <button
                key={t.key}
                className={t.key === activeKey ? "tab active" : "tab"}
                onClick={() => setActiveKey(t.key)}
              >
                {t.title}
                <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.key); }}>
                  ×
                </span>
              </button>
            ))}
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
              <div className="hint empty">点击「＋ 新建会话」开始，或从左侧工作区恢复</div>
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
      />

      {ctxMenu && (
        <div className="ctx-backdrop" onClick={() => setCtxMenu(null)}>
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button onClick={() => { setCtxMenu(null); setNewSession({ open: true, workspaceId: ctxMenu.workspaceId }); }}>
              新建会话
            </button>
            {ctxMenu.workspaceId && (
              <>
                <button
                  onClick={() => {
                    const w = workspaces.find((x) => x.id === ctxMenu.workspaceId);
                    if (w && ctxMenu.workspaceId) setRenaming({ id: ctxMenu.workspaceId, name: w.name });
                    setCtxMenu(null);
                  }}
                >
                  重命名
                </button>
                <button
                  className="ctx-danger"
                  onClick={() => {
                    removeWorkspace(ctxMenu.workspaceId!);
                    setCtxMenu(null);
                  }}
                >
                  移除工作区
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

export default App;
