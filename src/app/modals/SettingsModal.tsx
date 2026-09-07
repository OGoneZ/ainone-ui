// 设置页（P22 重排版）：两个分区——「模型服务」（快问模型 + 语音服务）与
// 「harness 适配器」（卡片式行）。内容区限高滚动，底部操作栏固定。
// 验收目标（plan.md AC-P2-1/6）：新增一条自定义适配器 → 保存后新会话下拉可用，全程不改代码；
// 配置损坏时应用不崩溃并提示修复。

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Adapter, AdapterState, BridgeInfo } from "@/ipc/adapters";
import { installBridge, refreshAdapterStatus } from "@/ipc/adapters";
import { probeAdapter } from "@/acp/probe";
import type { ProbeResult } from "@/acp/probe-core";
import { quickAskConfigGet, quickAskConfigSave, type QuickAskConfigView } from "@/ipc/quickask";
import { asrConfigGet, asrConfigSave, type AsrConfigView } from "@/ipc/asr";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** P26 R3：主题（受控于 App 的 theme state，持久化/系统跟随 effect 留在 App） */
  theme: string;
  onThemeChange: (t: string) => void;
}

interface EditableAdapter {
  id: string;
  name: string;
  program: string;
  argsText: string; // 每行一个参数
  cwd: string;
  logo: string; // 编辑态为空串；保存时转 null
  available: boolean | null; // null = 探测中（= state ready 的兼容镜像）
  /** P28 三态：null = 探测中 */
  state: AdapterState | null;
  /** 懒装桥元信息（非桥程序为 null） */
  bridge: BridgeInfo | null;
  /** 程序解析到的绝对路径（找到时展示「找到于 …」） */
  resolvedPath?: string | null;
  /** 握手探测结果（点击「测试连接」后写入） */
  probe: ProbeResult | null;
  probing: boolean;
  /** P28：installable 行的安装态 */
  installing?: boolean;
  installTail?: string;
}

/** P24g：握手能力摘要（诊断用——用户可直观看到 harness 声明了哪些能力） */
function probeCapSummary(caps: import("@agentclientprotocol/sdk").AgentCapabilities | null): string {
  if (!caps) return "";
  const parts: string[] = [];
  if (caps.loadSession) parts.push("load");
  if (caps.sessionCapabilities?.fork != null) parts.push("fork");
  if (caps.sessionCapabilities?.resume != null) parts.push("resume");
  if (caps.sessionCapabilities?.list != null) parts.push("list");
  return parts.length > 0 ? ` · 能力: ${parts.join("/")}` : "";
}

function toEditable(a: Adapter): EditableAdapter {
  return {
    ...a,
    argsText: a.args.join("\n"),
    logo: a.logo ?? "",
    available: null,
    state: null,
    bridge: null,
    probe: null,
    probing: false,
  };
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

/** 快问来源徽标文案（P22） */
function sourceBadge(source: string): { text: string; auto: boolean } | null {
  if (source === "auto:claude-code") return { text: "自动：Claude Code", auto: true };
  if (source === "auto:codex") return { text: "自动：Codex", auto: true };
  return null; // manual / 空 = 自定义
}

export function SettingsModal({ open, onClose, onSaved, theme, onThemeChange }: Props) {
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
  // P22 语音服务配置
  const [asr, setAsr] = useState<AsrConfigView>({ base_url: "", model: "", has_api_key: false });
  const [asrKey, setAsrKey] = useState("");
  const [asrMsg, setAsrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoading(true);
    setQaMsg(null);
    setAsrMsg(null);
    setQaKey("");
    setAsrKey("");
    invoke<Adapter[]>("adapters_list")
      .then((list) => setItems(list.map(toEditable)))
      .catch((e) => setError(`读取适配器失败：${String(e)}`))
      .finally(() => setLoading(false));
    quickAskConfigGet()
      .then((v) => setQa(v ?? { base_url: "", model: "", timeout_ms: 30000, has_api_key: false, protocol: "openai", source: "" }))
      .catch(() => {});
    asrConfigGet()
      .then((v) => setAsr(v ?? { base_url: "", model: "", has_api_key: false }))
      .catch(() => {});
  }, [open]);

  // 逐项探测可用性（adapter_status：三态 + 解析路径与来源）
  useEffect(() => {
    if (!open) return;
    items.forEach((a) => {
      if (a.state !== null) return;
      refreshAdapterStatus(fromEditable(a)).then((status) => {
        setItems((prev) =>
          prev.map((x) =>
            x.id === a.id
              ? {
                  ...x,
                  available: status.available,
                  state: status.state,
                  resolvedPath: status.resolvedPath,
                  bridge: status.bridge,
                }
              : x,
          ),
        );
      });
    });
  }, [items, open]);

  /** 握手级探测：installable 先装桥再测（装完才能 spawn），真实 spawn + initialize + kill（两级错误） */
  async function testConnection(id: string) {
    const item = items.find((a) => a.id === id);
    if (!item || item.probing) return;
    update(id, { probing: true, probe: null });
    if (item.state === "installable") {
      update(id, { installing: true, installTail: "" });
      try {
        await installBridge(item.program, (line) => {
          setItems((prev) =>
            prev.map((x) =>
              x.id === id
                ? { ...x, installTail: ((x.installTail ?? "") + "\n" + line).split("\n").slice(-3).join("\n") }
                : x,
            ),
          );
        });
        // 装完刷新三态（转 ready），再继续握手
        const fresh = await refreshAdapterStatus(fromEditable(item));
        update(id, { installing: false, state: fresh.state, available: fresh.available, resolvedPath: fresh.resolvedPath });
      } catch (e) {
        update(id, { installing: false, probing: false, probe: { ok: false, level: "spawn", message: `桥接器安装失败：${String(e instanceof Error ? e.message : e)}` } });
        return;
      }
    }
    const current = items.find((a) => a.id === id);
    if (!current) return;
    const result = await probeAdapter(fromEditable(current));
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
        state: null,
        bridge: null,
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
      // F-8-7：快问模型配置一并保存（apiKey 留空 = 保留既有密钥；显式保存 → 手动来源）
      setQaMsg(null);
      await quickAskConfigSave({
        base_url: qa.base_url,
        model: qa.model,
        timeout_ms: qa.timeout_ms,
        api_key: qaKey,
      });
      setQaKey("");
      setQaMsg("快问模型已保存");
      // P22：语音服务配置一并保存
      await asrConfigSave({
        base_url: asr.base_url,
        model: asr.model,
        api_key: asrKey,
      });
      setAsrKey("");
      setAsrMsg("语音服务已保存");
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!open) return null;

  const badge = sourceBadge(qa.source);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="settings-modal">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>
        {loading && <p>加载中…</p>}
        {error && <p className="modal-error">{error}</p>}

        <div className="settings-body">
          {/* ============ 分区一：外观（P26 R3 自工具栏迁入） ============ */}
          <section className="settings-section">
            <h3 className="settings-section-title">外观</h3>
            <label className="settings-theme-row">
              主题
              <select value={theme} onChange={(e) => onThemeChange(e.target.value)}>
                <option value="auto">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
          </section>

          {/* ============ 分区二：模型服务 ============ */}
          <section className="settings-section">
            <h3 className="settings-section-title">模型服务</h3>

            <div className="settings-card">
              <div className="settings-card-head">
                <h4>快问模型</h4>
                {badge && <span className={`source-badge ${badge.auto ? "auto" : ""}`}>{badge.text}</span>}
                <span className="settings-card-desc">选中文本「快速解释」用的轻量模型</span>
              </div>
              {badge && (
                <p className="settings-hint">
                  已自动采用本机 {badge.text.replace("自动：", "")} 的配置，可修改覆盖（修改保存后不再自动更新）。
                </p>
              )}
              <div className="settings-grid">
                <label className="ns-label">
                  接口地址（{qa.protocol === "anthropic" ? "Anthropic base" : "OpenAI 兼容 base_url"}）
                  <input
                    placeholder={qa.protocol === "anthropic" ? "https://gw.example.com" : "https://api.openai.com/v1"}
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
              </div>
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

            <div className="settings-card">
              <div className="settings-card-head">
                <h4>语音服务</h4>
                <span className="settings-card-desc">语音输入转写用（OpenAI 兼容 audio/transcriptions）</span>
              </div>
              <div className="settings-grid">
                <label className="ns-label">
                  接口地址（留空用默认）
                  <input
                    placeholder="https://asr.zhubaoduo.com/v1/audio/transcriptions"
                    value={asr.base_url}
                    onChange={(e) => setAsr((q) => ({ ...q, base_url: e.target.value }))}
                  />
                </label>
                <label className="ns-label">
                  模型名（留空用默认）
                  <input
                    placeholder="mano-asr"
                    value={asr.model}
                    onChange={(e) => setAsr((q) => ({ ...q, model: e.target.value }))}
                  />
                </label>
              </div>
              <label className="ns-label">
                API Key（留空 = 保留既有密钥{asr.has_api_key ? "，已配置 ✓" : ""}）
                <input
                  type="password"
                  placeholder={asr.has_api_key ? "已配置（留空不改）" : "sk-…"}
                  value={asrKey}
                  onChange={(e) => setAsrKey(e.target.value)}
                />
              </label>
              {asrMsg && <p className="ok" style={{ color: "var(--success)" }}>{asrMsg}</p>}
            </div>
          </section>

          {/* ============ 分区二：harness 适配器 ============ */}
          <section className="settings-section">
            <h3 className="settings-section-title">harness 适配器</h3>
            <div className="adapter-list">
              {items.map((a) => (
                <div key={a.id} className="adapter-row">
                  <label className="ns-label">
                    id
                    <input
                      placeholder="id"
                      value={a.id}
                      onChange={(e) => update(a.id, { id: e.target.value })}
                    />
                  </label>
                  <label className="ns-label">
                    名称
                    <input
                      placeholder="名称"
                      value={a.name}
                      onChange={(e) => update(a.id, { name: e.target.value })}
                    />
                  </label>
                  <label className="ns-label">
                    启动程序
                    <input
                      placeholder="program"
                      value={a.program}
                      onChange={(e) => update(a.id, { program: e.target.value, available: null, state: null })}
                    />
                  </label>
                  <label className="ns-label">
                    工作目录
                    <input
                      placeholder="cwd"
                      value={a.cwd}
                      onChange={(e) => update(a.id, { cwd: e.target.value })}
                    />
                  </label>
                  <label className="ns-label">
                    logo 色（#rrggbb）
                    <input
                      placeholder="logo 色 (#rrggbb)"
                      value={a.logo}
                      onChange={(e) => update(a.id, { logo: e.target.value })}
                    />
                  </label>
                  <label className="ns-label adapter-args">
                    启动参数（每行一个）
                    <textarea
                      placeholder={'每行一个，例如：\nacp\n--model\nopus'}
                      value={a.argsText}
                      rows={3}
                      onChange={(e) => update(a.id, { argsText: e.target.value })}
                    />
                  </label>
                  <div className="adapter-foot">
                    <span className={a.state === null ? "" : a.available ? "ok" : "bad"}>
                      {a.state === null
                        ? "探测中…"
                        : a.state === "ready"
                          ? a.resolvedPath
                            ? `✓ 可用（${a.resolvedPath}）`
                            : "✓ 可用"
                          : a.state === "installable"
                            ? "未装 ACP 桥接器（首次使用/测试连接时自动安装）"
                            : a.bridge
                              ? a.bridge.cliAvailable
                                ? `✗ 缺 bun/npm，无法自动安装桥接器（本体 ${a.bridge.cliProgram} 已装）`
                                : `✗ 未找到本体 CLI ${a.bridge.cliProgram}——请先安装 ${a.name}`
                              : "✗ 未找到"}
                    </span>
                    <span className="adapter-foot-actions">
                      <button onClick={() => testConnection(a.id)} disabled={a.probing || a.installing}>
                        {a.installing ? "安装中…" : a.probing ? "探测中…" : "测试连接"}
                      </button>
                      <button onClick={() => removeRow(a.id)}>删除</button>
                    </span>
                  </div>
                  {a.installing && a.installTail && (
                    <pre
                      className="ok"
                      style={{ gridColumn: "1 / -1", margin: 0, whiteSpace: "pre-wrap", fontSize: "0.8em" }}
                    >
                      {a.installTail}
                    </pre>
                  )}
                  {a.probe && (
                    <p className={a.probe.ok ? "ok" : "bad"} style={{ gridColumn: "1 / -1", margin: 0 }}>
                      {a.probe.ok
                        ? `✓ 握手成功${a.probe.agentInfo.name ? `（${a.probe.agentInfo.name}${a.probe.agentInfo.version ? ` v${a.probe.agentInfo.version}` : ""}）` : ""}${probeCapSummary(a.probe.capabilities)}`
                        : a.probe.level === "spawn"
                          ? `✗ 程序启动失败：${a.probe.message}`
                          : `✗ 握手失败：${a.probe.message}`}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="modal-actions">
          <button onClick={addRow}>新增 harness</button>
          <button onClick={save}>保存</button>
          <button onClick={onClose}>关闭</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
