// 新建会话弹层（F-5-2 + F-7-8）：两步向导——①选 harness → Enter 进下一步
// ②选工作区 → Enter 确认创建。全程键盘可达（↑↓ 选择 + Enter 推进），
// 鼠标点击同样有效（点选项=选中；第一步点「下一步」按钮 / 第二步点「开始对话」按钮）。
// 右键工作区「新建会话」时 presetWorkspaceId 预填，直接落在第二步。
// P7 外壳迁到 shadcn Dialog；P25 改 cmdk 列表；P26 改两步向导。

import { useEffect, useState } from "react";
import type { AdapterWithStatus } from "@/ipc/adapters";
import { workspacesUpsert, pickDirectory, type Workspace } from "@/ipc/workspaces";
import { normPath } from "@/lib/normPath";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandList, CommandGroup, CommandItem, CommandSeparator } from "@/components/ui/command";

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
  // P26 两步向导：harness=选框架；workspace=选目录（presetWorkspaceId 存在时直接进第二步）
  const [step, setStep] = useState<"harness" | "workspace">("harness");

  useEffect(() => {
    if (!open) return;
    setAdapterId(adapters[0]?.id ?? "");
    setLocalWs(workspaces);
    setWorkspaceId(presetWorkspaceId !== undefined ? presetWorkspaceId : (workspaces[0]?.id ?? null));
    setStep(presetWorkspaceId !== undefined ? "workspace" : "harness");
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
  const selectedAdapter = adapters.find((a) => a.id === adapterId) ?? null;

  function confirm() {
    if (!adapterId || creating) return;
    onClose();
    onConfirm(adapterId, workspaceId, selected?.cwd);
  }

  /** 第一步：Enter/点击「下一步」——选中当前高亮 harness 即推进 */
  function goNext() {
    if (!adapterId) return;
    setStep("workspace");
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{step === "harness" ? "新建会话 · 选择 Harness" : "新建会话 · 选择工作目录"}</DialogTitle>
        </DialogHeader>

        {/* P26 两步向导：每步一个 cmdk 列表。↑↓ 导航（cmdk 自带）、
            onSelect 选中当前项，「下一步/开始对话」项 Enter 推进；
            第二步列表尾部保留「上一步」与「新建工作区」入口。 */}
        {step === "harness" ? (
          <Command loop className="ns-command">
            <CommandList className="ns-command-list">
              <CommandGroup heading={`harness（↑↓ 选择，Enter 下一步）`}>
                {adapters.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={`harness-${a.id}`}
                    disabled={!a.available}
                    onSelect={() => {
                      setAdapterId(a.id);
                      // P26：Enter/点击 harness 项 = 选中并直接进下一步
                      setStep("workspace");
                    }}
                    className={adapterId === a.id ? "ns-item ns-item-active" : "ns-item"}
                  >
                    <span className="ns-item-name">{a.name}</span>
                    {!a.available && <span className="ns-item-note">未安装</span>}
                    {adapterId === a.id && <span className="ns-item-check">✓</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <Command loop className="ns-command">
            <CommandList className="ns-command-list">
              <CommandGroup heading={`工作区（↑↓ 选择，Enter 确认）`}>
                <CommandItem
                  value="ws-none"
                  onSelect={() => setWorkspaceId(null)}
                  className={workspaceId === null ? "ns-item ns-item-active" : "ns-item"}
                >
                  <span className="ns-item-name">未归组（默认目录）</span>
                  {workspaceId === null && <span className="ns-item-check">✓</span>}
                </CommandItem>
                {localWs.map((w) => (
                  <CommandItem
                    key={w.id}
                    value={`ws-${w.id}`}
                    onSelect={() => setWorkspaceId(w.id)}
                    className={workspaceId === w.id ? "ns-item ns-item-active" : "ns-item"}
                  >
                    <span className="ns-item-name">{w.name}</span>
                    <span className="ns-item-note">{w.cwd}</span>
                    {workspaceId === w.id && <span className="ns-item-check">✓</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="操作">
                <CommandItem
                  value="ns-new-ws"
                  disabled={creating}
                  onSelect={() => { void newWorkspace(); }}
                >
                  <span className="ns-item-name">{creating ? "创建中…" : "＋ 新建工作区（选目录）"}</span>
                </CommandItem>
                <CommandItem
                  value="ns-back"
                  onSelect={() => setStep("harness")}
                >
                  <span className="ns-item-name">← 上一步（重选 harness）</span>
                </CommandItem>
                <CommandItem
                  value="ns-confirm"
                  disabled={!adapterId || creating}
                  onSelect={confirm}
                  data-testid="ns-confirm"
                >
                  <span className="ns-item-name">开始对话</span>
                  {selectedAdapter && !selectedAdapter.available && (
                    <span className="ns-item-note bad">未找到程序，开始前请先安装</span>
                  )}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        )}

        {step === "workspace" && selectedAdapter && !selectedAdapter.available && (
          <p className="ns-hint bad">
            {selectedAdapter.id === "claude-code"
              ? "Claude Code 连接器未找到——首次开始对话时将自动安装（需 bun/node 与网络），并使用已安装的 claude CLI。"
              : `程序 ${selectedAdapter.program} 未找到（已搜索 ~/.local/bin、~/.bun/bin、nvm、登录 shell PATH 与系统 PATH）。请先安装，或在设置中改为绝对路径。`}
          </p>
        )}

        <div className="modal-actions">
          {step === "harness" ? (
            <button onClick={goNext} disabled={!adapterId} data-testid="ns-next-btn">
              下一步
            </button>
          ) : (
            <button onClick={confirm} disabled={!adapterId || creating} data-testid="ns-confirm-btn">
              开始对话
            </button>
          )}
          <button onClick={onClose}>取消</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
