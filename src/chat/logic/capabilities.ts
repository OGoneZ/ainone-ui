// capability gate 纯逻辑（P24g，对标 AionUi 的 isForkEnabled）：功能入口按
// initialize 握手返回的 agentCapabilities 显隐——没能力就不显示入口，而不是点了报错。
//
// 判断规则（与 ACP 规格语义一致）：
//   - 对象型能力（sessionCapabilities.fork 等）：key presence = 支持。
//     省略或 null 均不支持；`{}` 即支持（AionUi 式规则）
//   - 布尔型能力（loadSession）：显式 false 才视为不支持；undefined = 老 harness
//     未声明，宽松尝试（与会话层降级预检的语义一致）

import type { AgentCapabilities } from "@agentclientprotocol/sdk";

/** session/fork（UNSTABLE）：`sessionCapabilities.fork` key 存在即支持 */
export function canFork(cap: AgentCapabilities | null | undefined): boolean {
  return cap?.sessionCapabilities?.fork != null;
}

/** session/load：显式 false 才不支持（undefined 视为未知 → 宽松允许） */
export function canLoad(cap: AgentCapabilities | null | undefined): boolean {
  return cap?.loadSession !== false;
}

/** session/resume：key presence 规则（供后续恢复链升级用） */
export function canResume(cap: AgentCapabilities | null | undefined): boolean {
  return cap?.sessionCapabilities?.resume != null;
}

/** session/close：key presence 规则 */
export function canClose(cap: AgentCapabilities | null | undefined): boolean {
  return cap?.sessionCapabilities?.close != null;
}

/** session/list：key presence 规则（P32d 会话列表入口 gate） */
export function canList(cap: AgentCapabilities | null | undefined): boolean {
  return cap?.sessionCapabilities?.list != null;
}

/** P32d：capability snapshot——五布尔单一事实源（对标 DeepChat buildCapabilitySnapshot）。
 *  握手后由 store 存档，UI 与恢复链只消费布尔，不再各自解释对象型能力。 */
export interface CapabilitySnapshot {
  fork: boolean;
  load: boolean;
  resume: boolean;
  close: boolean;
  list: boolean;
}

export function capabilitySnapshot(cap: AgentCapabilities | null | undefined): CapabilitySnapshot {
  return {
    fork: canFork(cap),
    load: canLoad(cap),
    resume: canResume(cap),
    close: canClose(cap),
    list: canList(cap),
  };
}
