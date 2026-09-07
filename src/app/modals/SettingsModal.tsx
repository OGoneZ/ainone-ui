// 设置页（P29 重排版）：每 harness 一张状态卡片（四态徽标 + 一键安装 + 配置模型 +
// 测试连接），CLI 未装 / 只差 ACP 桥 / 未认证三种缺失视觉区分、各有对应一键动作。
// 快问/语音服务折叠进「更多服务」；预置卡片不暴露 id/program/args 高级字段（防误改），
// 自定义 harness 保留完整编辑。主题保留顶部。
// 验收目标（plan-p29-onboarding.md 任务四 4.1-4.7）。

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Adapter, AdapterState, BridgeInfo, CliInstallInfo, AuthInfo } from "@/ipc/adapters";
import { installBridge, installCli, refreshAdapterStatus, harnessConfigRead, harnessConfigSave, permissionModeRead, permissionModeSave } from "@/ipc/adapters";
import { probeAdapter } from "@/acp/probe";
import type { ProbeResult } from "@/acp/probe-core";
import { quickAskConfigGet, quickAskConfigSave, type QuickAskConfigView } from "@/ipc/quickask";
import { asrConfigGet, asrConfigSave, type AsrConfigView } from "@/ipc/asr";
import { ModelSwitchPanel } from "@/sidebar/ModelSwitchPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

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
  /** P29 四态：null = 探测中 */
  state: AdapterState | null;
  /** 懒装桥元信息（非桥程序为 null） */
  bridge: BridgeInfo | null;
  /** P29：CLI 一键安装元信息（CLI 已在或非登记程序为 null） */
  cli: CliInstallInfo | null;
  /** P29：认证态 */
  auth: AuthInfo | null;
  /** 程序解析到的绝对路径（找到时展示「找到于 …」） */
  resolvedPath?: string | null;
  /** 握手探测结果（点击「测试连接」后写入） */
  probe: ProbeResult | null;
  probing: boolean;
  /** P28：installable 行的安装态 */
  installing?: boolean;
  installTail?: string;
  /** P29：CLI 安装中（区别于装桥） */
  installingCli?: boolean;
  /** P30 权限模式开关（仅 claude-code）：null = 读取中；true = bypassPermissions（免确认放行全部工具）；false = auto（分类器判权限） */
  permBypass?: boolean | null;
  permMsg?: string | null;
  permErr?: string | null;
  /** P29：配置模型表单展开态 */
  cfgOpen?: boolean;
  cfgEndpoint?: string;
  cfgKey?: string;
  cfgModel?: string;
  /** 配置表单状态：reading / saving / 已写入路径 / 错误 */
  cfgBusy?: boolean;
  cfgMsg?: string | null;
  cfgErr?: string | null;
  /** 配置文件是否已存在（读取后写入；决定「新建」/「更新」文案） */
  cfgPresent?: boolean;
  cfgHasKey?: boolean;
}

/** P29：预置 harness 判定（预置卡片走简化布局 + 配置模型；自定义行才暴露高级字段） */
const PRESET_IDS = new Set(["omp", "pi", "claude-code", "codex", "opencode"]);

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
    cli: null,
    auth: null,
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

/** P29：四态 × 认证态 → 状态行文案与颜色 class（卡片状态徽标的唯一渲染点） */
function statusLine(a: EditableAdapter): { text: string; cls: string } {
  if (a.state === null) return { text: "探测中…", cls: "" };
  switch (a.state) {
    case "ready": {
      const auth = a.auth && a.auth.state !== "none" ? ` · ${a.auth.detail}` : "";
      return {
        text: a.resolvedPath ? `✓ 可用（${a.resolvedPath}）${auth}` : `✓ 可用${auth}`,
        cls: "ok",
      };
    }
    case "installable":
      return { text: "未装 ACP 桥接器（一键安装自动补齐）", cls: "warn" };
    case "cli_installable":
      return { text: `未安装 · 一键安装（CLI + 桥接器）`, cls: "bad" };
    case "absent": {
      // absent 按成因分叉：桥程序缺 CLI / 缺运行时 / 无候选的 CLI 登记 / 未知程序
      if (a.bridge) {
        return a.bridge.cliAvailable
          ? { text: `✗ 缺 bun/npm，无法自动安装桥接器（本体 ${a.bridge.cliProgram} 已装）`, cls: "bad" }
          : { text: `✗ 未找到本体 CLI ${a.bridge.cliProgram}——请先安装 ${a.name}`, cls: "bad" };
      }
      if (a.cli) {
        return a.cli.installable
          ? { text: "✗ 未安装（具备安装条件但未触发）", cls: "bad" }
          : { text: `✗ 缺 bun/npm，无法自动安装 ${a.cli.display}`, cls: "bad" };
      }
      return { text: "✗ 未找到程序", cls: "bad" };
    }
  }
}

export function SettingsModal({ open, onClose, onSaved, theme, onThemeChange }: Props) {
  const [items, setItems] = useState<EditableAdapter[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // P29：「更多服务」折叠区（快问 + 语音）展开态
  const [moreOpen, setMoreOpen] = useState(false);
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

  // 逐项探测可用性（adapter_status：四态 + 解析路径与来源 + CLI/认证元信息）
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
                  cli: status.cli,
                  auth: status.auth,
                }
              : x,
          ),
        );
      });
    });
  }, [items, open]);

  /** P29：一键安装（串联）——cli_installable 先装 CLI（成功保留）→ 刷新 → 自动接装桥；
   *  installable 直接装桥。任一步失败停留展示错误，不回滚已装部分。 */
  async function installAdapter(id: string) {
    const item = items.find((a) => a.id === id);
    if (!item || item.probing || item.installing || item.installingCli) return;
    const tail = (line: string) => {
      setItems((prev) =>
        prev.map((x) =>
          x.id === id ? { ...x, installTail: ((x.installTail ?? "") + "\n" + line).split("\n").slice(-3).join("\n") } : x,
        ),
      );
    };
    const refresh = async () => {
      const fresh = await refreshAdapterStatus(fromEditable(item));
      setItems((prev) =>
        prev.map((x) =>
          x.id === id
            ? { ...x, state: fresh.state, available: fresh.available, resolvedPath: fresh.resolvedPath, bridge: fresh.bridge, cli: fresh.cli, auth: fresh.auth }
            : x,
        ),
      );
      return fresh;
    };
    if (item.state === "cli_installable") {
      update(id, { installingCli: true, installing: false, installTail: "", probe: null });
      try {
        await installCli(item.program, tail);
        const fresh = await refresh();
        update(id, { installingCli: false });
        // CLI 装完 → 若是桥程序且桥未装，自动接装桥（两层解耦串联）
        if (fresh.state === "installable") {
          await installBridgeStep(id, item.program);
        }
      } catch (e) {
        update(id, {
          installingCli: false,
          probe: { ok: false, level: "spawn", message: `CLI 安装失败：${String(e instanceof Error ? e.message : e)}` },
        });
        return;
      }
    } else if (item.state === "installable") {
      update(id, { installing: true, installTail: "", probe: null });
      try {
        await installBridgeStep(id, item.program);
      } catch {
        // 错误已在 installBridgeStep 内写入 probe
        return;
      }
    }
    update(id, { installing: false, installingCli: false });
  }

  /** 装桥一步（错误写入 probe，调用方通过返回值/异常区分） */
  async function installBridgeStep(id: string, program: string): Promise<void> {
    update(id, { installing: true, installTail: "" });
    try {
      await installBridge(program, (line) => {
        setItems((prev) =>
          prev.map((x) =>
            x.id === id ? { ...x, installTail: ((x.installTail ?? "") + "\n" + line).split("\n").slice(-3).join("\n") } : x,
          ),
        );
      });
      const item = items.find((a) => a.id === id);
      if (item) {
        const fresh = await refreshAdapterStatus(fromEditable(item));
        setItems((prev) =>
          prev.map((x) =>
            x.id === id
              ? { ...x, installing: false, state: fresh.state, available: fresh.available, resolvedPath: fresh.resolvedPath, bridge: fresh.bridge }
              : x,
          ),
        );
      }
    } catch (e) {
      setItems((prev) =>
        prev.map((x) =>
          x.id === id
            ? { ...x, installing: false, probe: { ok: false, level: "spawn", message: `桥接器安装失败：${String(e instanceof Error ? e.message : e)}` } }
            : x,
        ),
      );
      throw e;
    }
  }

  /** 握手级探测：installable 先装桥再测（装完才能 spawn），真实 spawn + initialize + kill（两级错误） */
  async function testConnection(id: string) {
    const item = items.find((a) => a.id === id);
    if (!item || item.probing) return;
    update(id, { probing: true, probe: null });
    if (item.state === "installable") {
      try {
        await installBridgeStep(id, item.program);
      } catch {
        update(id, { probing: false });
        return;
      }
    }
    const current = items.find((a) => a.id === id);
    if (!current) return;
    const result = await probeAdapter(fromEditable(current));
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, probing: false, probe: result } : x)));
  }

  /** P29：配置模型表单展开（展开时读当前配置回显） */
  async function toggleConfig(id: string) {
    const item = items.find((a) => a.id === id);
    if (!item) return;
    if (item.cfgOpen) {
      update(id, { cfgOpen: false });
      return;
    }
    update(id, { cfgOpen: true, cfgBusy: true, cfgMsg: null, cfgErr: null, cfgEndpoint: "", cfgKey: "", cfgModel: "" });
    try {
      const view = await harnessConfigRead(item.id);
      update(id, {
        cfgBusy: false,
        cfgEndpoint: view.endpoint,
        cfgModel: view.model,
        cfgPresent: view.present,
        cfgHasKey: view.hasApiKey,
      });
    } catch (e) {
      update(id, { cfgBusy: false, cfgErr: String(e instanceof Error ? e.message : e) });
    }
  }

  /** P30 权限模式开关：打开设置时读回显（仅 claude-code 预置卡片渲染开关） */
  useEffect(() => {
    if (!open) return;
    items.forEach((a) => {
      if (a.id !== "claude-code" || a.permBypass !== undefined) return;
      update(a.id, { permBypass: null });
      permissionModeRead(a.id)
        .then((mode) => update(a.id, { permBypass: mode !== "auto" }))
        // 读取失败（文件异常等）→ null，开关禁用展示「—」
        .catch(() => update(a.id, { permBypass: null }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items.length]);

  /** P30 切换权限模式：开 = bypassPermissions / 关 = auto（单键合并写 settings.json） */
  async function togglePermBypass(id: string, next: boolean) {
    const item = items.find((a) => a.id === id);
    if (!item) return;
    update(id, { permBypass: next, permMsg: null, permErr: null });
    try {
      const written = await permissionModeSave(id, next ? "bypassPermissions" : "auto");
      update(id, { permMsg: `已写入 ${written}` });
    } catch (e) {
      // 写失败 → 回滚开关视觉态
      update(id, { permBypass: !next, permErr: String(e instanceof Error ? e.message : e) });
    }
  }

  /** P29：保存配置（合并写 harness 原生配置文件；key 留空 = 保留既有） */
  async function saveConfig(id: string) {
    const item = items.find((a) => a.id === id);
    if (!item || item.cfgBusy) return;
    if (!item.cfgEndpoint?.trim() || !item.cfgModel?.trim()) {
      update(id, { cfgErr: "endpoint 与模型名不能为空" });
      return;
    }
    update(id, { cfgBusy: true, cfgMsg: null, cfgErr: null });
    try {
      const written = await harnessConfigSave({
        program: item.id,
        endpoint: item.cfgEndpoint ?? "",
        apiKey: item.cfgKey ?? "",
        model: item.cfgModel ?? "",
      });
      update(id, { cfgBusy: false, cfgMsg: `已写入 ${written}`, cfgKey: "", cfgPresent: true, cfgHasKey: item.cfgKey ? true : item.cfgHasKey });
    } catch (e) {
      update(id, { cfgBusy: false, cfgErr: String(e instanceof Error ? e.message : e) });
    }
  }

  function update(id: string, patch: Partial<EditableAdapter>) {
    setItems((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  /** P29 S6：模型切换面板（ModelSwitchPanel 复用）——设置页无活跃会话上下文，
   *  只做「探测网关模型列表 → 点选 → 持久写回配置文件」，会话级同步传 null。 */
  const [modelPanel, setModelPanel] = useState<{ adapterId: string; adapterName: string; baseUrl: string } | null>(null);

  function openModelPanel(id: string) {
    const item = items.find((a) => a.id === id);
    if (!item?.cfgEndpoint) return;
    setModelPanel({ adapterId: item.id, adapterName: item.name, baseUrl: item.cfgEndpoint });
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
        cli: null,
        auth: null,
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

  /** P29：单张 harness 卡片（预置与自定义共用的骨架，字段按 PRESET 差异渲染） */
  function adapterCard(a: EditableAdapter) {
    const preset = PRESET_IDS.has(a.id) || a.id === a.name.toLowerCase();
    const st = statusLine(a);
    const busy = a.installing || a.installingCli || a.probing;
    const installableNow = a.state === "installable" || a.state === "cli_installable";
    return (
      <div key={a.id} className="adapter-row" data-testid={`adapter-card-${a.id}`}>
        <div className="adapter-card-head">
          <span className="adapter-card-name">
            <span className="adapter-logo-dot" style={a.logo ? { background: a.logo } : undefined} />
            {a.name}
          </span>
          <span className={`adapter-card-status ${st.cls}`} data-testid={`status-${a.id}`}>{st.text}</span>
          <span className="adapter-foot-actions">
            {installableNow && (
              <button
                onClick={() => installAdapter(a.id)}
                disabled={busy}
                data-testid={`install-${a.id}`}
              >
                {a.installingCli ? "安装 CLI 中…" : a.installing ? "安装桥接器中…" : a.state === "cli_installable" ? "一键安装" : "安装桥接器"}
              </button>
            )}
            {preset && (
              <button onClick={() => toggleConfig(a.id)} data-testid={`cfg-toggle-${a.id}`}>
                {a.cfgOpen ? "收起配置" : "配置模型"}
              </button>
            )}
            <button onClick={() => testConnection(a.id)} disabled={busy}>
              {a.probing ? "探测中…" : "测试连接"}
            </button>
            {!preset && <button onClick={() => removeRow(a.id)}>删除</button>}
          </span>
        </div>
        {(a.installing || a.installingCli) && a.installTail && (
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
        {a.id === "claude-code" && a.permBypass !== undefined && (
          <div className="adapter-perm" style={{ gridColumn: "1 / -1" }}>
            {/* P30 bypass permissions 开关：默认开（免确认，绕过 auto 分类器——
                分类器依赖的模型通道故障时会拦死所有 Bash）。只写 settings.json 的
                permissions.defaultMode 单键，其余键不动；关 = auto。 */}
            <label className="flex items-center justify-between gap-3 cursor-pointer select-none" style={{ margin: 0 }}>
              <span className="flex flex-col">
                <span className="font-medium">跳过权限确认（bypass permissions）</span>
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                  {a.permBypass
                    ? "开：全部工具直接放行，不再询问（写入 defaultMode=bypassPermissions）"
                    : "关：由 Claude 自动判定权限（defaultMode=auto）"}
                </span>
              </span>
              <Switch
                checked={a.permBypass === true}
                disabled={a.permBypass === null}
                onCheckedChange={(v) => togglePermBypass(a.id, v)}
                data-testid={`perm-switch-${a.id}`}
                aria-label="跳过权限确认"
              />
            </label>
            {a.permMsg && <p className="ok settings-hint" style={{ color: "var(--success)", margin: 0 }}>{a.permMsg}</p>}
            {a.permErr && <p className="bad settings-hint" style={{ color: "var(--danger)", margin: 0 }}>{a.permErr}</p>}
          </div>
        )}
        {a.cfgOpen && preset && (
          <div className="adapter-cfg" data-testid={`cfg-form-${a.id}`}>
            {/* P29 S6：模型选择走 ModelSwitchPanel 同款探测（可探到网关模型列表时优先） */}
            {a.cfgEndpoint && (
              <button
                className="adapter-cfg-probe"
                onClick={() => openModelPanel(a.id)}
                disabled={a.cfgBusy}
                data-testid={`cfg-probe-${a.id}`}
              >
                探测可用模型（来自 {a.cfgEndpoint}）…
              </button>
            )}
            <div className="settings-grid">
              <label className="ns-label">
                接口地址（endpoint）
                <input
                  placeholder="https://api.example.com/v1"
                  value={a.cfgEndpoint ?? ""}
                  onChange={(e) => update(a.id, { cfgEndpoint: e.target.value })}
                />
              </label>
              <label className="ns-label">
                模型名
                <input
                  placeholder="model-id"
                  value={a.cfgModel ?? ""}
                  onChange={(e) => update(a.id, { cfgModel: e.target.value })}
                />
              </label>
            </div>
            <label className="ns-label">
              API Key（留空 = 保留既有{a.cfgHasKey ? "，已配置 ✓" : ""}）
              <input
                type="password"
                placeholder={a.cfgHasKey ? "已配置（留空不改）" : "sk-…"}
                value={a.cfgKey ?? ""}
                onChange={(e) => update(a.id, { cfgKey: e.target.value })}
              />
            </label>
            {a.cfgPresent === false && (
              <p className="settings-hint">配置文件不存在——保存时将新建并填入最小配置。</p>
            )}
            {a.cfgMsg && <p className="ok" style={{ color: "var(--success)", margin: 0 }}>{a.cfgMsg}</p>}
            {a.cfgErr && <p className="bad" style={{ color: "var(--danger)", margin: 0 }}>{a.cfgErr}</p>}
            <div className="adapter-cfg-actions">
              <button onClick={() => saveConfig(a.id)} disabled={a.cfgBusy} data-testid={`cfg-save-${a.id}`}>
                {a.cfgBusy ? "处理中…" : "保存配置"}
              </button>
            </div>
          </div>
        )}
        {!preset && (
          <>
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
          </>
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="settings-modal">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>
        {loading && <p>加载中…</p>}
        {error && <p className="modal-error">{error}</p>}

        <div className="settings-body">
          {/* ============ 分区一：外观（P26 R3） ============ */}
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

          {/* ============ 分区二：harness（P29 卡片化） ============ */}
          <section className="settings-section">
            <h3 className="settings-section-title">harness</h3>
            <div className="adapter-list">
              {items.map(adapterCard)}
            </div>
          </section>

          {/* ============ 分区三：更多服务（P29 折叠：快问 + 语音） ============ */}
          <section className="settings-section">
            <button className="settings-more-toggle" onClick={() => setMoreOpen((v) => !v)} data-testid="more-toggle">
              {moreOpen ? "▾" : "▸"} 更多服务（快问模型 / 语音服务）
            </button>
            {moreOpen && (
              <>
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
              </>
            )}
          </section>
        </div>

        <div className="modal-actions">
          <button onClick={addRow}>新增 harness</button>
          <button onClick={save}>保存</button>
          <button onClick={onClose}>关闭</button>
        </div>

        {/* P29 S6：模型切换面板（复用元数据面板的 ModelSwitchPanel）——
            从卡片「配置模型 → 探测可用模型」进入；写回成功后同步表单回显 */}
        {modelPanel && (
          <ModelSwitchPanel
            open={true}
            onClose={() => setModelPanel(null)}
            adapterId={modelPanel.adapterId}
            adapterName={modelPanel.adapterName}
            baseUrl={modelPanel.baseUrl}
            currentModel={null}
            configOptions={null}
            onSessionModelChange={null}
            onWritten={() => {
              // 写回后重读配置回显（model 已变）
              const target = modelPanel.adapterId;
              harnessConfigRead(target)
                .then((v) => {
                  update(target, { cfgModel: v.model, cfgHasKey: v.hasApiKey || undefined });
                })
                .catch(() => {});
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
