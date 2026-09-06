// F-21-6 sidebarResize 纯函数单测：方向语义 / clamp 边界 / 上限计算。
// WHY：拖宽方向反了是体验灾难（向左拖变窄），几何语义必须锁定。
import { describe, it, expect } from "vitest";
import { dragWidth, clampWidth, sidebarMaxWidth, type DragState } from "./sidebarResize";

const d: DragState = { startX: 300, startW: 240 };

describe("dragWidth", () => {
  it("右缘把手：向右拖（clientX 增大）= 增宽", () => {
    expect(dragWidth(d, 360, "right", 200, 480)).toBe(300);
  });
  it("右缘把手：向左拖 = 变窄（min=100 不干扰断言）", () => {
    expect(dragWidth(d, 240, "right", 100, 480)).toBe(180);
  });
  it("左缘把手：向左拖（clientX 减小）= 增宽", () => {
    expect(dragWidth(d, 240, "left", 200, 480)).toBe(300);
  });
  it("左缘把手：向右拖 = 变窄（min=100 不干扰断言）", () => {
    expect(dragWidth(d, 360, "left", 100, 480)).toBe(180);
  });
  it("clamp：低于 min / 超过 max 都被夹取", () => {
    expect(dragWidth(d, 1000, "right", 200, 480)).toBe(480);
    expect(dragWidth(d, 0, "right", 200, 480)).toBe(200);
  });
});

describe("clampWidth / sidebarMaxWidth", () => {
  it("clampWidth 夹取到区间", () => {
    expect(clampWidth(100, 200, 480)).toBe(200);
    expect(clampWidth(999, 200, 480)).toBe(480);
    expect(clampWidth(300, 200, 480)).toBe(300);
  });
  it("sidebarMaxWidth：窄窗口取 40%，宽窗口封顶 520", () => {
    expect(sidebarMaxWidth(1000)).toBe(400);
    expect(sidebarMaxWidth(2000)).toBe(520);
  });
});
