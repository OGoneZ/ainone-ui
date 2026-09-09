// P35 R2：揭示覆盖切分——把 pacer 的揭示前缀按块边界映射回 blocks。
//
// 模型：turn 内全部 text 块按序拼接 = 全文 T；pacer.revealedText() = T 的
// 揭示前缀 R（R 永远是 T 的前缀，因为 pacer.onChunk 吃的就是同一 text 流）。
// commit 时用 R 覆盖 blocks 的 text 块：完整被 R 覆盖的块保持原文（引用不变，
// Streamdown memo 命中），增长中的尾块 = R 的剩余部分；R 之外的 text 块（未
// 揭示）置空串。tool/thought 块原样透传（状态即时，不走 pacing）。
//
// 零依赖纯函数，可单测。

import type { BlockMsg } from "@/acp/message-log";

export function overlayRevealedText(blocks: BlockMsg[], revealed: string): BlockMsg[] {
  let pos = 0; // revealed 的消费游标
  let out: BlockMsg[] | null = null; // 惰性拷贝：全部块完整揭示时返回原数组（引用稳定）
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "text") continue;
    if (pos >= revealed.length) {
      // 该块完全未揭示 → 置空（但保留块存在，块序与 tool 边界不变）
      if (!out) out = blocks.slice();
      out[i] = { ...b, text: "" };
      continue;
    }
    const full = b.text;
    if (revealed.length - pos >= full.length) {
      // 本块完整揭示 → 原样保留（引用不变）
      pos += full.length;
      continue;
    }
    // 本块部分揭示 → 尾块取剩余
    const slice = revealed.slice(pos);
    pos = revealed.length;
    if (!out) out = blocks.slice();
    out[i] = { ...b, text: slice };
  }
  return out ?? blocks;
}
