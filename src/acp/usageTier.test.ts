import { describe, expect, it } from "vitest";
import { usageTier } from "./metadata";

describe("usageTier（F-12-6a，DEC-39 三态着色阈值）", () => {
  it("边界：79 ok / 80 warn / 99 warn / 100 danger / 110 danger", () => {
    expect(usageTier({ used: 79, size: 100, cost: null })).toBe("ok");
    expect(usageTier({ used: 80, size: 100, cost: null })).toBe("warn");
    expect(usageTier({ used: 99, size: 100, cost: null })).toBe("warn");
    expect(usageTier({ used: 100, size: 100, cost: null })).toBe("danger");
    expect(usageTier({ used: 110, size: 100, cost: null })).toBe("danger");
  });

  it("0 用量 → ok；size=0 → ok（视为无数据不上色）", () => {
    expect(usageTier({ used: 0, size: 100, cost: null })).toBe("ok");
    expect(usageTier({ used: 50, size: 0, cost: null })).toBe("ok");
  });
});
