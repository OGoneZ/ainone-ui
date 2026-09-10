// 稳定回调（P43）：返回引用恒定的回调，内部始终调用「最近一次渲染传入的实现」。
//
// 背景：MessageLine / BlockView 用 React.memo（默认浅比较）跳过历史行的重渲染，
// 但 ChatPanel 的 doFork / askRewind / startEdit / addDiffComment 是普通函数声明
// 或内联箭头——每次渲染都是新引用，props 浅比较失败 → memo 恒失效 → 流式期间
// 视口内全部可见行每帧重跑 reconcile，并连带每帧重算 ActivityGroupCard 的文件
// 变更 Myers diff（diff@9，单个大文件可达毫秒级）。
//
// 本 hook 是仓内既有惯例的提取：ensureSessionRef / voiceToggleRef 手写的正是
// 「最新实现存 ref，对外暴露稳定壳」这一模式（ChatPanel.tsx「建链去重」一段）。
//
// 为什么不用「自定义 memo 比较器忽略函数 prop」：那会让子组件停留在旧闭包上，
// 是 stale closure（回调读到过期的 state/props），比多渲染一次更危险。
//
// 实现要点：ref 在 effect 中更新而非渲染期——React 保证任何用户事件处理函数
// 触发前，前一次渲染的 passive effect 已 flush，故事件回调读到的必是最新实现；
// 同时避免「渲染期写 ref」的副作用（StrictMode 双渲染下语义不明）。

import { useCallback, useEffect, useRef } from "react";

export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
