// 元数据侧栏（P8 · F-8-4）：右侧可折叠第二侧栏，展示当前会话元数据。
//
// 数据来源：
//   - 上下文占用 / token / 成本 → usage_update（store.runtime[t].usage）
//   - apiType / baseUrl → providers/list（store.runtime[t].meta）
//   - sessionId / cwd / 模型（--model）→ 会话与 adapter 配置（DEC-13）
//
// 默认折叠，展开状态持久化到 localStorage（AC-P8-21）。

import { useEffect, useState } from "react";
import { useSessionStore } from "@/store/sessionStore";
import { usagePercent } from "@/acp/metadata";
import { extractModel } from "@/acp/metadata";
import { ChevronRightIcon, CloseIcon } from "@/components/ui/icons";
import type { AdapterWithStatus } from "@/ipc/adapters";

interface Props {
  tabKey: string;
  adapter: AdapterWithStatus;
  sessionId: string | null;
  cwd?: string;
  /** F-11-7：作为 RightRail tab 内容嵌入（隐藏自身头部与折叠钮，由 Rail 统一管理） */
  embedded?: boolean;
}

const STORAGE_KEY = "ainone-metadata-open";

export function MetadataPanel({ tabKey, adapter, sessionId, cwd, embedded = false }: Props) {
  const usage = useSessionStore((s) => s.runtime[tabKey]?.usage ?? null);
  const meta = useSessionStore((s) => s.runtime[tabKey]?.meta ?? null);

  const [open, setOpen] = useState<boolean>(() => localStorage.getItem(STORAGE_KEY) === "1");
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  const pct = usage ? usagePercent(usage) : null;
  const model = extractModel(adapter.args);

  // F-11-7：嵌入 RightRail → 直接渲染内容（Rail 负责开合，不再有自己的折叠态）
  if (embedded) {
    return (
      <div className="meta-embedded">
        <dl className="meta-list">
          <MetaItems usage={usage} meta={meta} pct={pct} model={model} sessionId={sessionId} cwd={cwd} adapterName={adapter.name} />
        </dl>
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
        <MetaItems usage={usage} meta={meta} pct={pct} model={model} sessionId={sessionId} cwd={cwd} adapterName={adapter.name} />
      </dl>
    </aside>
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
}: {
  usage: { used: number; size: number; cost: number | null } | null;
  meta: { apiType?: string; baseUrl?: string } | null;
  pct: number | null;
  model: string | null;
  sessionId: string | null;
  cwd?: string;
  adapterName: string;
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

        <div className="meta-item">
          <dt>session ID</dt>
          <dd className="meta-mono" title={sessionId ?? ""}>{sessionId ?? "（新建会话，发送后生成）"}</dd>
        </div>

        <div className="meta-item">
          <dt>工作区 cwd</dt>
          <dd className="meta-mono" title={cwd ?? ""}>{cwd ?? "—"}</dd>
        </div>

        <div className="meta-item">
          <dt>harness / apiType</dt>
          <dd>
            <span className="meta-mono">{adapterName}</span>
            {meta?.apiType && <span className="meta-tag">{meta.apiType}</span>}
          </dd>
        </div>

        <div className="meta-item">
          <dt>baseUrl</dt>
          <dd className="meta-mono" title={meta?.baseUrl ?? ""}>{meta?.baseUrl ?? "—"}</dd>
        </div>

        <div className="meta-item">
          <dt>模型</dt>
          <dd className="meta-mono">{model ?? "（未配置 --model）"}</dd>
        </div>
    </>
  );
}
