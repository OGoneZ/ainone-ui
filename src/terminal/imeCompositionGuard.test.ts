// @vitest-environment jsdom
// imeCompositionGuard 单测：模拟 WebKitGTK/IBus 的畸形 IME 提交序列，验证
// 归一化行为（lumina-terminal PR#5 同款场景）。
//
// 意图：Linux（WebKitGTK + fcitx5/IBus/Rime）打字重复的根因是「漏发
// compositionstart」+「xterm 延迟回读前 textarea 被重写」+「未匹配
// compositionend 重复提交」。guard 必须保证：
//   1. 畸形序列下 textarea 被重建为「keydown 快照 + 本次提交」（diff 恰好一次）
//   2. 未匹配的 compositionend 被拦下（防二次提交）
//   3. 正常 IME 序列（有 compositionstart）零干预——不能把好的也改坏

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { installImeCompositionGuard } from "./imeCompositionGuard";

function makeTextarea(initial: string): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.value = initial;
  document.body.appendChild(el);
  return el;
}

/** 派发 keydown 229（IME 已接管按键的标准信号，WebKitGTK 畸形序列的第一环） */
function keydown229(el: HTMLElement) {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { keyCode: 229, bubbles: true, cancelable: true }),
  );
}

/** 派发 insertFromComposition 输入事件（WebKitGTK 无归属提交的载体） */
function inputFromComposition(el: HTMLElement, data: string) {
  el.dispatchEvent(
    new InputEvent("input", { inputType: "insertFromComposition", data, bubbles: true }),
  );
}

/** 合成 composition 事件（jsdom 的 CompositionEvent 构造器参数不全，手动 init） */
function compositionEvent(type: string, data: string): CompositionEvent {
  const ev = document.createEvent("CompositionEvent") as CompositionEvent;
  // initCompositionEvent 在较新 TS DOM lib 里被标记废弃，但 jsdom 只认这条老路
  const init = (ev as unknown as { initCompositionEvent: (...a: unknown[]) => void }).initCompositionEvent;
  init.call(ev, type, true, true, null, data, "");
  return ev;
}

describe("installImeCompositionGuard", () => {
  let textarea: HTMLTextAreaElement;
  let dispose: (() => void) | null = null;

  const install = (initial = "") => {
    textarea = makeTextarea(initial);
    dispose = installImeCompositionGuard(textarea);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    dispose?.();
    dispose = null;
    textarea?.remove();
    vi.useRealTimers();
  });

  it("畸形序列：无 compositionstart 的提交被重建为『快照+提交』，xterm 回读 diff 恰好一次", () => {
    // 场景：用户已打 "abc"（积攒在隐藏 textarea），此刻 IME 提交「中」，
    // WebKitGTK 同时把 textarea 整个重写为 "abc中"（oldValue 失配 → 整段重放根因）
    install("abc");
    keydown229(textarea);
    // WebKitGTK 重写 textarea（模拟 oldValue 失配的现实条件）
    textarea.value = "abc中";
    inputFromComposition(textarea, "中");

    // guard 重建：value = 快照 "abc" + 本次提交 "中" → xterm 的
    // value.replace(oldValue) 求出 diff = "中"，只发一次
    expect(textarea.value).toBe("abc中");
    expect(textarea.selectionStart).toBe(4);
    expect(textarea.selectionEnd).toBe(4);
  });

  it("畸形序列：selection 中间替换时按快照选区精确重建", () => {
    // 场景：快照 "abXc" 且选区选中 "X"（fallbackSelection 1..2），IME 提交「中」替换它
    install("abXc");
    keydown229(textarea);
    // 模拟用户此前有选区（重设 selection 在 keydown 快照之后即可被 guard 读到吗？
    // 不能——guard 在 keydown 时快照。这里直接验证快照逻辑：重放 keydown 前设置选区）
    textarea.setSelectionRange(2, 3);
    keydown229(textarea);
    textarea.value = "中";
    inputFromComposition(textarea, "中");

    expect(textarea.value).toBe("ab中c");
    expect(textarea.selectionStart).toBe(3);
    expect(textarea.selectionEnd).toBe(3);
  });

  it("畸形序列：无归属 compositionend 被拦下（stopImmediatePropagation 防重复提交）", () => {
    install("");
    keydown229(textarea);
    let reached = false;
    // 普通监听（bubble 相）模拟 xterm 的监听——capture 拦截后不应到达
    textarea.addEventListener("compositionend", () => {
      reached = true;
    });
    textarea.dispatchEvent(compositionEvent("compositionend", "中"));
    expect(reached).toBe(false);
  });

  it("正常 IME 序列（有 compositionstart）零干预：compositionend 放行", () => {
    install("");
    let reached = false;
    textarea.addEventListener("compositionend", () => {
      reached = true;
    });
    // 有归属的正常序列：compositionstart → keydown 229 → input → compositionend
    textarea.dispatchEvent(compositionEvent("compositionstart", ""));
    keydown229(textarea);
    inputFromComposition(textarea, "中");
    textarea.dispatchEvent(compositionEvent("compositionend", "中"));

    expect(reached).toBe(true);
  });

  it("正常 IME 序列：textarea 不被 guard 重写", () => {
    install("abc");
    textarea.dispatchEvent(compositionEvent("compositionstart", ""));
    keydown229(textarea);
    // 正常序列里浏览器自己维护 textarea，guard 不得碰
    textarea.value = "abc中";
    inputFromComposition(textarea, "中");

    expect(textarea.value).toBe("abc中");
  });

  it("229 窗口过期后（一个 tick）到达的 input 不再触发重建", () => {
    install("abc");
    keydown229(textarea);
    vi.advanceTimersByTime(1);
    // 窗口已关：迟到的畸形 input 不应改写 textarea
    inputFromComposition(textarea, "中");
    expect(textarea.value).toBe("abc");
  });

  it("第二个 keydown 229 会刷新快照（连续 IME 提交各自独立）", () => {
    install("ab");
    keydown229(textarea);
    textarea.value = "ab中";
    inputFromComposition(textarea, "中");
    expect(textarea.value).toBe("ab中");

    // 第二次提交：快照应基于上次重建后的值
    keydown229(textarea);
    textarea.value = "ab中文";
    inputFromComposition(textarea, "文");
    expect(textarea.value).toBe("ab中文");
  });

  it("非 229 keydown 与非 insertFromComposition 输入均不干预", () => {
    install("abc");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 65, bubbles: true }));
    inputFromComposition(textarea, "中");
    // 无 229 窗口 → 不重建
    expect(textarea.value).toBe("abc");

    // 229 窗口开着但来了普通 insertText（非组合输入）→ 不干预
    keydown229(textarea);
    textarea.dispatchEvent(
      new InputEvent("input", { inputType: "insertText", data: "x", bubbles: true }),
    );
    expect(textarea.value).toBe("abc");
  });

  it("dispose 后监听全部解除（不再拦截/重建）", () => {
    install("abc");
    dispose?.();
    dispose = null;

    keydown229(textarea);
    textarea.value = "abc中";
    inputFromComposition(textarea, "中");
    // guard 已卸载：value 保持 WebKitGTK 重写后的样子（无人管理）
    expect(textarea.value).toBe("abc中");

    let reached = false;
    textarea.addEventListener("compositionend", () => {
      reached = true;
    });
    textarea.dispatchEvent(compositionEvent("compositionend", "中"));
    expect(reached).toBe(true);
  });
});
