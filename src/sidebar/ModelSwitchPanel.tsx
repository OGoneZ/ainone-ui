// P29 R5 模型切换面板：探测网关 /v1/models → 列表选择 → 写回 harness 配置。
//
// 打开即探测（key 由 Rust 从本机配置自取，明文不过 WebView）；支持输入过滤；
// 点选模型 → ①configOptions 有 model 项时同步 session/set_config_option（omp/pi 会话即时生效）
// ②写回配置文件（claude-code/codex/omp：Rust 定点替换+写前备份；claude-code/codex 提示新会话生效）。
// 探测失败展示结构化原因 + 重试。

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { probeModels, writeHarnessSettings, supportsWrite } from "@/ipc/harnessMeta";
import { harnessConfigSave } from "@/ipc/adapters";
import { toast } from "sonner";
import { logger } from "@/lib/logger";
import type { AcpSessionConfigOption } from "@/store/sessionStore";

// ---------------------------------------------------------------------------
// P32e R6：模型切换结果提示模板——「持久落盘 × 会话生效」二维正交，
// 五家共用一套文案函数（禁止分支内硬编码）。persisted = 落盘结果档；
// sessionApplied = 会话生效档（undefined = 无活跃会话上下文，不提及会话）。
// ---------------------------------------------------------------------------

export type SwitchPersisted = "created" | "written" | "none";

export interface SwitchToast {
  kind: "success" | "warning" | "error";
  /** 主文案（入参：模型名） */
  message: (model: string) => string;
  /** 详情文案（入参：写回路径详情；adapterName 仅 error 档用） */
  detail: (writtenPath?: string, adapterName?: string) => string | undefined;
}

export function switchResultToast(persisted: SwitchPersisted, sessionApplied?: boolean): SwitchToast;
export function switchResultToast(input: { persisted: SwitchPersisted; sessionApplied?: boolean }): SwitchToast;
export function switchResultToast(
  persistedOrInput: SwitchPersisted | { persisted: SwitchPersisted; sessionApplied?: boolean },
  sessionAppliedArg?: boolean,
): SwitchToast {
  const { persisted, sessionApplied } =
    typeof persistedOrInput === "string"
      ? { persisted: persistedOrInput, sessionApplied: sessionAppliedArg }
      : persistedOrInput;
  switch (persisted) {
    case "created":
      // 配置代写新建：必然对新会话生效
      return {
        kind: "success",
        message: (m) => `已写入 ${m}（配置新建，对新会话生效）`,
        detail: (p) => (p ? `配置已写入 ${p}` : undefined),
      };
    case "written":
      // 定点写回成功 + 会话档正交
      if (sessionApplied === false) {
        // 会话级被连接器拒绝（如 claude-code 选择器外网关模型）：写入成功但不谎报已切换
        return {
          kind: "warning",
          message: (m) => `已写入 ${m}（对新会话生效）`,
          detail: (p) => `当前会话不支持该模型，未能即时切换。${p ?? ""}`,
        };
      }
      return {
        kind: "success",
        message: (m) => `已切换到 ${m}（${sessionApplied ? "本会话即时生效" : "对新会话生效"}）`,
        detail: (p) => p,
      };
    case "none":
      // 无持久写回
      if (sessionApplied) {
        return {
          kind: "success",
          message: (m) => `当前会话已切换到 ${m}（仅本会话生效）`,
          detail: () => undefined,
        };
      }
      return {
        kind: "error",
        message: () => "当前会话不支持该模型",
        detail: (_p, adapterName) => `${adapterName ?? "该 harness"} 无配置写回，无法持久化`,
      };
  }
}

/** 设置页配置表单上下文（存在时走表单探测+代写链路，区别于元数据面板的静态配置链路） */
export interface FormContext {
  /** 表单 endpoint（探测基准 + 代写落盘） */
  endpoint: string;
  /** 表单 API Key（明文仅 Rust 侧流转；空 = 用本机既有 key） */
  apiKey: string;
  /** 配置文件是否已存在（false = 点选写回走配置代写新建，而非定点替换） */
  present: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  adapterId: string;
  adapterName: string;
  /** 探测基准 URL（元数据面板 baseUrl 优先链合成值；空 = 不可探测） */
  baseUrl: string | null;
  /** 当前生效模型（高亮 + 默认过滤词） */
  currentModel: string | null;
  /** 会话配置选项（含 model select 项时点选后同步 set_config_option 即时生效） */
  configOptions: AcpSessionConfigOption[] | null;
  /** 会话级切模型回调；null = 无活跃会话（只写配置）。
   *  resolve(true) = set_config_option 生效；resolve(false) = 连接器拒绝（如 claude-code
   *  选择器外的网关模型，写入的 allowlist 只对新会话可见）——UI 据此如实提示。 */
  onSessionModelChange: ((model: string) => Promise<boolean>) | null;
  /** 写回成功后通知外层刷新元数据 */
  onWritten: () => void;
  /** 设置页配置表单上下文（设置页传入；元数据面板不传） */
  formContext?: FormContext | null;
  /** P32c：快问场景（settingsPage + qaMode）——无 harness 配置写回语义，
   *  点选只更新 quickask.json 的 model 字段（qaModelOnly 由 onQaModelPick 承载）。 */
  qaMode?: boolean;
  /** 快问模型点选回调（qaMode=true 时必传）；resolve 后由外层保存 quickask 配置 */
  onQaModelPick?: (model: string) => void;
}

export function ModelSwitchPanel({
  open,
  onClose,
  adapterId,
  adapterName,
  baseUrl,
  currentModel,
  configOptions,
  onSessionModelChange,
  onWritten,
  formContext,
  qaMode,
  onQaModelPick,
}: Props) {
  const [models, setModels] = useState<string[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const writable = supportsWrite(adapterId);
  // configOptions 里 category=model 的 select 项 → 会话级切换可用（omp/pi 实测有）
  const modelOption = configOptions?.find(
    (o) => o.category === "model" && o.type === "select",
  );
  const sessionSwitchable = Boolean(modelOption && onSessionModelChange);

  const doProbe = useCallback(async () => {
    // 表单上下文优先：endpoint 用表单值（可为空 → Rust 侧回落本机配置）
    const effectiveBase = formContext ? formContext.endpoint : baseUrl;
    if (!effectiveBase && !formContext) {
      setProbeError("无 baseUrl 可探测（本 harness 未采集到接口地址）");
      return;
    }
    setProbing(true);
    setProbeError(null);
    try {
      const ids = await probeModels(adapterId, effectiveBase ?? "", formContext?.apiKey || undefined);
      logger.info("meta", "models-probed", { adapterId, count: ids.length });
      setModels(ids);
    } catch (e) {
      const err = e as { kind?: string; message?: string };
      const msg = err?.message ?? String(e);
      logger.warn("meta", "models-probe-fail", { adapterId, kind: err?.kind, msg });
      setModels(null);
      setProbeError(msg);
    } finally {
      setProbing(false);
    }
  }, [adapterId, baseUrl, formContext]);

  // 打开即探测；baseUrl 变化（URL 编辑联动）重新探测
  useEffect(() => {
    if (open) {
      setFilter("");
      void doProbe();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, baseUrl, formContext?.endpoint, formContext?.apiKey]);

  const filtered = models?.filter((m) => m.toLowerCase().includes(filter.toLowerCase())) ?? [];

  async function pick(model: string) {
    setSaving(model);
    // P32c：快问场景——只回填模型名，由外层随「保存」写 quickask.json
    if (qaMode && onQaModelPick) {
      onQaModelPick(model);
      toast.success(`快问模型已选择 ${model}`, { description: "点「保存」后生效（写入快问配置，不影响任何 harness）" });
      setSaving(null);
      onClose();
      return;
    }
    try {
      // ① 会话级即时生效（有 model configOption 且有活跃会话）。
      //    resolve(false) = 连接器拒绝（claude-code 选择器外的网关模型，写入的
      //    allowlist 只对新会话可见）——持久写回继续，toast 如实提示。
      let sessionApplied = false;
      if (sessionSwitchable && onSessionModelChange) {
        sessionApplied = await onSessionModelChange(model);
      }
      // ② 持久写回：设置页表单上下文 + 配置文件不存在 → 走配置代写新建
      // （定点替换要求文件已存在，新建场景会报「读取失败」——三格齐落盘才是对的）
      // P32e：结果提示收敛为「持久落盘 × 会话生效」二维模板（switchResultToast），
      // 五家共用同一套文案函数，不再各分支硬编码。
      if (formContext && !formContext.present) {
        if (!formContext.endpoint.trim()) {
          throw new Error("配置文件不存在且表单 endpoint 为空，无法新建配置");
        }
        const written = await harnessConfigSave({
          program: adapterId,
          endpoint: formContext.endpoint,
          apiKey: formContext.apiKey,
          model,
        });
        logger.info("meta", "model-created", { adapterId, model, path: written });
        const t = switchResultToast({
          persisted: "created",
          sessionApplied: sessionSwitchable ? sessionApplied : undefined,
        });
        toast[t.kind](t.message(model), { description: t.detail(`${written}`) });
      } else if (writable) {
        const out = await writeHarnessSettings(adapterId, { model });
        logger.info("meta", "model-written", { adapterId, model, path: out.path });
        const detail = `配置已写入 ${out.path}（备份 ${out.backup}）`;
        const t = switchResultToast({
          persisted: "written",
          sessionApplied: sessionSwitchable ? sessionApplied : undefined,
        });
        toast[t.kind](t.message(model), { description: t.detail(detail) });
      } else if (sessionApplied) {
        // pi：无持久写回，仅会话级
        const t = switchResultToast({ persisted: "none", sessionApplied: true });
        toast[t.kind](t.message(model), { description: t.detail() });
      } else {
        const t = switchResultToast({ persisted: "none", sessionApplied: false });
        toast[t.kind](t.message(model), { description: t.detail(undefined, adapterName) });
        setSaving(null);
        return;
      }
      onWritten();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn("meta", "model-write-fail", { adapterId, model, msg });
      toast.error(`切换失败：${msg}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="model-switch-modal" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {adapterName} · 选择模型
            {(formContext ? formContext.endpoint : baseUrl) && (
              <span className="msm-base">{formContext ? formContext.endpoint : baseUrl}</span>
            )}
          </DialogTitle>
        </DialogHeader>

        <input
          className="msm-filter"
          type="text"
          placeholder="过滤模型…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="过滤模型"
        />

        {probing && <div className="msm-state">探测模型列表中…</div>}

        {!probing && probeError && (
          <div className="msm-state msm-error" role="alert">
            <div>探测失败：{probeError}</div>
            <button type="button" className="msm-retry" onClick={() => void doProbe()}>
              重试
            </button>
          </div>
        )}

        {!probing && !probeError && models && (
          <>
            {models.length === 0 ? (
              <div className="msm-state">网关未返回任何模型</div>
            ) : filtered.length === 0 ? (
              <div className="msm-state">无匹配「{filter}」的模型</div>
            ) : (
              <ul className="msm-list" role="listbox" aria-label="模型列表">
                {filtered.map((m) => (
                  <li key={m}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={m === currentModel}
                      className={m === currentModel ? "msm-row active" : "msm-row"}
                      disabled={saving !== null}
                      onClick={() => void pick(m)}
                    >
                      <span className="meta-mono">{m}</span>
                      {m === currentModel && <span className="meta-tag">当前</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        <div className="msm-foot">
          {models !== null && <span>{models.length} 个模型 · 来自 {formContext ? formContext.endpoint : baseUrl}</span>}
          {qaMode ? (
            <span>选择后作为快问模型（仅写入快问配置）</span>
          ) : writable || formContext ? (
            <span>选择后写入本机配置{sessionSwitchable ? "并即时应用到会话" : "（对新会话生效）"}</span>
          ) : sessionSwitchable ? (
            <span>该 harness 无配置写回，仅切换当前会话</span>
          ) : (
            <span>该 harness 暂不支持切换</span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
