import { describe, expect, it } from "vitest";
import { usagePercent, usageTier } from "./usageBar";

describe("usageTier（F-12-6a，DEC-39）", () => {
  it("边界：79 ok / 80 warn / 99 warn / 100 danger / 110 danger", () => {
    expect(usageTier(79, 100)).toBe("ok");
    expect(usageTier(80, 100)).toBe("warn");
    expect(usageTier(99, 100)).toBe("warn");
    expect(usageTier(100, 100)).toBe("danger");
    expect(usageTier(110, 100)).toBe("danger");
  });

  it("0 用量 → ok；size=0 → ok（不上报视为无数据）", () => {
    expect(usageTier(0, 100)).toBe("ok");
    expect(usageTier(50, 0)).toBe("ok");
  });
});

describe("usagePercent", () => {
  it("常规换算 + 上限 100 封顶", () => {
    expect(usagePercent(50, 200)).toBe(25);
    expect(usagePercent(110, 100)).toBe(100);
    expect(usagePercent(10, 0)).toBe(0);
  });
});
