// 右侧侧边栏（P11 · F-11-7，AionUi 风格）：元数据 / 文件 / 历史 三 tab 单容器。
//
// 开合 + 激活 tab 持久化 localStorage（key: ainone-rightrail）。
// 折叠态收为细栏杆（竖排 tab 名），点击展开；无会话时不渲染（由 App 控制）。
// 文件树「引用」/「预览」、历史「跳转/回溯」均通过 CustomEvent 交给 ChatPanel，
// 避免 Rail 与 ChatPanel 强耦合（flexlayout 分屏下两者是兄弟节点）。

import { useEffect, useMemo, useState } from "react";
import { MetadataPanel } from "./MetadataPanel";
import { FileTree } from "./FileTree";
import { HistoryPanel } from "./HistoryPanel";
import { collectModifiedPaths } from "@/lib/fileTree";
import type { ChatMsg } from "@/acp/message-log";
import type { AdapterWithStatus } from "@/ipc/adapters";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { clampWidth, sidebarMaxWidth } from "@/lib/sidebarResize";
import { logger } from "@/lib/logger";
import "@/sidebar/sidebar.css";

export type RailTab = "meta" | "files" | "history";

interface Props {
  tabKey: string;
  adapter: AdapterWithStatus;
  sessionId: string | null;
  cwd?: string;
  /** 当前会话消息（文件树「M」徽标数据源） */
  messages: ChatMsg[];
}

const STORAGE_KEY = "ainone-rightrail";

interface RailState {
  open: boolean;
  tab: RailTab;
}

function loadState(): RailState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      const tab: RailTab = o.tab === "files" ? "files" : o.tab === "history" ? "history" : "meta";
      return {
        open: Boolean(o.open),
        tab,
      };
    }
  } catch {
    /* ignore */
  }
  return { open: true, tab: "meta" };
}

export function RightRail({ tabKey, adapter, sessionId, cwd, messages }: Props) {
  const [state, setState] = useState<RailState>(loadState);
  // F-21-6 右栏宽度（拖宽把手，独立 key 持久化；clamp 220~min(520,40vw)）
  const [width, setWidth] = useState<number>(() =>
    clampWidth(Number(localStorage.getItem("ainone-rightrail-width")) || 260, 220, sidebarMaxWidth()),
  );
  function persistWidth(w: number) {
    localStorage.setItem("ainone-rightrail-width", String(w));
  }

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  // F-9-4 最近改动文件（文件树「M」徽标）
  const modifiedPaths = useMemo(() => collectModifiedPaths(messages), [messages]);

  function switchTab(tab: RailTab) {
    setState((s) => ({ ...s, tab, open: true }));
    logger.debug("layout", "rightrail-tab", { tab });
  }
  function toggle() {
    setState((s) => ({ ...s, open: !s.open }));
    logger.debug("layout", "rightrail-toggle", { open: !state.open });
  }

  if (!state.open) {
    return (
      <aside className="rightrail rightrail-collapsed">
        <button
          type="button"
          className="rail-tab-btn vertical"
          aria-label="展开元数据侧栏"
          onClick={() => switchTab("meta")}
        >
          元数据
        </button>
        <button
          type="button"
          className="rail-tab-btn vertical"
          aria-label="展开文件树"
          onClick={() => switchTab("files")}
        >
          文件
        </button>
        <button
          type="button"
          className="rail-tab-btn vertical"
          aria-label="展开历史消息"
          onClick={() => switchTab("history")}
        >
          历史
        </button>
      </aside>
    );
  }

  return (
    <aside className="rightrail" data-testid="right-rail" style={{ width }}>
      <SidebarResizeHandle
        edge="left"
        min={220}
        max={() => sidebarMaxWidth()}
        width={width}
        onResize={setWidth}
        onResizeEnd={persistWidth}
        label="拖拽调整侧栏宽度"
      />
      <div className="rail-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={state.tab === "meta"}
          className={state.tab === "meta" ? "rail-tab-btn active" : "rail-tab-btn"}
          onClick={() => switchTab("meta")}
        >
          元数据
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.tab === "files"}
          className={state.tab === "files" ? "rail-tab-btn active" : "rail-tab-btn"}
          onClick={() => switchTab("files")}
        >
          文件
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.tab === "history"}
          className={state.tab === "history" ? "rail-tab-btn active" : "rail-tab-btn"}
          onClick={() => switchTab("history")}
        >
          历史
        </button>
        <button
          type="button"
          className="rail-collapse"
          aria-label="折叠侧边栏"
          title="折叠"
          onClick={toggle}
        >
          »
        </button>
      </div>
      <div className={`rail-body ${state.tab === "files" ? "rail-body-noscroll" : ""}`} role="tabpanel">
        {state.tab === "meta" ? (
          <MetadataPanel
            tabKey={tabKey}
            adapter={adapter}
            sessionId={sessionId}
            cwd={cwd}
            embedded
          />
        ) : state.tab === "files" ? (
          <div className="rail-files">
            <FileTree
              cwd={cwd}
              modifiedPaths={modifiedPaths}
              onRefFile={(path) => {
                logger.info("fs", "ref-file", { path });
                window.dispatchEvent(new CustomEvent("ainone:ref-file", { detail: path }));
              }}
              onOpenFile={(path) => {
                // P16 F-16-1：单击文件 → 软件内预览（CustomEvent 与 ChatPanel 解耦，同 ref-file 模式）
                logger.info("preview", "open-file", { path });
                window.dispatchEvent(new CustomEvent("ainone:open-file", { detail: path }));
              }}
            />
          </div>
        ) : (
          // P16 F-16-2：历史消息锚点（DEC-49）
          <HistoryPanel messages={messages} />
        )}
      </div>
    </aside>
  );
}
