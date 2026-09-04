// 右侧侧边栏（P11 · F-11-7，AionUi 风格）：元数据 / 文件 双 tab 单容器。
//
// 开合 + 激活 tab 持久化 localStorage（key: ainone-rightrail）。
// 折叠态收为细栏杆（竖排 tab 名），点击展开；无会话时不渲染（由 App 控制）。
// 文件树「引用」通过 CustomEvent("ainone:ref-file") 交给 ChatPanel 注入附件，
// 避免 Rail 与 ChatPanel 强耦合（flexlayout 分屏下两者是兄弟节点）。

import { useEffect, useMemo, useState } from "react";
import { MetadataPanel } from "./MetadataPanel";
import { FileTree } from "./FileTree";
import { collectModifiedPaths } from "@/lib/fileTree";
import type { ChatMsg } from "@/acp/message-log";
import type { AdapterWithStatus } from "@/ipc/adapters";
import { logger } from "@/lib/logger";

export type RailTab = "meta" | "files";

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
      return {
        open: Boolean(o.open),
        tab: o.tab === "files" ? "files" : "meta",
      };
    }
  } catch {
    /* ignore */
  }
  return { open: true, tab: "meta" };
}

export function RightRail({ tabKey, adapter, sessionId, cwd, messages }: Props) {
  const [state, setState] = useState<RailState>(loadState);

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
      </aside>
    );
  }

  return (
    <aside className="rightrail" data-testid="right-rail">
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
          className="rail-collapse"
          aria-label="折叠侧边栏"
          title="折叠"
          onClick={toggle}
        >
          »
        </button>
      </div>
      <div className="rail-body" role="tabpanel">
        {state.tab === "meta" ? (
          <MetadataPanel
            tabKey={tabKey}
            adapter={adapter}
            sessionId={sessionId}
            cwd={cwd}
            embedded
          />
        ) : (
          <div className="rail-files">
            <FileTree
              cwd={cwd}
              modifiedPaths={modifiedPaths}
              onRefFile={(path) => {
                logger.info("fs", "ref-file", { path });
                window.dispatchEvent(new CustomEvent("ainone:ref-file", { detail: path }));
              }}
            />
          </div>
        )}
      </div>
    </aside>
  );
}
