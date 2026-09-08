// P32 自动滚动跟随（AC-3.x）：流式输出贴底 + 用户接管 + 回底恢复。
// 自实现而非 use-stick-to-bottom：后者自管滚动容器模式与本仓 tanstack-virtual
// 的 getScrollElement 不兼容（规格 0.3 已论证）。骨架参照 AionUi useAutoScroll：
// 近底判定 + 用户手势接管 + 内容增高事件驱动 + 程序滚动守卫，全部逻辑可注入测试。

export interface FollowBottomController {
  /** 当前是否处于跟随模式 */
  isFollowing(): boolean;
  /** 事件接线：容器 scroll（被动监听） */
  onScroll(): void;
  /** 事件接线：wheel（用户滚轮/触控板）——deltaY<0 向上即接管 */
  onWheel(deltaY: number): void;
  /** 事件接线：按下（mousedown/touchstart——WKWebView 原生点击无 pointerdown） */
  onPress(): void;
  /** 内容增高通知（ResizeObserver 回调）：following 时 rAF 合帧推底 */
  onContentGrow(): void;
  /** 强制回底（发送新消息/点回底按钮）：滚到底并恢复 following */
  scrollToBottom(): void;
  /** 距底像素（供按钮显隐等外部消费） */
  bottomGap(): number;
  dispose(): void;
}

export interface FollowBottomOptions {
  /** 滚动容器（注入以便测试） */
  getScroller: () => HTMLElement | null;
  /** 近底阈值：gap ≤ 该值视为贴底 */
  nearBottomPx?: number;
  /** 程序滚动守卫时长：跟随动作自身引起的 scroll 事件在该窗口内不触发接管 */
  programmaticGuardMs?: number;
  /** 帧调度注入（默认 rAF；测试可同步/手动驱动） */
  scheduleFrame?: (cb: () => void) => () => void;
  /** 时间源注入（测试可控） */
  now?: () => number;
}

export const NEAR_BOTTOM_PX = 64;
export const PROGRAMMATIC_GUARD_MS = 150;

export function createFollowBottom(options: FollowBottomOptions): FollowBottomController {
  const {
    getScroller,
    nearBottomPx = NEAR_BOTTOM_PX,
    programmaticGuardMs = PROGRAMMATIC_GUARD_MS,
    scheduleFrame = defaultScheduleFrame,
    now = () => Date.now(),
  } = options;

  let following = true;
  let lastProgrammaticAt = 0;
  let frameCancel: (() => void) | null = null;

  const gap = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

  /** 跟随动作：scrollTop 推到最大值（scrollHeight - clientHeight），并盖守卫时间戳 */
  const pin = () => {
    const el = getScroller();
    if (!el) return;
    lastProgrammaticAt = now();
    el.scrollTop = el.scrollHeight - el.clientHeight;
  };

  return {
    isFollowing: () => following,

    onScroll() {
      const el = getScroller();
      if (!el) return;
      const g = gap(el);
      // 程序滚动守卫窗口内的 scroll 事件（跟随动作自身的回声）不参与判定
      if (now() - lastProgrammaticAt < programmaticGuardMs) return;
      if (g <= nearBottomPx) {
        // 用户手动滚回近底 → 恢复跟随（DeepChat/AionUi 同语义）
        following = true;
      }
      // gap > 阈值：可能是接管（用户上翻）也可能是跟随中内容增高后的瞬时状态
      // ——后者由 onContentGrow 下一帧重新推底，此处不做接管判定（scroll 不作为接管信号）
    },

    onWheel(deltaY: number) {
      // 向上滚动意图 → 立即接管（比 scroll 事件更早、不被程序滚动守卫干扰）
      if (deltaY < 0) following = false;
    },

    onPress() {
      // 按下不立即接管：可能是点击消息内按钮/链接。DeepChat 用手势生命周期；
      // 简化：按下时若距底很远则视为接管意图（点击行为本身不依赖 following）
      const el = getScroller();
      if (!el) return;
      if (gap(el) > nearBottomPx) following = false;
    },

    onContentGrow() {
      if (!following) return;
      if (frameCancel) return; // 本帧已排队
      frameCancel = scheduleFrame(() => {
        frameCancel = null;
        if (!following) return;
        pin();
      });
    },

    scrollToBottom() {
      following = true;
      pin();
      // 双 rAF 校底：测量修正后 scrollHeight 变化，再推一次（jumpToIndex 同型先例）
      scheduleFrame(() => {
        pin();
        scheduleFrame(() => pin());
      });
    },

    bottomGap() {
      const el = getScroller();
      return el ? gap(el) : 0;
    },

    dispose() {
      if (frameCancel) {
        frameCancel();
        frameCancel = null;
      }
    },
  };
}

function defaultScheduleFrame(cb: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}
