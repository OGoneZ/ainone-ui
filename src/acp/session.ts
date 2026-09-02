// ACP 会话层（Tauri 绑定）：把 session-core 的纯协议逻辑接到 Tauri 传输/IPC。
//
// 协议逻辑在 session-core.ts（零 Tauri 依赖），这里只做两件绑定：
//   1) streams —— spawnHarness 出字节流
//   2) ipc     —— fs 回调走 invoke fd_read/fd_write，kill 走 agent_kill

import { invoke } from "@tauri-apps/api/core";
import { spawnHarness } from "./bridge";
import { createAcpSession, type AcpSession, type CommandWord, type PermissionDecision } from "./session-core";
import type { Adapter } from "../config/adapters";

export type { AcpSession, PermissionDecision, Outgoing } from "./session-core";

export async function openSession(
  adapter: Adapter,
  onPermission: PermissionDecision,
  resumeSessionId?: string,
  onCommands?: (words: CommandWord[]) => void,
  cwdOverride?: string,
): Promise<AcpSession> {
  // F-5-2：新建会话选工作区时，会话在工作区目录跑（覆盖 adapter 默认 cwd）
  const cwd = await invoke<string>("abs_path", {
    path: cwdOverride && cwdOverride.length > 0 ? cwdOverride : adapter.cwd,
  }).catch(() => cwdOverride || adapter.cwd);
  const proc = await spawnHarness(adapter.program, adapter.args, cwd);

  return createAcpSession({
    streams: { stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr },
    cwd,
    onPermission,
    resumeSessionId,
    onCommands,
    ipc: {
      fsRead: (path) => invoke<string>("fd_read", { path }),
      fsWrite: (path, content) => invoke("fd_write", { path, content }),
      kill: () => invoke("agent_kill", { agentId: proc.agentId }),
    },
  });
}
