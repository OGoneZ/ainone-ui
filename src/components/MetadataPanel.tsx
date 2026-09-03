// 元数据侧栏（P8 · F-8-4）：右侧可折叠第二侧栏，展示当前会话元数据。
//
// 数据来源：
//   - 上下文占用 / token / 成本 → usage_update（store.runtime[t].usage）
//   - apiType / baseUrl → providers/list（store.runtime[t].meta）
//   - sessionId / cwd / 模型（--model）→ 会话与 adapter 配置（DEC-13）
//
// 默认折叠，展开状态持久化到 localStorage（AC-P8-21）。

import { useEffect, useState } from "react";
import { useSessionStore } from "../store/sessionStore";
import { usagePercent } from "../acp/metadata";
import { extractModel } from "../acp/metadata";
import { ChevronRightIcon, CloseIcon } from "./ui/icons";
import type { AdapterWithStatus } from "../config/adapters";

interface Props {
  tabKey: string;
  adapter: AdapterWithStatus;
  sessionId: string | null;
  cwd?: string;
}

const STORAGE_KEY = "ainone-metadata-open";

export function MetadataPanel({ tabKey, adapter, sessionId, cwd }: Props) {
  const usage = useSessionStore((s) => s.runtime[tabKey]?.usage ?? null);
  const meta = useSessionStore((s) => s.runtime[tabKey]?.meta ?? null);

  const [open, setOpen] = useState<boolean>(() => localStorage.getItem(STORAGE_KEY) === "1");
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  }, [open]);

  const pct = usage ? usagePercent(usage) : null;
  const model = extractModel(adapter.args);

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
            <span className="meta-mono">{adapter.name}</span>
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
      </dl>
    </aside>
  );
}
