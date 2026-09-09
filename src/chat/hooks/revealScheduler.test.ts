// P35 R2：揭示覆盖切分 + 调度器单测。
// 意图：pacer 的揭示前缀必须按块边界正确映射回 blocks——完整揭示的块引用
// 不变（Streamdown memo 命中），部分揭示的尾块取剩余，未揭示的置空；
// 调度器在积压未清时自持帧时钟（空窗期揭示不停滞），flush 收口终态。

import { describe, it, expect, vi } from "vitest";
import { overlayRevealedText } from "./overlayRevealed";
import { createRevealScheduler } from "./revealScheduler";
import { createStreamPacer } from "./streamPacer";
import type { BlockMsg } from "@/acp/message-log";

const text = (t: string): BlockMsg => ({ kind: "text", text: t });
const tool = (id: string): BlockMsg => ({ kind: "tool", toolCallId: id, title: id, status: "completed", content: [] });

describe("overlayRevealedText（P35 R2 揭示覆盖）", () => {
  it("全部揭示 → 返回原数组（引用稳定，Streamdown memo 命中）", () => {
    const blocks = [text("你好"), tool("t1"), text("第二段")];
    expect(overlayRevealedText(blocks, "你好第二段")).toBe(blocks);
  });

  it("部分揭示 → 尾块取剩余，tool 块原样，未揭示块置空", () => {
    const blocks = [text("你好世界"), tool("t1"), text("第二段内容")];
    const out = overlayRevealedText(blocks, "你好世");
    expect(out).not.toBe(blocks);
    expect(out[0]).toEqual({ kind: "text", text: "你好世" });
    expect(out[1]).toBe(blocks[1]); // tool 块引用不变
    expect(out[2]).toEqual({ kind: "text", text: "" }); // 未揭示置空
  });

  it("跨块揭示：第一块完整（引用不变），第二块部分", () => {
    const blocks = [text("abc"), text("defgh")];
    const out = overlayRevealedText(blocks, "abcd");
    expect(out[0]).toBe(blocks[0]); // 完整揭示 → 原引用
    expect(out[1]).toEqual({ kind: "text", text: "d" });
  });

  it("revealed 为空 → 全部 text 置空（tool 原样）", () => {
    const blocks = [text("abc"), tool("t1")];
    const out = overlayRevealedText(blocks, "");
    expect(out[0]).toEqual({ kind: "text", text: "" });
    expect(out[1]).toBe(blocks[1]);
  });

  it("无 text 块 → 原数组返回", () => {
    const blocks = [tool("t1"), tool("t2")];
    expect(overlayRevealedText(blocks, "xyz")).toBe(blocks);
  });
});

describe("createRevealScheduler（P35 R2 自持揭示时钟）", () => {
  /** 手动帧调度 + 手动时钟 */
  function manual() {
    const queue: Array<() => void> = [];
    let t = 0;
    return {
      scheduleFrame: (cb: () => void) => {
        queue.push(cb);
        return () => {
          const i = queue.indexOf(cb);
          if (i >= 0) queue.splice(i, 1);
        };
      },
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
      runFrame: () => {
        const fns = queue.splice(0);
        fns.forEach((f) => f());
      },
      pending: () => queue.length,
    };
  }

  it("kick → 帧内 tick+commit；积压未清自动排下一帧（自持循环）", () => {
    const m = manual();
    const pacer = createStreamPacer({}, m.now);
    const commit = vi.fn();
    const sched = createRevealScheduler(pacer, commit, m.scheduleFrame, m.now);
    pacer.onChunk("这是一段足够长的文本让 pacer 一帧揭示不完所以需要自持排帧继续揭示");
    sched.kick();
    expect(m.pending()).toBe(1);
    m.advance(40);
    m.runFrame();
    expect(commit).toHaveBeenCalledTimes(1);
    // 揭示未完（30fps 下一帧揭示 ~2-4 字）→ 自动排帧
    expect(m.pending()).toBe(1);
    // 清空积压
    for (let i = 0; i < 200 && m.pending() > 0; i++) {
      m.advance(40);
      m.runFrame();
    }
    expect(pacer.pendingCount()).toBe(0);
    expect(m.pending()).toBe(0); // 积压清空 → 自持停止
    sched.dispose();
  });

  it("空窗期揭示不停滞：事件一次到达后不再 kick，揭示仍持续到清空", () => {
    const m = manual();
    const pacer = createStreamPacer({}, m.now);
    const sched = createRevealScheduler(pacer, vi.fn(), m.scheduleFrame, m.now);
    pacer.onChunk("到达一次后进入长空窗的文本内容，揭示应该持续进行而不是停滞等待下一次事件");
    sched.kick();
    let frames = 0;
    for (let i = 0; i < 300 && m.pending() > 0; i++) {
      m.advance(40);
      m.runFrame();
      frames += 1;
    }
    expect(pacer.pendingCount()).toBe(0);
    expect(frames).toBeGreaterThan(5); // 多帧持续揭示（不是一帧全出）
    sched.dispose();
  });

  it("flush 立即推完积压并提交（终态全文）", () => {
    const m = manual();
    const pacer = createStreamPacer({}, m.now);
    const commit = vi.fn();
    const sched = createRevealScheduler(pacer, commit, m.scheduleFrame, m.now);
    pacer.onChunk("终态验证文本");
    sched.kick();
    sched.flush();
    expect(pacer.revealedText()).toBe("终态验证文本");
    expect(commit).toHaveBeenCalled();
    expect(m.pending()).toBe(0);
  });

  it("dispose 撤销排队帧（异常收口）", () => {
    const m = manual();
    const pacer = createStreamPacer({}, m.now);
    const commit = vi.fn();
    const sched = createRevealScheduler(pacer, commit, m.scheduleFrame, m.now);
    pacer.onChunk("将被撤销");
    sched.kick();
    sched.dispose();
    expect(m.pending()).toBe(0);
    m.advance(40);
    m.runFrame();
    expect(commit).not.toHaveBeenCalled();
  });
});
