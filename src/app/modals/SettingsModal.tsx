// 设置页：适配器增删改查 + 快问模型（P8 F-8-7）。
// 验收目标（plan.md AC-P2-1/6）：新增一条自定义适配器 → 保存后新会话下拉可用，全程不改代码；
// 配置损坏时应用不崩溃并提示修复。

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Adapter } from "@/ipc/adapters";
import { refreshAdapterStatus } from "@/ipc/adapters";
import { probeAdapter } from "@/acp/probe";
import type { ProbeResult } from "@/acp/probe-core";
import { quickAskConfigGet, quickAskConfigSave, type QuickAskConfigView } from "@/ipc/quickask";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface EditableAdapter {
  id: string;
  name: string;
  program: string;
  argsText: string; // 每行一个参数
  cwd: string;
  logo: string; // 编辑态为空串；保存时转 null
  available: boolean | null; // null = 探测中
  /** 探测到的绝对路径（找到时展示「找到于 …」） */
  resolvedPath?: string | null;
  /** 握手探测结果（点击「测试连接」后写入） */
  probe: ProbeResult | null;
  probing: boolean;
}

function toEditable(a: Adapter): EditableAdapter {
  return { ...a, argsText: a.args.join("\n"), logo: a.logo ?? "", available: null, probe: null, probing: false };
}

function fromEditable(a: EditableAdapter): Adapter {
  return {
    id: a.id,
    name: a.name,
    program: a.program,
    args: a.argsText.split("\n").map((s) => s.trim()).filter(Boolean),
    cwd: a.cwd,
    logo: a.logo.trim() || null,
  };
}

export function SettingsModal({ open, onClose, onSaved }: Props) {
  const [items, setItems] = useState<EditableAdapter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // F-8-7 快问模型配置（P22：protocol/source 由 Rust 回传，视图展示来源徽标）
  const [qa, setQa] = useState<QuickAskConfigView>({
    base_url: "",
    model: "",
    timeout_ms: 30000,
    has_api_key: false,
    protocol: "openai",
    source: "",
  });
  const [qaKey, setQaKey] = useState("");
  const [qaMsg, setQaMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    setQaMsg(null);
    setQaKey("");
    invoke<Adapter[]>("adapters_list")
      .then((list) => setItems(list.map(toEditable)))
      .catch((e) => setError(`读取适配器失败：${String(e)}`))
      .finally(() => setLoading(false));
    quickAskConfigGet()
      .then(setQa)
      .catch(() => {});
  }, [open]);

  // 逐项探测可用性（adapter_status：含解析路径与来源）
  useEffect(() => {
    if (!open) return;
    items.forEach((a) => {
      if (a.available !== null) return;
      refreshAdapterStatus(fromEditable(a)).then((status) => {
        setItems((prev) =>
          prev.map((x) =>
            x.id === a.id
              ? { ...x, available: status.available, resolvedPath: status.resolvedPath }
              : x,
          ),
        );
      });
    });
  }, [items, open]);

  /** 握手级探测：真实 spawn + initialize + kill（两级错误） */
  async function testConnection(id: string) {
    const item = items.find((a) => a.id === id);
    if (!item || item.probing) return;
    update(id, { probing: true, probe: null });
    const result = await probeAdapter(fromEditable(item));
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, probing: false, probe: result } : x)));
  }

  function update(id: string, patch: Partial<EditableAdapter>) {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  function addRow() {
    const id = `custom-${Date.now()}`;
    setItems((prev) => [
      ...prev,
      {
        id,
        name: "自定义 harness",
        program: "",
        argsText: "",
        cwd: ".",
        logo: "",
        available: null,
        probe: null,
        probing: false,
      },
    ]);
  }

  function removeRow(id: string) {
    setItems((prev) => prev.filter((a) => a.id !== id));
  }

  async function save() {
    setError(null);
    // 客户端校验：id/program 非空
    for (const a of items) {
      if (!a.id.trim() || !a.program.trim()) {
        setError("每条适配器都必须有 id 与 program");
        return;
      }
    }
    const adapters = items.map(fromEditable);
    try {
      await invoke("adapters_save", { adapters });
      // F-8-7：快问模型配置一并保存（apiKey 留空 = 保留既有密钥）
      setQaMsg(null);
      await quickAskConfigSave({
        base_url: qa.base_url,
        model: qa.model,
        timeout_ms: qa.timeout_ms,
        api_key: qaKey,
      });
      setQaKey("");
      setQaMsg("快问模型已保存");
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>harness 设置</DialogTitle>
        </DialogHeader>
        {loading && <p>加载中…</p>}
        {error && <p className="modal-error">{error}</p>}
        <div className="adapter-list">
          {items.map((a) => (
            <div key={a.id} className="adapter-row">
              <input
                placeholder="id"
                value={a.id}
                onChange={(e) => update(a.id, { id: e.target.value })}
              />
              <input
                placeholder="名称"
                value={a.name}
                onChange={(e) => update(a.id, { name: e.target.value })}
              />
              <input
                placeholder="program"
                value={a.program}
                onChange={(e) => update(a.id, { program: e.target.value, available: null })}
              />
              <input
                placeholder="cwd"
                value={a.cwd}
                onChange={(e) => update(a.id, { cwd: e.target.value })}
              />
              <input
                placeholder="logo 色 (#rrggbb)"
                value={a.logo}
                onChange={(e) => update(a.id, { logo: e.target.value })}
              />
              <textarea
                placeholder={'启动参数（每行一个）\n例如：\nacp\n--model\nopus'}
                value={a.argsText}
                rows={3}
                onChange={(e) => update(a.id, { argsText: e.target.value })}
              />
              <span className={a.available === null ? "" : a.available ? "ok" : "bad"}>
                {a.available === null
                  ? "探测中…"
                  : a.available
                    ? a.resolvedPath
                      ? `✓ 可用（${a.resolvedPath}）`
                      : "✓ 可用"
                    : a.id === "claude-code"
                      ? "未找到（首次使用时自动安装连接器）"
                      : "✗ 未找到"}
              </span>
              <button onClick={() => testConnection(a.id)} disabled={a.probing}>
                {a.probing ? "探测中…" : "测试连接"}
              </button>
              <button onClick={() => removeRow(a.id)}>删除</button>
              {a.probe && (
                <p className={a.probe.ok ? "ok" : "bad"} style={{ gridColumn: "1 / -1", margin: 0 }}>
                  {a.probe.ok
                    ? `✓ 握手成功${a.probe.agentInfo.name ? `（${a.probe.agentInfo.name}${a.probe.agentInfo.version ? ` v${a.probe.agentInfo.version}` : ""}）` : ""}`
                    : a.probe.level === "spawn"
                      ? `✗ 程序启动失败：${a.probe.message}`
                      : `✗ 握手失败：${a.probe.message}`}
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button onClick={addRow}>新增 harness</button>
          <button onClick={save}>保存</button>
          <button onClick={onClose}>关闭</button>
        </div>

        {/* F-8-7 快问模型配置（独立轻量模型，仅快问用，密钥不落 WebView） */}
        <div className="quickask-config">
          <h3>快问模型（选中文本「快速解释」用）</h3>
          <label className="ns-label">
            接口地址（OpenAI 兼容 base_url）
            <input
              placeholder="https://api.openai.com/v1"
              value={qa.base_url}
              onChange={(e) => setQa((q) => ({ ...q, base_url: e.target.value }))}
            />
          </label>
          <label className="ns-label">
            模型名
            <input
              placeholder="gpt-4o-mini"
              value={qa.model}
              onChange={(e) => setQa((q) => ({ ...q, model: e.target.value }))}
            />
          </label>
          <label className="ns-label">
            API Key（留空 = 保留既有密钥{qa.has_api_key ? "，已配置 ✓" : ""}）
            <input
              type="password"
              placeholder={qa.has_api_key ? "已配置（留空不改）" : "sk-…"}
              value={qaKey}
              onChange={(e) => setQaKey(e.target.value)}
            />
          </label>
          {qaMsg && <p className="ok" style={{ color: "var(--success)" }}>{qaMsg}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
