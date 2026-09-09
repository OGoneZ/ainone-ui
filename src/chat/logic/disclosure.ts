// P32 折叠策略纯函数（AC-2.8）：块级默认展开/自动展开判定，零 React 依赖。
// 意图（WHY）：P30 的展开逻辑散在 ToolBlock 内部且只覆盖 tool 块；P32 把三类块的
// 默认态统一收敛为纯函数，让「流式 / turn 结束收组 / 历史回看」三种场景共用同一
// 判定，行为一致可单测。

import type { BlockMsg } from "@/acp/message-log";
import { isRiskyCommand } from "@/acp/toolDisplay";

/** 工具块 content 是否含 diff（edit/write 等写操作的标志）。非 tool 块恒 false。 */
export function hasDiff(block: BlockMsg): boolean {
  if (block.kind !== "tool") return false;
  return block.content.some((c) => c.kind === "diff");
}

/** 工具块是否携带危险命令（P36 反馈：rm 等删除类与写操作同属「改用户数据」）。
 *  非 tool 块 / 无 command → false。 */
export function hasRiskyCommand(block: BlockMsg): boolean {
  if (block.kind !== "tool") return false;
  const command = block.rawInput && typeof block.rawInput === "object" && !Array.isArray(block.rawInput)
    ? (block.rawInput as Record<string, unknown>).command
    : undefined;
  return typeof command === "string" && isRiskyCommand(command);
}

/**
 * 块的默认展开态：
 *   - tool：content 含 diff → 展开（写操作默认可见，AC-2.2/2.7）；其余折叠（AC-2.1）
 *   - thought：ms 未落（流式中未 seal）→ 展开；sealed → 折叠（P32 任务一同语义）
 *   - text：正文恒显示，无折叠概念 → false
 */
export function defaultOpen(block: BlockMsg): boolean {
  if (block.kind === "tool") return hasDiff(block);
  if (block.kind === "thought") return block.ms === undefined;
  return false;
}

/**
 * 自动展开边沿（AC-2.3）：prev 无 diff 且 next 有 diff → tool_update 带结果到达，
 * 此时应自动展开。反向边沿（diff 消失）永不自动收起——展开态一旦建立只由用户回收。
 */
export function shouldAutoOpen(prevHasDiff: boolean, nextHasDiff: boolean): boolean {
  return !prevHasDiff && nextHasDiff;
}

/**
 * 活动组卡默认展开态（AC-2.6）：组内任一 tool 块含 diff → 组默认展开（写操作
 * 收组后仍可见）；P36 反馈补：组内任一块携带危险命令（rm 等）同样默认展开——
 * 否则 turn 结束收组后危险命令被折叠藏起，红色警示失去意义。
 * 纯思考/无 diff 无危险工具组默认折叠。turn 结束全量收组时调用。
 */
export function groupDefaultOpen(blocks: BlockMsg[]): boolean {
  return blocks.some((b) => hasDiff(b) || hasRiskyCommand(b));
}
