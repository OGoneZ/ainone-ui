// 元数据侧栏（P8 · F-8-4）：右侧可折叠第二侧栏，展示当前会话元数据。
//
// 数据来源（P29 优先级链）：
//   - 上下文占用 / token / 成本 → usage_update（store.runtime[t].usage）
//   - apiType / baseUrl → providers/list（store.runtime[t].meta）→ harness_meta 静态配置兜底
//   - sessionId → store.runtime[t].sessionId（P29 改读 store：新建会话 bindSession 即有值，
//     不再依赖 App 透传 Tab.sessionId——那条链路只有恢复会话才填）
//   - 模型 → configOptions[model].currentValue（ACP 稳定通道）→ harness_meta 静态 → args --model
//   - cwd / git 分支 → 会话与 git_current_branch 采集
//
// F-15-6：session ID / 工作区 cwd / 分支 / baseUrl / 模型 点击复制，
// toast「已复制」反馈；非 git 仓库分支显示「—」不可复制。

import { useCallback, useEffect, useState } from "react";
import { useSessionStore } from "@/store/sessionStore";
import { usagePercent, extractModel, extractSessionModel, stripModelSuffix } from "@/acp/metadata";
import { fetchHarnessMeta, supportsWrite, type HarnessMeta } from "@/ipc/harnessMeta";
import { ChevronRightIcon, CloseIcon, CopyIcon, SwitchIcon } from "@/components/ui/icons";
import { toast } from "sonner";
import { logger } from "@/lib/logger";
import type { AdapterWithStatus } from "@/ipc/adapters";
import type { AcpSessionConfigOption } from "@/store/sessionStore";
import { ModelSwitchPanel } from "./ModelSwitchPanel";
import { UrlEditPanel } from "./UrlEditPanel";

interface Props {
  tabKey: string;
  adapter: AdapterWithStatus;
  sessionId: string | null;
  cwd?: string;
  /** F-11-7：作为 RightRail tab 内容嵌入（隐藏自身头部与折叠钮，由 Rail 统一管理） */
  embedded?: boolean;
  /** P29 R5：活跃会话句柄（set_config_option 即时切模型用；无会话 = null） */
  session: { setConfigOption?: (configId: string, value: string) => Promise<unknown> } | null;
}

const STORAGE_KEY = "ainone-metadata-open";

export function MetadataPanel({ tabKey, adapter, sessionId: sessionIdProp, cwd, embedded = false, session: liveSession = null }: Props) {
  const usage = useSessionStore((s) => s.runtime[tabKey]?.usage ?? null);
  const meta = useSessionStore((s) => s.runtime[tabKey]?.meta ?? null);
  const branch = useSessionStore((s) => s.runtime[tabKey]?.branch ?? null);
  // P29 R2：sessionId 改读 store——新建会话 bindSession 后立即有值
  const storeSessionId = useSessionStore((s) => s.runtime[tabKey]?.sessionId ?? null);
  const sessionId = storeSessionId ?? sessionIdProp;
  // P29 R3：会话级 configOptions（模型选择器 currentValue）
  const configOptions = useSessionStore((s) => s.runtime[tabKey]?.configOptions ?? null);
  // P29 R3/R4：静态配置兜底（harness_meta；文件缺失/不支持 → null）
  const [staticMeta, setStaticMeta] = useState<HarnessMeta | null>(null);
  useEffect(() => {
    let alive = true;
    fetchHarnessMeta(adapter.id)
      .then((m) => {
        if (alive) setStaticMeta(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [adapter.id]);

  const [open, setOpen] = useState<boolean>(() => localStorage.getItem(STORAGE_KEY) === "1");
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  const pct = usage ? usagePercent(usage) : null;
  // P29 模型优先级：configOptions[model] > 静态配置 model > args --model（全部去 [1m] 后缀）
  const model =
    extractSessionModel(configOptions) ??
    stripModelSuffix(staticMeta?.model ?? null) ??
    stripModelSuffix(extractModel(adapter.args));
  // P29 baseUrl 优先级：providers 会话值 > 静态配置（UI 标注来源）
  const baseUrl = meta?.baseUrl ?? staticMeta?.base_url ?? null;
  const baseUrlSource = meta?.baseUrl ? "session" : staticMeta?.base_url ? "config" : null;

  // P29 R5：模型/URL 切换面板开合
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [urlPanelOpen, setUrlPanelOpen] = useState(false);

  /** 写回后刷新静态元数据 + 通知外层 */
  const [writeTick, setWriteTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchHarnessMeta(adapter.id)
      .then((m) => {
        if (alive) setStaticMeta(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [adapter.id, writeTick]);
  /** 会话级切模型：session/set_config_option（configId=model；omp/pi 即时生效） */
  const sessionModelChange = useCallback(
    async (m: string) => {
      const opt = configOptions?.find((o) => o.category === "model" && o.type === "select");
      const fn = liveSession?.setConfigOption;
      if (!opt || !fn) return;
      const next = (await fn.call(liveSession, opt.id, m)) as AcpSessionConfigOption[] | null;
      if (next) useSessionStore.getState().setConfigOptions(tabKey, next);
    },
    [configOptions, tabKey, liveSession],
  );

  // F-11-7：嵌入 RightRail → 直接渲染内容（Rail 负责开合，不再有自己的折叠态）
  if (embedded) {
    return (
      <div className="meta-embedded">
        <dl className="meta-list">
          <MetaItems usage={usage} meta={meta} pct={pct} model={model} sessionId={sessionId} cwd={cwd} adapterName={adapter.name} branch={branch} baseUrl={baseUrl} baseUrlSource={baseUrlSource} onOpenModelPanel={() => setModelPanelOpen(true)} onOpenUrlPanel={supportsWrite(adapter.id) ? () => setUrlPanelOpen(true) : undefined} />
        </dl>
        <ModelSwitchPanel
          open={modelPanelOpen}
          onClose={() => setModelPanelOpen(false)}
          adapterId={adapter.id}
          adapterName={adapter.name}
          baseUrl={baseUrl}
          currentModel={model}
          configOptions={configOptions}
          onSessionModelChange={sessionModelChange}
          onWritten={() => setWriteTick((t) => t + 1)}
        />
        {supportsWrite(adapter.id) && (
          <UrlEditPanel
            open={urlPanelOpen}
            onClose={() => setUrlPanelOpen(false)}
            adapterId={adapter.id}
            adapterName={adapter.name}
            baseUrl={baseUrl}
            onWritten={() => setWriteTick((t) => t + 1)}
          />
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className="meta-railing"
        aria-label="展开元数据侧栏"
        title="元数据"
        onClick={() => setOpen(true)}
      >
        <ChevronRightIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
      </button>
    );
  }

  return (
    <aside className="meta-panel">
      <div className="meta-head">
        <span className="meta-title">会话元数据</span>
        <button
          type="button"
          className="meta-close"
          aria-label="折叠元数据侧栏"
          onClick={() => setOpen(false)}
        >
          <CloseIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
        </button>
      </div>

      <dl className="meta-list">
        <MetaItems usage={usage} meta={meta} pct={pct} model={model} sessionId={sessionId} cwd={cwd} adapterName={adapter.name} branch={branch} baseUrl={baseUrl} baseUrlSource={baseUrlSource} onOpenModelPanel={() => setModelPanelOpen(true)} onOpenUrlPanel={supportsWrite(adapter.id) ? () => setUrlPanelOpen(true) : undefined} />
      </dl>
      <ModelSwitchPanel
        open={modelPanelOpen}
        onClose={() => setModelPanelOpen(false)}
        adapterId={adapter.id}
        adapterName={adapter.name}
        baseUrl={baseUrl}
        currentModel={model}
        configOptions={configOptions}
        onSessionModelChange={sessionModelChange}
        onWritten={() => setWriteTick((t) => t + 1)}
      />
      {supportsWrite(adapter.id) && (
        <UrlEditPanel
          open={urlPanelOpen}
          onClose={() => setUrlPanelOpen(false)}
          adapterId={adapter.id}
          adapterName={adapter.name}
          baseUrl={baseUrl}
          onWritten={() => setWriteTick((t) => t + 1)}
        />
      )}
    </aside>
  );
}

/** F-15-6 可复制值渲染（纯展示；CopyableItem 的 dd 内容部分） */
function CopyableValue({ value, label }: { value: string | null | undefined; label: string }) {
  const display = value ?? "—";
  return (
    <span className="meta-mono">{display}</span>
  );
  void label;
}

/** F-15-6 可复制条目：点击复制值 + 已复制 toast */
function CopyableItem({ label, value }: { label: string; value: string | null | undefined }) {
  const display = value ?? "—";
  const copyable = Boolean(value);
  return (
    <div className="meta-item">
      <dt>{label}</dt>
      <dd>
        <button
          type="button"
          className={copyable ? "meta-copy-btn" : "meta-copy-btn meta-copy-disabled"}
          disabled={!copyable}
          title={copyable ? `点击复制${label}` : undefined}
          aria-label={`复制${label}`}
          onClick={() => {
            if (!value) return;
            navigator.clipboard?.writeText(value).then(
              () => {
                logger.debug("meta", "copy", { label });
                toast.success(`已复制${label}`);
              },
              () => toast.error("复制失败"),
            );
          }}
        >
          <span className="meta-mono">{display}</span>
          {copyable && <CopyIcon style={{ width: 12, height: 12, strokeWidth: 1.75, flexShrink: 0 }} />}
        </button>
      </dd>
    </div>
  );
}

/** 元数据条目（独立渲染单元：独立/嵌入两形态共用） */
function MetaItems({
  usage,
  meta,
  pct,
  model,
  sessionId,
  cwd,
  adapterName,
  branch,
  baseUrl,
  baseUrlSource,
  onOpenModelPanel,
  onOpenUrlPanel,
}: {
  usage: { used: number; size: number; cost: number | null } | null;
  meta: { apiType?: string; baseUrl?: string } | null;
  pct: number | null;
  model: string | null;
  sessionId: string | null;
  cwd?: string;
  adapterName: string;
  branch: string | null;
  baseUrl: string | null;
  /** P29 R4：baseUrl 来源（"session"=会话路由 / "config"=本机配置；AC-R4-3） */
  baseUrlSource: "session" | "config" | null;
  /** P29 R5：点击模型行打开切换面板 */
  onOpenModelPanel: () => void;
  /** P29 R6：点击 baseUrl 行打开编辑面板；undefined = 该 harness 不支持写回（只读） */
  onOpenUrlPanel?: () => void;
}) {
  return (
    <>
        <div className="meta-item">
          <dt>上下文占用</dt>
          <dd>
            {usage ? (
              <>
                <span className="meta-mono">
                  {usage.used.toLocaleString()} / {usage.size.toLocaleString()}
                </span>
                <div className="meta-bar">
                  <div className="meta-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <span className="meta-pct">{pct}%</span>
              </>
            ) : (
              <span className="meta-na">运行后采集</span>
            )}
          </dd>
        </div>

        <div className="meta-item">
          <dt>token 用量</dt>
          <dd>
            {usage ? (
              <span className="meta-mono">{usage.used.toLocaleString()}</span>
            ) : (
              <span className="meta-na">—</span>
            )}
            {usage && usage.cost != null && (
              <span className="meta-mono meta-cost">≈ ${usage.cost.toFixed(4)}</span>
            )}
          </dd>
        </div>

        <CopyableItem label="session ID" value={sessionId} />
        <CopyableItem label="工作区" value={cwd} />
        <CopyableItem label="分支" value={branch} />

        <div className="meta-item">
          <dt>harness / apiType</dt>
          <dd>
            <span className="meta-mono">{adapterName}</span>
            {meta?.apiType && <span className="meta-tag">{meta.apiType}</span>}
          </dd>
        </div>

        <div className="meta-item">
          <dt>baseUrl</dt>
          <dd>
            {onOpenUrlPanel ? (
              <button
                type="button"
                className={baseUrl ? "meta-copy-btn" : "meta-copy-btn meta-copy-disabled"}
                disabled={!baseUrl}
                title={baseUrl ? "点击编辑接口地址" : undefined}
                aria-label="编辑接口地址"
                onClick={() => baseUrl && onOpenUrlPanel()}
              >
                <span className="meta-mono">{baseUrl ?? "—"}</span>
                {baseUrl && <SwitchIcon style={{ width: 12, height: 12, strokeWidth: 1.75, flexShrink: 0 }} />}
              </button>
            ) : (
              <CopyableValue value={baseUrl} label="baseUrl" />
            )}
            {baseUrl && baseUrlSource && (
              <span className="meta-tag" title={baseUrlSource === "session" ? "来自会话路由（providers/list）" : "来自本机配置文件"}>
                {baseUrlSource === "session" ? "会话" : "配置"}
              </span>
            )}
          </dd>
        </div>
        <div className="meta-item">
          <dt>模型</dt>
          <dd>
            <button
              type="button"
              className={model ? "meta-copy-btn" : "meta-copy-btn meta-copy-disabled"}
              disabled={!model}
              title={model ? "点击切换模型" : undefined}
              aria-label="切换模型"
              onClick={() => model && onOpenModelPanel()}
            >
              <span className="meta-mono">{model ?? "—"}</span>
              {model && <SwitchIcon style={{ width: 12, height: 12, strokeWidth: 1.75, flexShrink: 0 }} />}
            </button>
          </dd>
        </div>
    </>
  );
}
