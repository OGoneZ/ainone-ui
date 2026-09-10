// 右侧侧边栏（P11 · F-11-7，AionUi 风格）：元数据 / 文件 / 历史 三 tab 单容器。
//
// 开合 + 激活 tab 持久化 localStorage（key: ainone-rightrail，state 在 App）。
// 折叠态收为细栏杆（竖排 tab 名），点击展开；无会话时不渲染（由 App 控制）。
// 文件树「引用」/「预览」、历史「跳转/回溯」均通过 CustomEvent 交给 ChatPanel，
// 避免 Rail 与 ChatPanel 强耦合（flexlayout 分屏下两者是兄弟节点）。

import { useMemo, useState } from "react";
import { MetadataPanel } from "./MetadataPanel";
import { FileTree } from "./FileTree";
import { HistoryPanel } from "./HistoryPanel";
import { collectModifiedPaths } from "@/lib/fileTree";
import type { ChatMsg } from "@/acp/message-log";
import type { AdapterWithStatus } from "@/ipc/adapters";
import { useSessionStore } from "@/store/sessionStore";
import { SidebarResizeHandle } from "@/components/SidebarResizeHandle";
import { clampWidth, sidebarMaxWidth } from "@/lib/sidebarResize";
import { logger } from "@/lib/logger";
import "@/sidebar/sidebar.css";

/** messages 为空时的稳定引用（store 无 runtime 记录时避免每渲染新数组） */
const EMPTY_MESSAGES: ChatMsg[] = [];

export type RailTab = "meta" | "files" | "history";

interface Props {
  tabKey: string;
  /** P30：terminalOnly 时可为 undefined（终端不在 adapters 注册表） */
  adapter: AdapterWithStatus | undefined;
  sessionId: string | null;
  cwd?: string;
  /** P29 R5：活跃会话句柄（模型切换 set_config_option 用；无会话 = null） */
  session: { setConfigOption?: (configId: string, value: string) => Promise<unknown> } | null;
  /** P32d：session/list 句柄（null = 未声明 list 能力 → 会话列表入口隐藏） */
  listSessions?: (() => Promise<Array<{ sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }>>) | null;
  /** P32d：选中历史会话恢复（App 提供——开 Tab 走既有恢复链） */
  onResumeSession?: (sessionId: string) => void;
  /** P32 R2：messages 不再由 App 传递，组件内按 tabKey 细粒度订阅 store */
  /** P30：终端 tab 模式——无 harness 元数据/历史消息，只显示「文件」tab；
   *  折叠细栏杆也只剩文件入口，落点 tab 强制回 files */
  terminalOnly?: boolean;
  /** P25：开合与 tab 受控（state 提升到 App，Ctrl+K 才够得到；持久化仍在 App） */
  open: boolean;
  tab: RailTab;
  onSwitchTab: (tab: RailTab) => void;
  onToggle: () => void;
}

const STORAGE_KEY = "ainone-rightrail";

interface RailState {
  open: boolean;
  tab: RailTab;
}

/** P25：持久化读取移到 App（state 受控），此函数导出供 App 初始化复用（兼容旧 key） */
export function loadRailState(): RailState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      const t: RailTab = o.tab === "files" ? "files" : o.tab === "history" ? "history" : "meta";
      return {
        open: Boolean(o.open),
        tab: t,
      };
    }
  } catch {
    /* ignore */
  }
  return { open: true, tab: "meta" };
}

/** P25：App 侧持久化写入（key 不变） */
export function saveRailState(s: RailState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function RightRail({ open, ...rest }: Props) {
  // P43：折叠态在 hooks 之前分流——旧实现把 messages 订阅与 collectModifiedPaths
  // 放在 `if (!open) return` 之前，右栏折叠时仍每帧全量扫描会话块（hook 不可
  // 条件化，只能拆组件：CollapsedRail 零 hook，ExpandedRail 独享数据订阅）。
  if (!open) {
    return (
      <CollapsedRail
        terminalOnly={rest.terminalOnly ?? false}
        onSwitchTab={rest.onSwitchTab}
      />
    );
  }
  return <ExpandedRail {...rest} />;
}

/** 折叠细栏杆：竖排 tab 名，点击展开。零 hook、零 store 订阅（P43） */
function CollapsedRail({
  terminalOnly,
  onSwitchTab,
}: {
  terminalOnly: boolean;
  onSwitchTab: (t: RailTab) => void;
}) {
  function switchTab(t: RailTab) {
    onSwitchTab(t);
    logger.debug("layout", "rightrail-tab", { tab: t });
  }
  return (
    <aside className="rightrail rightrail-collapsed">
      {!terminalOnly && (
        <button
          type="button"
          className="rail-tab-btn vertical"
          aria-label="展开元数据侧栏"
          onClick={() => switchTab("meta")}
        >
          元数据
        </button>
      )}
      <button
        type="button"
        className="rail-tab-btn vertical"
        aria-label={terminalOnly ? "展开文件树" : "展开文件树"}
        onClick={() => switchTab("files")}
      >
        文件
      </button>
      {!terminalOnly && (
        <button
          type="button"
          className="rail-tab-btn vertical"
          aria-label="展开历史消息"
          onClick={() => switchTab("history")}
        >
          历史
        </button>
      )}
    </aside>
  );
}

/** 展开态：宽度拖拽 + 三 tab 内容。P43：messages 订阅只在此分支存在 */
function ExpandedRail({
  tabKey,
  adapter,
  sessionId,
  cwd,
  session,
  listSessions,
  onResumeSession,
  terminalOnly = false,
  tab,
  onSwitchTab,
  onToggle,
}: Omit<Props, "open">) {
  // F-21-6 右栏宽度（拖宽把手，独立 key 持久化；clamp 220~min(520,40vw)）
  const [width, setWidth] = useState<number>(() =>
    clampWidth(Number(localStorage.getItem("ainone-rightrail-width")) || 260, 220, sidebarMaxWidth()),
  );
  function persistWidth(w: number) {
    localStorage.setItem("ainone-rightrail-width", String(w));
  }

  // F-9-4 最近改动文件（文件树「M」徽标）+ P16 F-16-2 历史锚点数据源。
  // P32 R2：messages 改由本组件按 tabKey 细粒度订阅（原先 App 提升后整体
  // 传递——App 订阅整个 runtime，流式期间每帧重渲染连带 Rail 全树）。
  const messages = useSessionStore((s) => s.runtime[tabKey]?.messages) ?? EMPTY_MESSAGES;

  // F-9-4 最近改动文件（文件树「M」徽标）
  const modifiedPaths = useMemo(() => collectModifiedPaths(messages), [messages]);

  // P30：终端 tab 无元数据/历史——落点若是 meta/history 强制回 files
  // （持久化 tab 可能停在 meta，切到终端 tab 时避免白屏）
  const effectiveTab: RailTab = terminalOnly ? "files" : tab;

  function switchTab(t: RailTab) {
    onSwitchTab(t);
    logger.debug("layout", "rightrail-tab", { tab: t });
  }
  function toggle() {
    onToggle();
    logger.debug("layout", "rightrail-toggle", { open: false });
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
        {!terminalOnly && (
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "meta"}
            className={effectiveTab === "meta" ? "rail-tab-btn active" : "rail-tab-btn"}
            onClick={() => switchTab("meta")}
          >
            元数据
          </button>
        )}
        <button
          type="button"
          role="tab"
          aria-selected={effectiveTab === "files"}
          className={effectiveTab === "files" ? "rail-tab-btn active" : "rail-tab-btn"}
          onClick={() => switchTab("files")}
        >
          文件
        </button>
        {!terminalOnly && (
          <button
            type="button"
            role="tab"
            aria-selected={effectiveTab === "history"}
            className={effectiveTab === "history" ? "rail-tab-btn active" : "rail-tab-btn"}
            onClick={() => switchTab("history")}
          >
            历史
          </button>
        )}
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
      <div className={`rail-body ${effectiveTab === "files" ? "rail-body-noscroll" : ""}`} role="tabpanel">
        {effectiveTab === "meta" && adapter ? (
          <MetadataPanel
            tabKey={tabKey}
            adapter={adapter}
            sessionId={sessionId}
            cwd={cwd}
            embedded
            session={session}
            listSessions={listSessions}
            onResumeSession={onResumeSession}
          />
        ) : effectiveTab === "files" ? (
          <div className="rail-files">
            <FileTree
              cwd={cwd}
              modifiedPaths={modifiedPaths}
              onRefFile={(path) => {
                logger.info("fs", "ref-file", { path });
                // P36 R5：detail 带 tabKey——ChatPanel 按事件归属判定，分屏下
                // 点失焦窗格的文件树不再被活跃守卫丢弃
                window.dispatchEvent(new CustomEvent("ainone:ref-file", { detail: { path, tabKey } }));
              }}
              onOpenFile={(path) => {
                // P16 F-16-1：单击文件 → 软件内预览（CustomEvent 与 ChatPanel 解耦，同 ref-file 模式）
                logger.info("preview", "open-file", { path });
                window.dispatchEvent(new CustomEvent("ainone:open-file", { detail: { path, tabKey } }));
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
