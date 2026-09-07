// 新建会话弹层（F-5-2 + F-7-8）：两步向导——①选 harness ②选工作区。
// 步进：→ 键进下一步（=「下一步」按钮）、← 键回上一步（=第二步的「上一步」按钮）、
// Enter 确认（第一步=进第二步，第二步=创建）；↑↓ 移动列表高亮。
// 每步列表只放业务选项（第二步尾部保留「新建工作区」），不放步骤操作项。
// 鼠标：点选项仅选中（可改选），推进/回退用底部按钮。
// 右键工作区「新建会话」时 presetWorkspaceId 预填，直接落在第二步。
// P7 外壳迁 shadcn Dialog；P25 改 cmdk；P26 两步向导；P26c 左右键换步 + 删操作面板。
// P28 三态：installable（懒装桥可装）不再灰掉——点「开始对话」先走安装（进度行
// 展示安装器输出），装成再创建会话；absent 才禁用并说明缺什么。

import { useCallback, useEffect, useRef, useState } from "react";
import type { AdapterWithStatus } from "@/ipc/adapters";
import { installBridge, installCli } from "@/ipc/adapters";
import { workspacesUpsert, pickDirectory, type Workspace } from "@/ipc/workspaces";
import { normPath } from "@/lib/normPath";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandList, CommandGroup, CommandItem } from "@/components/ui/command";

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
  /** P28：桥安装成功后父级重拉 adapters（三态刷新，装完即 ready） */
  onAdaptersRefresh?: () => Promise<void> | void;
}

export function NewSessionModal({
  open,
  adapters,
  workspaces,
  presetWorkspaceId,
  onClose,
  onConfirm,
  onWorkspaceCreated,
  onAdaptersRefresh,
}: Props) {
  // 本地工作区副本：新建工作区后即时回显，无需父级刷新
  const [localWs, setLocalWs] = useState<Workspace[]>([]);
  const [adapterId, setAdapterId] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // P28/P29：懒装安装态——installing=安装进行中；installingCli=当前装的是 CLI 本体（否则为桥）；
  // installTail=安装器输出尾迹（进度行）
  const [installing, setInstalling] = useState(false);
  const [installingCli, setInstallingCli] = useState(false);
  const [installTail, setInstallTail] = useState("");
  const [installError, setInstallError] = useState<string | null>(null);
  // P26 两步向导：harness=选框架；workspace=选目录（presetWorkspaceId 存在时直接进第二步）
  const [step, setStep] = useState<"harness" | "workspace">("harness");
  // P26b：cmdk root ref——无输入框模式下方向键监听在 root 的 onKeyDown，
  // root 必须持焦点方向键才可达（Dialog 默认把焦点给容器，真机实测高亮不动）
  const cmdkRootRef = useRef<HTMLDivElement | null>(null);
  // P29：adapters 最新快照 ref——串联安装（装 CLI → 刷新 → 装桥）跨 render 读最新状态
  const adapterRef = useRef(adapters);
  adapterRef.current = adapters;
  useEffect(() => {
    if (!open) return;
    // 等内容渲染完再聚焦（Dialog 焦点圈先落容器）
    const t = setTimeout(() => cmdkRootRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    setAdapterId(adapters[0]?.id ?? "");
    setLocalWs(workspaces);
    setWorkspaceId(presetWorkspaceId !== undefined ? presetWorkspaceId : (workspaces[0]?.id ?? null));
    setStep(presetWorkspaceId !== undefined ? "workspace" : "harness");
    setInstalling(false);
    setInstallingCli(false);
    setInstallError(null);
    setInstallTail("");
    // P29：依赖只留 open + presetWorkspaceId。原先依赖 adapters 会在串联安装中途
    // （父级 onAdaptersRefresh 换 adapters props）把用户已选的 harness/工作区与
    // 安装进度整体重置——安装中途被清 = 缺陷。adapters 后续变化经 adapterRef 读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetWorkspaceId]);

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

  // P29：workspaceId/localWs 在 async startSession 闭包里是本次 render 的快照——
  // 串联安装跨多次 render，onConfirm 时的选中工作区须经 ref 读最新值。
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  function confirm() {
    if (!adapterId || creating || installing) return;
    void startSession();
  }

  /** P28/P29：先装后开——CLI 未装先装 CLI（成功保留）、桥未装再装桥，串联但解耦：
   *  任一步失败停在失败处（已装部分保留，重开按真实状态续补），全成后才关窗建会话。 */
  async function startSession() {
    const a = adapters.find((x) => x.id === adapterId);
    if (!a) return;
    const tail = (line: string) => {
      setInstallTail((prev) => (prev + "\n" + line).split("\n").slice(-4).join("\n"));
    };
    const begin = (isCli: boolean) => {
      setInstalling(true);
      setInstallingCli(isCli);
      setInstallError(null);
      setInstallTail("");
    };
    let cliInstalled = false;
    if (a.state === "cli_installable") {
      begin(true);
      try {
        await installCli(a.program, tail);
        cliInstalled = true;
        // 装 CLI 成功 → 刷新四态（cli_installable 转 installable 或 ready）
        await onAdaptersRefresh?.();
      } catch (e) {
        setInstallError(String(e instanceof Error ? e.message : e));
        setInstalling(false);
        return;
      }
      setInstalling(false);
    }
    // CLI 刚装完刷新后 state 可能已转 installable——用 ref 读最新 props：
    // React 的 props（adapters）在 async 闭包里是本次 render 的快照，
    // 所以经 adapterRef.current 取刷新后的最新列表。
    const fresh = cliInstalled
      ? (adapterRef.current.find((x) => x.id === adapterId) ?? a)
      : a;
    if (fresh.state === "installable") {
      begin(false);
      try {
        await installBridge(fresh.program, tail);
        await onAdaptersRefresh?.();
      } catch (e) {
        setInstallError(String(e instanceof Error ? e.message : e));
        setInstalling(false);
        return;
      }
      setInstalling(false);
    }
    onClose();
    onConfirm(adapterId, workspaceIdRef.current ?? workspaceId, selectedRef.current?.cwd ?? selected?.cwd);
  }

  function goNext() {
    if (!adapterId) return;
    setStep("workspace");
  }
  function goBack() {
    setStep("harness");
  }

  // P26c：左右键换步——cmdk root 的 onKeyDown 层处理（root 持焦点时可达）。
  // → 进第二步；← 在第二步回第一步。
  // P26d：↑↓ 移高亮时同步选中（受控 value=当前选中项；onValueChange 回写），
  // Enter 语义 = 步骤直达：第一步进第二步、第二步确认创建（高亮在
  // 「新建工作区」上时除外——那次 Enter 交给 cmdk 走选目录）。
  const onStepNavKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "ArrowRight" && step === "harness") {
      e.preventDefault();
      goNext();
    } else if (e.key === "ArrowLeft" && step === "workspace") {
      e.preventDefault();
      goBack();
    } else if (e.key === "Enter") {
      // 高亮项语义：
      //   第一步 harness 项 → cmdk onSelect 已选中，这里直接进第二步
      //   第二步工作区项 → 直接确认创建
      //   第二步「新建工作区」项 → 不拦截，cmdk onSelect 打开目录选择
      const highlight = (e.currentTarget as HTMLElement).querySelector('[cmdk-item][aria-selected="true"]');
      const v = highlight?.getAttribute("data-value") ?? "";
      if (v === "ns-new-ws") return;
      e.preventDefault();
      if (step === "harness") goNext();
      else confirm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, adapterId, workspaceId, creating]);

  // ↑↓ 高亮即选中：从 cmdk 受控 value 回调同步业务选中
  function onHarnessValueChange(v: string) {
    const id = v.replace(/^harness-/, "");
    if (adapters.some((a) => a.id === id)) setAdapterId(id);
  }
  function onWorkspaceValueChange(v: string) {
    // P29：v === "ws-none" 只在用户点「未归组」或 Enter 语义上成立；cmdk 受控
    // value 在 rerender 时也会回调当前值，这里是幂等的。关键修复：不要在
    // 回调里无条件 setWorkspaceId(null)——受控 value 的初始回调时机在
    // localWs/workspaces 就绪前后不同，会覆盖 presetWorkspaceId。
    if (v === "ws-none") {
      setWorkspaceId(null);
      return;
    }
    const id = v.replace(/^ws-/, "");
    if (localWs.some((w) => w.id === id)) setWorkspaceId(id);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{step === "harness" ? "新建会话 · 选择 Harness" : "新建会话 · 选择工作目录"}</DialogTitle>
        </DialogHeader>

        {/* P26c 两步向导：每步一个 cmdk 列表，只放业务选项。键盘语义：
            ↑↓ 高亮即选中（✓ 跟随）；第一步 Enter/→ 进第二步；第二步 ← 回上一步、
            Enter 确认创建；鼠标点选项仅选中，步骤推进用底部按钮（兼顾鼠标）。 */}
        {step === "harness" ? (
          <Command
            loop
            ref={cmdkRootRef}
            tabIndex={-1}
            className="ns-command"
            value={adapterId ? `harness-${adapterId}` : undefined}
            onValueChange={onHarnessValueChange}
            onKeyDown={onStepNavKeyDown}
            // P26g：禁「hover 即选中」——鼠标移动只走 CSS :hover 视觉高亮，
            // 选中必须点击（键盘 ↑↓ 仍经 onValueChange 同步选中，两路互不干扰）
            disablePointerSelection
          >
            <CommandList className="ns-command-list">
              <CommandGroup heading="harness（↑↓ 选择，→ 或 Enter 下一步）">
                {adapters.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={`harness-${a.id}`}
                    disabled={a.state === "absent" && !a.cli}
                    onSelect={() => setAdapterId(a.id)}
                    className={adapterId === a.id ? "ns-item ns-item-active" : "ns-item"}
                  >
                    <span className="ns-item-name">{a.name}</span>
                    {a.state === "absent" && <span className="ns-item-note">{a.cli ? "未安装 · 缺安装条件" : "未安装"}</span>}
                    {a.state === "cli_installable" && (
                      <span className="ns-item-note">未安装 · 首次使用自动安装（CLI + 桥）</span>
                    )}
                    {a.state === "installable" && (
                      <span className="ns-item-note">未装 ACP 桥接器 · 首次使用自动安装</span>
                    )}
                    {adapterId === a.id && <span className="ns-item-check">✓</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        ) : (
          <Command
            loop
            ref={cmdkRootRef}
            tabIndex={-1}
            className="ns-command"
            value={workspaceId ? `ws-${workspaceId}` : "ws-none"}
            onValueChange={onWorkspaceValueChange}
            onKeyDown={onStepNavKeyDown}
            disablePointerSelection
          >
            <CommandList className="ns-command-list">
              <CommandGroup heading="工作区（↑↓ 选择，Enter 确认，← 上一步）">
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
              <CommandGroup heading="操作">
                <CommandItem
                  value="ns-new-ws"
                  disabled={creating}
                  onSelect={() => { void newWorkspace(); }}
                >
                  <span className="ns-item-name">{creating ? "创建中…" : "＋ 新建工作区（选目录）"}</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        )}

        {step === "workspace" && installing && (
          <div className="ns-hint" role="status" data-testid="ns-install-progress">
            <p>
              {installingCli
                ? `正在安装 ${selectedAdapter?.name}（CLI 本体）——首次需下载，视网络可能数秒至数分钟…`
                : `正在安装 ${selectedAdapter?.name} 的 ACP 桥接器（${selectedAdapter?.bridge?.pkg}）——首次需下载，视网络可能数秒至数分钟…`}
            </p>
            {installTail && (
              <pre className="ns-install-tail" style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: "0.8em" }}>
                {installTail}
              </pre>
            )}
          </div>
        )}
        {step === "workspace" && installError && (
          <p className="ns-hint bad" data-testid="ns-install-error">
            {installingCli ? "CLI 安装失败" : "桥接器安装失败"}：{installError}
          </p>
        )}
        {step === "workspace" && selectedAdapter?.state === "cli_installable" && !installing && !installError && (
          <p className="ns-hint">
            未检测到 {selectedAdapter.name}（{selectedAdapter.cli?.display}）——点「开始对话」将自动安装 CLI 本体
            与 ACP 桥接器（需网络）。CLI 安装到用户目录，失败不会影响已装部分。
          </p>
        )}
        {step === "workspace" && selectedAdapter?.state === "installable" && !installing && !installError && (
          <p className="ns-hint">
            检测到 {selectedAdapter.name} CLI 本体，首次开始对话时将自动安装 ACP 桥接器（
            {selectedAdapter.bridge?.pkg}@{selectedAdapter.bridge?.version}，需网络）。
          </p>
        )}
        {step === "workspace" && selectedAdapter?.state === "absent" && (
          <p className="ns-hint bad">
            {selectedAdapter.bridge
              ? !selectedAdapter.bridge.cliAvailable
                ? `未检测到 ${selectedAdapter.name} 的 CLI 本体——桥接器只是转接头，请先在终端安装 ${selectedAdapter.name} 本身。`
                : `未找到 bun 或 npm 运行时，无法自动安装 ${selectedAdapter.name} 的 ACP 桥接器。请安装 Node.js ≥20 或 bun。`
              : selectedAdapter.cli && !selectedAdapter.cli.installable
                ? `未找到 bun 或 npm 运行时，无法自动安装 ${selectedAdapter.cli.display}。请安装 Node.js ≥20 或 bun。`
                : `程序 ${selectedAdapter.program} 未找到（已搜索 ~/.local/bin、~/.bun/bin、nvm、登录 shell PATH 与系统 PATH）。请先安装，或在设置中改为绝对路径。`}
          </p>
        )}

        <div className="modal-actions">
          {step === "workspace" && (
            <button onClick={goBack} data-testid="ns-back-btn">
              上一步
            </button>
          )}
          {step === "harness" ? (
            <button onClick={goNext} disabled={!adapterId} data-testid="ns-next-btn">
              下一步
            </button>
          ) : (
            <button onClick={confirm} disabled={!adapterId || creating || installing} data-testid="ns-confirm-btn">
              {installing ? "安装桥接器中…" : "开始对话"}
            </button>
          )}
          <button onClick={onClose}>取消</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
