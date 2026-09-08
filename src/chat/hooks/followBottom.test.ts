// P32 AC-3.x：followBottom 纯逻辑测试——注入 DOM stub + 手动帧调度，全路径可测。
// 意图（WHY）：流式不跟随曾是「功能缺失」而非竞态；跟随/接管/恢复的每条状态迁移
// 都对应一个实机体感场景（AC-3.1~3.7），逻辑必须与 DOM 解耦才能确定性验证。

import { describe, it, expect } from "vitest";
import { createFollowBottom, NEAR_BOTTOM_PX, PROGRAMMATIC_GUARD_MS } from "./followBottom";

/** 滚动容器 stub：scrollHeight/scrollTop/clientHeight 可控 */
function makeScroller(initial: { height: number; top: number; client: number }) {
  const state = { ...initial };
  return {
    el: {
      get scrollHeight() { return state.height; },
      set scrollTop(v: number) { state.top = Math.min(v, state.height); },
      get scrollTop() { return state.top; },
      get clientHeight() { return state.client; },
    } as HTMLElement,
    grow(by: number) { state.height += by; },
    setTop(v: number) { state.top = v; },
    metrics: state,
  };
}

/** 手动帧调度：schedule 收集回调，flush 执行全部；cancel 真实移除 */
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
    flush() {
      const cbs = queue.splice(0, queue.length);
      for (const cb of cbs) cb();
    },
    pending: () => queue.length,
  };
}

function setup(opts?: {
  nearBottomPx?: number;
  initial?: { height: number; top: number; client: number };
  clock?: { t: number };
}) {
  const clock = opts?.clock ?? { t: 1_000_000 };
  const frame = manualFrame();
  const scroller = makeScroller(
    opts?.initial ?? { height: 10_000, top: 10_000 - 600, client: 600 },
  );
  const controller = createFollowBottom({
    getScroller: () => scroller.el,
    nearBottomPx: opts?.nearBottomPx,
    scheduleFrame: frame.scheduleFrame,
    now: () => clock.t,
  });
  return { controller, frame, scroller, clock };
}

describe("AC-3.1 跟随：following 时内容增高推底", () => {
  it("onContentGrow → 帧内 scrollTop 推到 scrollHeight", () => {
    const { controller, frame, scroller } = setup();
    expect(controller.isFollowing()).toBe(true);
    scroller.grow(500); // 流式 append 内容增高
    controller.onContentGrow();
    frame.flush();
    expect(scroller.el.scrollTop).toBe(scroller.metrics.height - scroller.metrics.client);
    expect(controller.bottomGap()).toBe(0);
  });

  it("同帧多次增高合并为一次推底（rAF 合帧）", () => {
    const { controller, frame, scroller } = setup();
    scroller.grow(100);
    controller.onContentGrow();
    scroller.grow(100);
    controller.onContentGrow();
    expect(frame.pending()).toBe(1); // 帧内合并
    frame.flush();
    expect(scroller.el.scrollTop).toBe(scroller.metrics.height - scroller.metrics.client);
  });
});

describe("AC-3.2 接管：wheel 向上停止跟随", () => {
  it("onWheel(-n) → following=false，此后增高不再推底", () => {
    const { controller, frame, scroller } = setup();
    controller.onWheel(-120);
    expect(controller.isFollowing()).toBe(false);
    scroller.grow(500);
    controller.onContentGrow();
    frame.flush();
    expect(scroller.metrics.top).toBeLessThan(scroller.el.scrollHeight); // 未被推底
  });

  it("wheel 向下（追看新内容）不改变接管态", () => {
    const { controller } = setup();
    controller.onWheel(-120);
    controller.onWheel(50);
    expect(controller.isFollowing()).toBe(false);
  });
});

describe("AC-3.3 恢复：滚回近底自动恢复跟随", () => {
  it("接管后手动滚回 gap ≤ 阈值 → onScroll 恢复 following", () => {
    const { controller, frame, scroller } = setup();
    controller.onWheel(-120);
    expect(controller.isFollowing()).toBe(false);
    // 用户手动滚到底部
    scroller.setTop(scroller.metrics.height - scroller.metrics.client);
    controller.onScroll();
    expect(controller.isFollowing()).toBe(true);
    // 恢复后流式增高继续推底
    scroller.grow(300);
    controller.onContentGrow();
    frame.flush();
    expect(scroller.el.scrollTop).toBe(scroller.metrics.height - scroller.metrics.client);
  });
});

describe("AC-3.4 回底按钮：scrollToBottom 强制回底并恢复", () => {
  it("接管态点击 → 滚到底 + following=true + 双 rAF 校底", () => {
    const { controller, frame, scroller } = setup();
    controller.onWheel(-120);
    scroller.grow(1000);
    controller.scrollToBottom();
    expect(controller.isFollowing()).toBe(true);
    frame.flush();
    frame.flush(); // 双 rAF 校底
    expect(scroller.el.scrollTop).toBe(scroller.metrics.height - scroller.metrics.client);
  });
});

describe("AC-3.5 程序滚动守卫", () => {
  it("跟随推底后的守卫窗口内 scroll 事件不误判/不干扰", () => {
    const { controller, frame, scroller, clock } = setup();
    scroller.grow(200);
    controller.onContentGrow();
    frame.flush(); // 推底发生，lastProgrammaticAt = clock.t
    expect(controller.isFollowing()).toBe(true);
    // 守卫窗口内 scroll 回声：不改变 following
    clock.t += PROGRAMMATIC_GUARD_MS - 1;
    scroller.setTop(0); // 极端：某实现下 scroll 事件在窗口内触发
    controller.onScroll();
    expect(controller.isFollowing()).toBe(true);
  });

  it("守卫窗口外滚回近底仍恢复跟随", () => {
    const { controller, scroller, clock } = setup();
    controller.onWheel(-120);
    scroller.setTop(scroller.metrics.height - scroller.metrics.client);
    clock.t += PROGRAMMATIC_GUARD_MS + 1;
    controller.onScroll();
    expect(controller.isFollowing()).toBe(true);
  });
});

describe("AC-3.6 发送新消息强制回底", () => {
  it("接管态 submit → scrollToBottom 恢复跟随并推底", () => {
    const { controller, frame, scroller } = setup();
    controller.onWheel(-120);
    scroller.grow(400);
    controller.scrollToBottom(); // submit 路径调用
    expect(controller.isFollowing()).toBe(true);
    frame.flush();
    expect(scroller.metrics.top).toBe(scroller.metrics.height - scroller.metrics.client);
  });
});

describe("AC-3.7 高度突变（diff 展开/收起）", () => {
  it("following 时容器高度跳变经 onContentGrow → 视口贴底", () => {
    const { controller, frame, scroller } = setup();
    // diff 块展开：内容突增 3000px
    scroller.grow(3000);
    controller.onContentGrow();
    frame.flush();
    expect(controller.bottomGap()).toBe(0);
    // diff 块收起：内容缩回，贴底语义不变（scrollTop 钳制在合法范围）
    scroller.grow(-2500);
    controller.onContentGrow();
    frame.flush();
    expect(controller.bottomGap()).toBe(0);
  });
});

describe("边界与阈值", () => {
  it("NEAR_BOTTOM_PX 默认 64，与现有 atBottom 阈值一致", () => {
    expect(NEAR_BOTTOM_PX).toBe(64);
  });

  it("onPress：距底很远时按下视为接管；近底按下不影响", () => {
    const { controller } = setup();
    controller.onPress(); // 初始贴底（top=height-client → gap=0）
    expect(controller.isFollowing()).toBe(true);
    const far = setup({ initial: { height: 10_000, top: 2_000, client: 600 } });
    far.controller.onPress();
    expect(far.controller.isFollowing()).toBe(false);
  });

  it("scroller 为 null（未挂载）时各事件安全", () => {
    const frame = manualFrame();
    const controller = createFollowBottom({
      getScroller: () => null,
      scheduleFrame: frame.scheduleFrame,
    });
    expect(() => {
      controller.onScroll();
      controller.onWheel(-1);
      controller.onPress();
      controller.onContentGrow();
      frame.flush();
      controller.scrollToBottom();
    }).not.toThrow();
    expect(controller.bottomGap()).toBe(0);
  });

  it("dispose 后不残留帧回调", () => {
    const { controller, frame, scroller } = setup();
    scroller.grow(100);
    controller.onContentGrow();
    expect(frame.pending()).toBe(1);
    controller.dispose();
    frame.flush();
    expect(scroller.metrics.top).toBe(9400); // 未推底（初始 10000-600，grow 100 后最大值 9900 仍未到）
  });
});
