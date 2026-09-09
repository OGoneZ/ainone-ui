// P37 R2：速率器登记表——runPrompt 创建的 StreamRate 按 tabKey 暴露给末条
// MessageLine 读取。
//
// 为什么不进 zustand store（P32 R2 教训）：速率每秒变，若走 sessionSignals
// 编码投影或 runtime 字段，App（侧栏全部行 + flexlayout 树）按秒全量重渲染。
// 速率只属于「末条消息 × 流式进行中」这一个渲染点——模块级 Map<tabKey, ref>
// 是最窄通道：MessageLine 末条实例局部订阅（1s interval 读 display()），其余
// 组件零感知。
//
// Map 生命周期：runPrompt 每轮覆盖 entry；面板卸载（ChatPanel unmount cleanup）
// 删除 entry。会话数有限，无泄漏面。

import type { StreamRate } from "./streamRate";

const registry = new Map<string, { current: StreamRate | null }>();

export function rateStoreOf(tabKey: string): { current: StreamRate | null } {
  let ref = registry.get(tabKey);
  if (!ref) {
    ref = { current: null };
    registry.set(tabKey, ref);
  }
  return ref;
}

export function rateStoreDrop(tabKey: string): void {
  registry.delete(tabKey);
}

/** 测试隔离：清空登记表 */
export function rateStoreClear(): void {
  registry.clear();
}
