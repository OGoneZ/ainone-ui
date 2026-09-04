// 新建会话弹层（F-5-2 + F-7-8）：先选 harness + 工作区（或未归组 / 新建工作区）。
// 右键工作区「新建会话」时 presetWorkspaceId 预填，跳过工作区选择。
// P7 外壳迁到 shadcn Dialog（受控 + Esc + 遮罩 + 进出场动画）。

import { useEffect, useState } from "react";
import type { AdapterWithStatus } from "../ipc/adapters";
import { workspacesUpsert, pickDirectory, type Workspace } from "../ipc/workspaces";
import { normPath } from "../lib/normPath";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

interface Props {
  open: boolean;
  adapters: AdapterWithStatus[];
  workspaces: Workspace[];
  /** 右键工作区新建会话时预填的工作区 id；null = 未归组（预填为未归组） */
  presetWorkspaceId?: string | null;
  onClose: () => void;
  onConfirm: (adapterId: string, workspaceId: string | null, cwd?: string) => void;
  /** 新建工作区后回调（父级刷新 workspaces 列表，避免侧栏分组状态过期） */
  onWorkspaceCreated?: () => void;
}

export function NewSessionModal({
  open,
  adapters,
  workspaces,
  presetWorkspaceId,
  onClose,
  onConfirm,
  onWorkspaceCreated,
}: Props) {
  // 本地工作区副本：新建工作区后即时回显，无需父级刷新
  const [localWs, setLocalWs] = useState<Workspace[]>([]);
  const [adapterId, setAdapterId] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAdapterId(adapters[0]?.id ?? "");
    setLocalWs(workspaces);
    setWorkspaceId(presetWorkspaceId !== undefined ? presetWorkspaceId : (workspaces[0]?.id ?? null));
  }, [open, adapters, workspaces, presetWorkspaceId]);

  async function newWorkspace() {
    const dir = await pickDirectory();
    if (!dir) return;
    // 若所选目录已被某工作区占用，直接选中既有工作区（不重复创建）
    const existing = localWs.find((w) => normPath(w.cwd) === normPath(dir));
    if (existing) {
      setWorkspaceId(existing.id);
      return;
    }
    setCreating(true);
    try {
      const name = dir.split("/").filter(Boolean).pop() || dir;
      const w: Workspace = { id: `ws-${Date.now()}`, name, cwd: dir, created_ms: Date.now() };
      // upsert 按 cwd 以新换旧，返回落盘后的权威 id（可能覆盖并发创建的同目录工作区）
      const authoritativeId = await workspacesUpsert(w);
      const authoritative: Workspace = { ...w, id: authoritativeId };
      setLocalWs((ws) => {
        // 移除同 cwd 的本地副本，填入权威工作区，避免下拉出现重复项
        const rest = ws.filter((x) => normPath(x.cwd) !== normPath(dir));
        return [...rest, authoritative];
      });
      setWorkspaceId(authoritativeId);
      onWorkspaceCreated?.();
    } finally {
      setCreating(false);
    }
  }

  const selected = localWs.find((w) => w.id === workspaceId) ?? null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建会话</DialogTitle>
        </DialogHeader>

        <label className="ns-label">
          harness
          <select value={adapterId} onChange={(e) => setAdapterId(e.target.value)}>
            {adapters.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.available ? "" : "（未安装）"}
              </option>
            ))}
          </select>
        </label>

        <label className="ns-label">
          工作区
          <select
            value={workspaceId ?? ""}
            onChange={(e) => setWorkspaceId(e.target.value || null)}
          >
            <option value="">未归组（默认目录）</option>
            {localWs.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}（{w.cwd}）
              </option>
            ))}
          </select>
        </label>
        <button className="ns-new-ws" onClick={newWorkspace} disabled={creating}>
          {creating ? "创建中…" : "＋ 新建工作区（选目录）"}
        </button>

        <div className="modal-actions">
          <button
            onClick={() => {
              onClose();
              onConfirm(adapterId, workspaceId, selected?.cwd);
            }}
            disabled={!adapterId}
          >
            开始对话
          </button>
          <button onClick={onClose}>取消</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
