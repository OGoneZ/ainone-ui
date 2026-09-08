// streamCommitThrottle 防回归测试（P31 性能，2026-09-08 事故）：
// 每条 ACP update 直通 store 提交（8 条/s × 全量重渲染）曾把 WebKit 主线程
// 钉死。节流器保证：帧内合并提交、事件不丢（commit 的是 caller 累积快照）、
// flush 收口终态、dispose 清理 pending。
//
// 注入 scheduleFrame 是本测试的关键：真实 rAF 由浏览器帧驱动不可控，注入
// 手动帧即可确定性验证「N 条事件只触发 1 次 commit」。

import { describe, it, expect, vi } from "vitest";
import { createStreamCommitThrottle } from "./streamCommitThrottle";

/** 手动帧调度：测试内自行决定何时触发回调 */
function manualFrame() {
  const queue: Array<() => void> = [];
  return {
    scheduleFrame: (cb: () => void) => {
      queue.push(cb);
      return () => {
        const i = queue.indexOf(cb);
        if (i >= 0) queue.splice(i, 1);
      };
    },
    tick: () => {
      const fns = queue.splice(0);
      fns.forEach((f) => f());
    },
    pending: () => queue.length,
  };
}

describe("streamCommitThrottle", () => {
  it("帧内多条 schedule 只提交一次（合并是本体的存在意义）", () => {
    const frame = manualFrame();
    const commit = vi.fn();
    const t = createStreamCommitThrottle(commit, frame.scheduleFrame);

    t.schedule();
    t.schedule();
    t.schedule();
    expect(commit).not.toHaveBeenCalled();
    expect(frame.pending()).toBe(1); // 只有一个帧回调在排队

    frame.tick();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("跨帧：每帧最多一次提交，帧帧继续（流式持续期间的稳态）", () => {
    const frame = manualFrame();
    const commit = vi.fn();
    const t = createStreamCommitThrottle(commit, frame.scheduleFrame);

    // 模拟 5 帧 × 每帧 3 条 update
    for (let f = 0; f < 5; f++) {
      for (let i = 0; i < 3; i++) t.schedule();
      frame.tick();
    }
    // 15 条事件 → 5 次提交（不是 15 次），事件→渲染次数解耦达成
    expect(commit).toHaveBeenCalledTimes(5);
  });

  it("flush 提交帧内未落的快照并撤销 pending 回调", () => {
    const frame = manualFrame();
    const commit = vi.fn();
    const t = createStreamCommitThrottle(commit, frame.scheduleFrame);

    t.schedule();
    expect(frame.pending()).toBe(1);
    t.flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(frame.pending()).toBe(0); // pending 已撤销，之后 tick 不会二次提交
    frame.tick();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("flush 无 pending 时是 no-op（不产生多余提交）", () => {
    const frame = manualFrame();
    const commit = vi.fn();
    const t = createStreamCommitThrottle(commit, frame.scheduleFrame);
    t.flush();
    expect(commit).not.toHaveBeenCalled();
  });

  it("dispose 撤销 pending 且不再提交（卸载/异常收口防泄漏）", () => {
    const frame = manualFrame();
    const commit = vi.fn();
    const t = createStreamCommitThrottle(commit, frame.scheduleFrame);

    t.schedule();
    t.dispose();
    expect(frame.pending()).toBe(0);
    frame.tick();
    expect(commit).not.toHaveBeenCalled();
  });

  it("scheduleFrame 注入的 cancel 生效（dispose 走的是注入的取消通道）", () => {
    const cancel = vi.fn();
    const t = createStreamCommitThrottle(vi.fn(), (cb) => {
      void cb;
      return cancel;
    });
    t.schedule();
    t.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("事故场景回放：8 条/s 持续 48s（模拟 396 条）→ 提交次数 ≈ 帧数而不是事件数", () => {
    const frame = manualFrame();
    const commit = vi.fn();
    const t = createStreamCommitThrottle(commit, frame.scheduleFrame);

    const FRAMES = 60; // 测试规模：60 帧
    const EVENTS = 396; // 事故实测事件总量
    const perFrame = Math.ceil(EVENTS / FRAMES);
    let sent = 0;
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < perFrame && sent < EVENTS; i++, sent++) t.schedule();
      frame.tick();
    }
    t.flush();
    // 提交次数 ≤ 帧数（60），远小于事件数（396）——渲染与事件到达率解耦
    //（末帧事件不足 perFrame 时该帧早已提交过 → 实际 57，语义仍正确）
    expect(commit.mock.calls.length).toBeLessThanOrEqual(FRAMES);
    expect(commit.mock.calls.length).toBeGreaterThanOrEqual(FRAMES - perFrame);
    expect(commit.mock.calls.length).toBeLessThan(EVENTS);
  });
});
