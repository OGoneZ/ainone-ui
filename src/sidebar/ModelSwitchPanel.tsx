// P29 R5 模型切换面板：探测网关 /v1/models → 列表选择 → 写回 harness 配置。
//
// 打开即探测（key 由 Rust 从本机配置自取，明文不过 WebView）；支持输入过滤；
// 点选模型 → ①configOptions 有 model 项时同步 session/set_config_option（omp/pi 会话即时生效）
// ②写回配置文件（claude-code/codex/omp：Rust 定点替换+写前备份；claude-code/codex 提示新会话生效）。
// 探测失败展示结构化原因 + 重试。

import { useCallback, useEffect, useRef, useState } from "react";
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
  /** 仅会话级（P32f）：侧栏元数据面板语义——切模型只调用 set_config_option
   *  作用于当前会话，绝不写全局配置文件。five harness 的 configOption
   *  category=model 实测（2026-09-09）全部可达，故侧栏统一走会话级。 */
  sessionOnly?: boolean;
  /** 会话级切换失败/暂不支持时提示（sessionOnly=true 且无法会话级切换时返回 null） */
  onSessionOnlyFail?: (msg: string) => void;
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
  sessionOnly,
  onSessionOnlyFail,
}: Props) {
  const [models, setModels] = useState<string[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  // P39 R4：键盘高亮（瞬态选择，与「当前模型」的 aria-selected/.active 正交）。
  // -1 = 无高亮；↑↓ 在 filtered 范围内循环移动；过滤词变化重置 0。
  const [kbIdx, setKbIdx] = useState(0);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

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
      setKbIdx(0);
      void doProbe();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, baseUrl, formContext?.endpoint, formContext?.apiKey]);

  const filtered = models?.filter((m) => m.toLowerCase().includes(filter.toLowerCase())) ?? [];

  // P39 R4：过滤结果变化 → 高亮重置第一项（越界钳位；空列表归 -1）
  useEffect(() => {
    setKbIdx((i) => (filtered.length === 0 ? -1 : Math.min(Math.max(i, 0), filtered.length - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, models, probeError, probing]);

  // P39 R4：键盘高亮行滚入可视区（P26c slash 菜单同款 block:nearest）
  useEffect(() => {
    const list = listRef.current;
    if (!list || kbIdx < 0) return;
    list.querySelector(".msm-row[data-kb-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [kbIdx]);

  /** P39 R4：过滤框键盘导航——↑↓ 循环移动高亮、Enter 确认高亮项（走 pick 同一
   *  链路，三处入口语义自动一致）、Esc 交 radix Dialog 关闭（不在此拦截） */
  function onFilterKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (filtered.length === 0) return;
      e.preventDefault();
      setKbIdx((i) => {
        const base = i < 0 ? 0 : i;
        return e.key === "ArrowDown" ? (base + 1) % filtered.length : (base - 1 + filtered.length) % filtered.length;
      });
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      if (kbIdx < 0 || kbIdx >= filtered.length) return; // 无高亮 → 不动作
      e.preventDefault();
      void pick(filtered[kbIdx]);
    }
  }

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
    // P32f：仅会话级（右栏元数据面板）——五家 configOption category=model
    // 实测全可达（claude-code/codex/opencode/omp/pi 均返回 model select）。
    // 只发 session/set_config_option + ACP 即时生效，绝不写配置文件——
    // 每会话独立模型，新会话不继承，全局配置（设置页）不被触碰。
    if (sessionOnly) {
      if (!sessionSwitchable || !onSessionModelChange) {
        const msg = `当前会话不支持模型切换（${adapterName} 无 model 配置项）`;
        toast.error(msg);
        onSessionOnlyFail?.(msg);
        setSaving(null);
        return;
      }
      const ok = await onSessionModelChange(model);
      if (ok) {
        const t = switchResultToast({ persisted: "none", sessionApplied: true });
        toast[t.kind](t.message(model), { description: "仅当前会话生效，其他会话与全局配置不变" });
      } else {
        toast.error(`切换失败：${adapterName} 未接受该模型（${model}）`);
      }
      setSaving(null);
      onClose();
      return;
    }
    try {
      // ① 会话级即时生效（有 model configOption 且有活跃会话）。
      //    resolve(false) = 连接器拒绝（claude-code 选择器外的网关模型，写入的
      //    allowlist 只对新会话可见）——持久写回继续，toast 如实提示。
      //    P35 R3.4 修复：此前这里连续两次调用 onSessionModelChange（合并引入的
      //    重复块），第二次可能把刚切好的会话级模型再切一遍。
      let sessionApplied = false;
      if (sessionSwitchable && onSessionModelChange) {
        sessionApplied = await onSessionModelChange(model);
      }
      if (formContext) {
        // P35 R3.2：设置页表单链路（present true/false 同一通道）→ 走配置代写
        // 全量三格写（endpoint/key/model 齐落盘，等效「保存配置」）。覆盖 omp/pi
        // 等无定点写回能力的 harness：点选模型即持久生效，不再落入「无配置写回」
        // 死路报错。endpoint 为空属防御分支（探测本就不可达）。
        if (!formContext.endpoint.trim()) {
          throw new Error("表单 endpoint 为空，无法写入配置");
        }
        const written = await harnessConfigSave({
          program: adapterId,
          endpoint: formContext.endpoint,
          apiKey: formContext.apiKey,
          model,
          // P39：点选模型走配置代写时上下文窗口落默认 1M（与设置页保存同语义）
          contextTokens: "",
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

        {/* P39 R4：打开即聚焦（autoFocus），直接打字过滤；↑↓/Enter 键盘导航 */}
        <input
          ref={filterRef}
          className="msm-filter"
          type="text"
          placeholder="过滤模型…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKeyDown}
          autoFocus
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
              <ul className="msm-list" role="listbox" aria-label="模型列表" ref={listRef}>
                {filtered.map((m, i) => (
                  <li key={m}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={m === currentModel}
                      data-kb-active={i === kbIdx ? "true" : undefined}
                      className={
                        (m === currentModel ? "msm-row active" : "msm-row") + (i === kbIdx ? " msm-row-kb" : "")
                      }
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
          ) : sessionOnly ? (
            <span>选择后仅切换当前会话（不写全局配置）</span>
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
