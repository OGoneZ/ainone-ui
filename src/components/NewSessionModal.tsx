// 新建会话弹层（F-5-2）：先选 harness + 工作区（或未归组 / 新建工作区）。
// 右键工作区「新建会话」时 presetWorkspaceId 预填，跳过工作区选择。

import { useEffect, useState } from "react";
import type { AdapterWithStatus } from "../config/adapters";
import { workspacesUpsert, pickDirectory, type Workspace } from "../config/workspaces";

interface Props {
  open: boolean;
  adapters: AdapterWithStatus[];
  workspaces: Workspace[];
  /** 右键工作区新建会话时预填的工作区 id；null = 未归组（预填为未归组） */
  presetWorkspaceId?: string | null;
  onClose: () => void;
  onConfirm: (adapterId: string, workspaceId: string | null, cwd?: string) => void;
}

export function NewSessionModal({
  open,
  adapters,
  workspaces,
  presetWorkspaceId,
  onClose,
  onConfirm,
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
    setCreating(true);
    try {
      const name = dir.split("/").filter(Boolean).pop() || dir;
      const w: Workspace = { id: `ws-${Date.now()}`, name, cwd: dir, created_ms: Date.now() };
      await workspacesUpsert(w);
      setLocalWs((ws) => [...ws, w]);
      setWorkspaceId(w.id);
    } finally {
      setCreating(false);
    }
  }

  if (!open) return null;

  const selected = localWs.find((w) => w.id === workspaceId) ?? null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>新建会话</h2>

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
      </div>
    </div>
  );
}
