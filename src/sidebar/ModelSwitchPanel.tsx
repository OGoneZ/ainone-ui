// P29 R5 模型切换面板：探测网关 /v1/models → 列表选择 → 写回 harness 配置。
//
// 打开即探测（key 由 Rust 从本机配置自取，明文不过 WebView）；支持输入过滤；
// 点选模型 → ①configOptions 有 model 项时同步 session/set_config_option（omp/pi 会话即时生效）
// ②写回配置文件（claude-code/codex/omp：Rust 定点替换+写前备份；claude-code/codex 提示新会话生效）。
// 探测失败展示结构化原因 + 重试。

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { probeModels, writeHarnessSettings, supportsWrite } from "@/ipc/harnessMeta";
import { toast } from "sonner";
import { logger } from "@/lib/logger";
import type { AcpSessionConfigOption } from "@/store/sessionStore";

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
  /** 会话级切模型回调；null = 无活跃会话（只写配置） */
  onSessionModelChange: ((model: string) => Promise<void>) | null;
  /** 写回成功后通知外层刷新元数据 */
  onWritten: () => void;
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
    if (!baseUrl) {
      setProbeError("无 baseUrl 可探测（本 harness 未采集到接口地址）");
      return;
    }
    setProbing(true);
    setProbeError(null);
    try {
      const ids = await probeModels(adapterId, baseUrl);
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
  }, [adapterId, baseUrl]);

  // 打开即探测；baseUrl 变化（URL 编辑联动）重新探测
  useEffect(() => {
    if (open) {
      setFilter("");
      void doProbe();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, baseUrl]);

  const filtered = models?.filter((m) => m.toLowerCase().includes(filter.toLowerCase())) ?? [];

  async function pick(model: string) {
    setSaving(model);
    try {
      // ① 会话级即时生效（有 model configOption 且有活跃会话）
      if (sessionSwitchable && onSessionModelChange) {
        await onSessionModelChange(model);
      }
      // ② 持久写回（claude-code/codex/omp）
      if (writable) {
        const out = await writeHarnessSettings(adapterId, { model });
        logger.info("meta", "model-written", { adapterId, model, path: out.path });
        toast.success(
          `已切换到 ${model}` + (sessionSwitchable ? "" : "（对新会话生效）"),
          { description: `配置已写入 ${out.path}（备份 ${out.backup}）` },
        );
      } else if (sessionSwitchable) {
        // pi：无持久写回，仅会话级
        toast.success(`当前会话已切换到 ${model}（仅本会话生效）`);
      } else {
        toast.error(`${adapterName} 不支持模型切换`);
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
            {baseUrl && <span className="msm-base">{baseUrl}</span>}
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
          {models !== null && <span>{models.length} 个模型 · 来自 {baseUrl}</span>}
          {writable ? (
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
