// P35 R1：clampQuickAnchor 视口自适应单测。
// 业务意义：悬浮窗是用户选词后唯一的解释入口，越界即「功能不可达」——
// 右缘/下缘选中（长公式、代码行尾部是高频场景）必须自动收回可视区。

import { describe, expect, it } from "vitest";
import { clampQuickAnchor, QUICK_POP_MARGIN } from "./quickPopClamp";

const CONTAINER = { width: 800, height: 600 };
const POP = { width: 300, height: 200 };

describe("clampQuickAnchor", () => {
  it("AC1.1 右下角溢出 → 收回到容器内（右/下均留 margin）", () => {
    const out = clampQuickAnchor({ x: 700, y: 500 }, POP, CONTAINER);
    expect(out.x).toBeLessThanOrEqual(CONTAINER.width - POP.width - QUICK_POP_MARGIN);
    expect(out.y).toBeLessThanOrEqual(CONTAINER.height - POP.height - QUICK_POP_MARGIN);
    // 语义：右缘 700 < 800-300-8=492 → x 应被压到 492
    expect(out.x).toBe(CONTAINER.width - POP.width - QUICK_POP_MARGIN);
    expect(out.y).toBe(CONTAINER.height - POP.height - QUICK_POP_MARGIN);
  });

  it("AC1.2 容器内正常位置不动（不无谓跳动）", () => {
    const out = clampQuickAnchor({ x: 10 + POP.width + QUICK_POP_MARGIN, y: 10 + POP.height + QUICK_POP_MARGIN }, POP, CONTAINER);
    expect(out).toEqual({ x: 10 + POP.width + QUICK_POP_MARGIN, y: 10 + POP.height + QUICK_POP_MARGIN });
  });

  it("AC1.2 边缘 clamp：坐标低于 margin → 抬到 margin", () => {
    expect(clampQuickAnchor({ x: 2, y: 0 }, POP, CONTAINER)).toEqual({ x: QUICK_POP_MARGIN, y: QUICK_POP_MARGIN });
  });

  it("AC1.2 宽度超限（负空间）→ 贴 margin 下限而非负数", () => {
    // 悬浮窗 300 宽 vs 容器 100 宽：maxX 收敛为 margin，CSS max-width(72vw) 兜底实际宽度
    const out = clampQuickAnchor({ x: 50, y: 50 }, { width: 300, height: 100 }, { width: 100, height: 600 });
    expect(out.x).toBe(QUICK_POP_MARGIN);
    expect(out.y).toBe(50); // y 轴未超限（600-100-8=492），不动
  });

  it("AC1.1 只有单轴溢出时另一轴不动", () => {
    const out = clampQuickAnchor({ x: 100, y: 550 }, POP, CONTAINER);
    expect(out.x).toBe(100);
    expect(out.y).toBe(CONTAINER.height - POP.height - QUICK_POP_MARGIN);
  });
});
