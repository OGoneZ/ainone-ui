// turn 转换纯逻辑：把 ACP Outgoing 事件流累加成一个 assistant turn 的 blocks。
// 零 Tauri 依赖（DEC-10 可单测），ChatPanel 与 bun e2e 探针共用（DEC-8）。
//
// 职责：只做「块的结构合并」+「thinking 计时封口」，时间经 now() 注入（测试可控）。
//   - agent_text / agent_thought 流式 chunk → 相邻同类块合并（appendText/appendThought）
//   - tool_call → appendTool；tool_update → 按 toolCallId 定位改写
//   - thought 段开始记时，首个正文/工具或 turn 结束 → sealLastThought 落定「已思考 N 秒」

import type { Outgoing } from "./session-core";
import {
  appendText,
  appendThought,
  appendTool,
  updateTool,
  sealLastThought,
  type BlockMsg,
} from "./message-log";

export interface TurnAccumulator {
  blocks: BlockMsg[];
  /** 进行中 thought 段的开始时间戳；0 = 无进行中 thought */
  thoughtStart: number;
  /** P16b：turn 首个事件的时间戳（总耗时计时起点；0 = 尚无事件） */
  turnStart: number;
}

export function newTurn(): TurnAccumulator {
  return { blocks: [], thoughtStart: 0, turnStart: 0 };
}

function seal(acc: TurnAccumulator, now: () => number): TurnAccumulator {
  if (acc.thoughtStart === 0) return acc;
  return {
    blocks: sealLastThought(acc.blocks, now() - acc.thoughtStart),
    thoughtStart: 0,
    turnStart: acc.turnStart,
  };
}

export function applyEvent(
  acc: TurnAccumulator,
  e: Outgoing,
  now: () => number,
): TurnAccumulator {
  // P16b：turn 首个事件落定总耗时起点（后续事件不改）
  const withStart = acc.turnStart === 0 ? { ...acc, turnStart: now() } : acc;
  switch (e.type) {
    case "agent_text": {
      const s = seal(withStart, now);
      return { ...s, blocks: appendText(s.blocks, e.text) };
    }
    case "agent_thought": {
      const start = withStart.thoughtStart === 0 ? now() : withStart.thoughtStart;
      return { ...withStart, thoughtStart: start, blocks: appendThought(withStart.blocks, e.text) };
    }
    case "tool_call": {
      const s = seal(withStart, now);
      return {
        ...s,
        blocks: appendTool(s.blocks, {
          kind: "tool",
          toolCallId: e.toolCallId,
          title: e.title,
          status: e.status ?? "pending",
          content: e.content,
          // F-16-2（DEC-49）：记起始时间戳，收尾封口耗时
          startTs: now(),
        }),
      };
    }
    case "tool_update":
      // now 注入：status 到终态时封口工具耗时 ms
      return { ...withStart, blocks: updateTool(withStart.blocks, e.toolCallId, e.status ?? null, e.content, now) };
    case "turn_stop":
      return seal(withStart, now);
    default:
      // available_commands / error 不改变 turn 内容
      return acc;
  }
}
