// ainone-ui 主界面：多 Tab 并行会话编排。
// 每个 Tab = 一个 adapter + 一个独立会话（独立子进程），Tab 关闭时清理子进程。
// 左侧会话历史侧栏 + 右侧当前 Tab 聊天面板。

import { useEffect, useRef, useState } from "react";
import { listAdapters, type AdapterWithStatus } from "./config/adapters";
import { sessionsList, sessionsUpsert, sessionsRemove, type SessionEntry } from "./config/sessions";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsModal } from "./components/SettingsModal";
import { resolveHistoryOpen, type Tab } from "./store/tabs";
import "./App.css";

// Tab 类型定义抽到 store/tabs.ts（F-4-4 可单测）

function App() {
  const [adapters, setAdapters] = useState<AdapterWithStatus[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<string>("");
  const [history, setHistory] = useState<SessionEntry[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  useEffect(() => {
    reloadAdapters();
    reloadHistory();
  }, []);

  const activeTab = tabs.find((t) => t.key === activeKey);
  const activeAdapter = activeTab ? adapters.find((a) => a.id === activeTab.adapterId) : undefined;

  function newTab(adapterId: string) {
    const key = `tab-${nextKey.current++}`;
    setTabs((ts) => [...ts, { key, adapterId, title: "新会话" }]);
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

  // 首条消息 → 写会话索引
  function handleFirstPrompt(sessionId: string, adapterId: string, text: string, workspaceId?: string | null) {
    sessionsUpsert({
      session_id: sessionId,
      adapter_id: adapterId,
      title: text.slice(0, 40) || "未命名会话",
      cwd: "",
      workspace_id: workspaceId ?? null,
      mtime_ms: Date.now(),
    }).then(reloadHistory);
  }

  function deleteHistory(id: string) {
    sessionsRemove(id).then(reloadHistory);
  }

  return (
    <main className="container">
      <h1>ainone-ui · Agent in One</h1>

      <div className="toolbar">
        <label>
          harness：
          <select value="" onChange={(e) => e.target.value && newTab(e.target.value)}>
            <option value="">＋ 新建会话（选 harness）</option>
            {adapters.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.available ? "" : "（未安装）"}
              </option>
            ))}
          </select>
        </label>
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
          <h3>会话历史</h3>
          {history.map((h) => (
            <div key={h.session_id} className="history-item">
              <button className="history-open" onClick={() => openFromHistory(h)} title={h.session_id}>
                {h.title}
              </button>
              <button className="history-del" onClick={() => deleteHistory(h.session_id)}>
                ×
              </button>
            </div>
          ))}
          {history.length === 0 && <div className="hint">暂无历史会话</div>}
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
                onFirstPrompt={(text, sid) => handleFirstPrompt(sid, activeTab!.adapterId, text)}
              />
            ) : (
              <div className="hint empty">选择左上角 harness 新建会话，或从左侧历史恢复</div>
            )}
          </div>
        </section>
      </div>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={reloadAdapters}
      />
    </main>
  );
}

export default App;
