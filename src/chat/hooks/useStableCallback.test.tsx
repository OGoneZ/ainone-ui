// @vitest-environment jsdom
// P43：useStableCallback 语义锁定。
// 意图：MessageLine/BlockView 的 memo 只在「回调 prop 引用稳定」时才生效。
// 本 hook 必须同时满足两点，缺一即失效或被击穿：
//   1. 引用恒定——否则 memo 没有意义（等于没写）；
//   2. 实现最新——否则回调读到过期闭包（stale closure），是正确性 bug。
// 两者互相拉扯，故逐条锁定。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useState } from "react";
import { useStableCallback } from "./useStableCallback";

afterEach(() => cleanup());

/** 宿主：捕获 hook 返回值，并暴露一个无关状态以驱动重渲染（模拟 ChatPanel 每帧提交） */
function Harness({ onRender, value }: { onRender: (fn: (n: number) => number) => void; value: number }) {
  const cb = useStableCallback((n: number) => n + value);
  onRender(cb);
  return null;
}

describe("useStableCallback", () => {
  it("多次重渲染下返回引用恒定（memo 生效的前提）", () => {
    const seen: Array<(n: number) => number> = [];
    const { rerender } = render(<Harness onRender={(f) => seen.push(f)} value={1} />);
    rerender(<Harness onRender={(f) => seen.push(f)} value={2} />);
    rerender(<Harness onRender={(f) => seen.push(f)} value={3} />);

    expect(seen.length).toBe(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });

  it("调用的是最新一次渲染的实现（无 stale closure）", () => {
    const seen: Array<(n: number) => number> = [];
    const { rerender } = render(<Harness onRender={(f) => seen.push(f)} value={10} />);
    rerender(<Harness onRender={(f) => seen.push(f)} value={20} />);

    // 引用同一个（首帧那个），但结果必须按最新的 value 计算
    expect(seen[1]).toBe(seen[0]);
    expect(seen[0](1)).toBe(21);
  });

  it("参数原样透传给最新实现", () => {
    const calls: number[][] = [];
    let fn: (...a: number[]) => void = () => {};
    function Host({ v }: { v: number }) {
      fn = useStableCallback((...a: number[]) => {
        calls.push(a);
        void v;
      });
      return null;
    }
    const { rerender } = render(<Host v={1} />);
    rerender(<Host v={2} />);

    fn(7, 8, 9);
    expect(calls).toEqual([[7, 8, 9]]);
  });

  it("卸载后调用不抛错（闭包仍指向最后一次实现）", () => {
    const spy = vi.fn(() => 42);
    let fn: (() => number) | null = null;
    function Host() {
      fn = useStableCallback(spy);
      return null;
    }
    const { unmount } = render(<Host />);
    unmount();
    expect(() => act(() => void fn?.())).not.toThrow();
  });

  it("宿主 state 变化引起重渲染时，回调仍可安全触发重渲染（不进入无限循环）", () => {
    const seen: Array<() => void> = [];
    function Host() {
      const [n, setN] = useState(0);
      const cb = useStableCallback(() => setN((v) => v + 1));
      seen.push(cb);
      return <span data-testid="n">{n}</span>;
    }
    const { getByTestId } = render(<Host />);
    act(() => seen[0]());
    act(() => seen[0]());
    expect(getByTestId("n").textContent).toBe("2");
    // 引用恒定：两次调用用的是同一个函数对象
    expect(seen[0]).toBe(seen[1]);
  });
});
