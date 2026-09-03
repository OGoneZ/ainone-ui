// 元数据侧栏纯函数单测：extractUsage / extractModel / usagePercent（AC-P8-22）。

import { describe, it, expect } from "vitest";
import { extractUsage, extractModel, usagePercent } from "./metadata";

describe("extractUsage", () => {
  it("正常：used/size/cost 全取", () => {
    expect(extractUsage({ used: 100, size: 1000, cost: { amount: 1.5 } })).toEqual({
      used: 100,
      size: 1000,
      cost: 1.5,
    });
  });

  it("缺 cost：cost 为 null", () => {
    expect(extractUsage({ used: 100, size: 1000 })).toEqual({ used: 100, size: 1000, cost: null });
  });

  it("空值：全 0 / null", () => {
    expect(extractUsage(null)).toEqual({ used: 0, size: 0, cost: null });
    expect(extractUsage(undefined)).toEqual({ used: 0, size: 0, cost: null });
  });
});

describe("extractModel", () => {
  it("命中 --model：返回后一个参数", () => {
    expect(extractModel(["acp", "--model", "duo-king-6.6"])).toBe("duo-king-6.6");
  });

  it("无 --model：返回 null", () => {
    expect(extractModel([])).toBeNull();
    expect(extractModel(["acp"])).toBeNull();
  });

  it("--model 在末尾无值：返回 null", () => {
    expect(extractModel(["acp", "--model"])).toBeNull();
  });
});

describe("usagePercent", () => {
  it("正常百分比取整", () => {
    expect(usagePercent({ used: 500, size: 1000, cost: null })).toBe(50);
  });

  it("超过 100 封顶", () => {
    expect(usagePercent({ used: 2000, size: 1000, cost: null })).toBe(100);
  });

  it("size 为 0 防除零", () => {
    expect(usagePercent({ used: 10, size: 0, cost: null })).toBe(0);
  });
});
