// P29 R6 URL 编辑面板：编辑 baseUrl → 校验 → 保存写回 → 触发模型列表重探测。
//
// 保存 = harness_settings_write(adapter_id, { baseUrl })（Rust 定点替换 + 备份）；
// pi/opencode 无写回能力 → 本面板不渲染（外层控制入口显隐）。
// 保存成功后外层 onWritten 刷新静态元数据 → baseUrl prop 变化 →
// ModelSwitchPanel 的 useEffect([open, baseUrl]) 自动重探测（联动需求 AC-R6-2）。

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { writeHarnessSettings } from "@/ipc/harnessMeta";
import { toast } from "sonner";
import { logger } from "@/lib/logger";

interface Props {
  open: boolean;
  onClose: () => void;
  adapterId: string;
  adapterName: string;
  /** 当前生效 baseUrl（预填；null = 无值可编辑） */
  baseUrl: string | null;
  /** 写回成功后通知外层（刷新元数据 + 触发模型重探测联动） */
  onWritten: () => void;
}

/** P29 R6 URL 校验（AC-R6-3）：必须 http(s) 非空 */
export function isValidHttpUrl(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function UrlEditPanel({ open, onClose, adapterId, adapterName, baseUrl, onWritten }: Props) {
  const [value, setValue] = useState(baseUrl ?? "");
  const [saving, setSaving] = useState(false);

  // 打开时同步当前值（外部 baseUrl 刷新后重新预填）
  useEffect(() => {
    if (open) setValue(baseUrl ?? "");
  }, [open, baseUrl]);

  const valid = isValidHttpUrl(value);
  const changed = value.trim() !== (baseUrl ?? "");

  async function save() {
    if (!valid || !changed) return;
    setSaving(true);
    try {
      const out = await writeHarnessSettings(adapterId, { baseUrl: value.trim() });
      logger.info("meta", "url-written", { adapterId, path: out.path });
      toast.success(`接口地址已更新（对新会话生效）`, {
        description: `配置已写入 ${out.path}（备份 ${out.backup}）`,
      });
      onWritten();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn("meta", "url-write-fail", { adapterId, msg });
      toast.error(`保存失败：${msg}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="url-edit-modal" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{adapterName} · 接口地址</DialogTitle>
        </DialogHeader>

        <input
          className="msm-filter"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://gw.example.com/v1"
          aria-label="接口地址"
          spellCheck={false}
        />

        {value.trim() !== "" && !valid && (
          <div className="msm-state msm-error" role="alert">
            请输入合法的 http(s) 地址
          </div>
        )}

        <div className="msm-foot">
          <span>保存后写入本机配置；模型列表将按新地址重新探测</span>
          <button
            type="button"
            className="msm-retry"
            disabled={!valid || !changed || saving}
            onClick={() => void save()}
            aria-label="保存接口地址"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
