// 元数据侧栏纯函数单测：extractUsage / extractModel / usagePercent（AC-P8-22）。

import { describe, it, expect } from "vitest";
import { extractUsage, extractModel, usagePercent, stripModelSuffix, extractSessionModel } from "./metadata";

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

// —— P29 R3：会话级模型提取 + [1m] 后缀剥离 ——

describe("stripModelSuffix", () => {
  it("去 [1m] 后缀", () => {
    expect(stripModelSuffix("saver/glm-5.3-flash[1m]")).toBe("saver/glm-5.3-flash");
  });

  it("无后缀原样返回", () => {
    expect(stripModelSuffix("duo-king-6.6")).toBe("duo-king-6.6");
  });

  it("null 安全", () => {
    expect(stripModelSuffix(null)).toBeNull();
  });
});

describe("extractSessionModel", () => {
  it("category=model 的 select 项 → currentValue", () => {
    expect(
      extractSessionModel([
        { category: "mode", type: "select", currentValue: "default" },
        { category: "model", type: "select", currentValue: "anthropic/claude-opus-4-8" },
      ]),
    ).toBe("anthropic/claude-opus-4-8");
  });

  it("[1m] 后缀剥离", () => {
    expect(
      extractSessionModel([
        { category: "model", type: "select", currentValue: "saver/glm-5.3-flash[1m]" },
      ]),
    ).toBe("saver/glm-5.3-flash");
  });

  it("无 model 项 / boolean 项 / 空数组 → null（不编造值）", () => {
    expect(extractSessionModel([])).toBeNull();
    expect(extractSessionModel([{ category: "mode", type: "select", currentValue: "plan" }])).toBeNull();
    expect(extractSessionModel([{ category: "model", type: "boolean", currentValue: true }])).toBeNull();
    expect(extractSessionModel(null)).toBeNull();
  });

  // —— 展示名取 name（ACP 规范：value=标识符、name=Human-readable name to display）——

  it("网关别名：展示 name 而非 value（第三方覆盖场景，2026-09-10 实测结构）", () => {
    // claude-code + ANTHROPIC_DEFAULT_OPUS_MODEL 指向第三方模型时：
    // currentValue=opus（别名），name 才是真实模型 —— 显示 value 会误导用户
    expect(
      extractSessionModel([
        {
          category: "model",
          type: "select",
          currentValue: "opus",
          options: [
            { value: "default", name: "Default (recommended)", description: "deepseek/deepseek-v4-flash" },
            { value: "opus", name: "deepseek/deepseek-v4-flash", description: "Custom Opus model" },
          ],
        },
      ]),
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("官方原生：展示 name（Agent 指定的展示标签，规范如此）", () => {
    expect(
      extractSessionModel([
        {
          category: "model",
          type: "select",
          currentValue: "opus[1m]",
          options: [
            { value: "default", name: "Default (recommended)" },
            { value: "opus[1m]", name: "Opus (1M context)" },
          ],
        },
      ]),
    ).toBe("Opus (1M context)");
  });

  it("分组形态 options（SessionConfigSelectGroup[]）也能取到展示名", () => {
    // ACP 规范允许 options 为 {groupId, name, options:[...]} 分组数组
    expect(
      extractSessionModel([
        {
          category: "model",
          type: "select",
          currentValue: "model-2",
          options: [
            { groupId: "a", name: "Provider A", options: [{ value: "model-1", name: "Model 1" }] },
            { groupId: "b", name: "Provider B", options: [{ value: "model-2", name: "Model 2" }] },
          ],
        },
      ]),
    ).toBe("Model 2");
  });

  it("选中值不在选项里（恢复会话运行选择器外模型）→ 回退 currentValue", () => {
    expect(
      extractSessionModel([
        {
          category: "model",
          type: "select",
          currentValue: "out-of-picker-model",
          options: [{ value: "opus", name: "Opus" }],
        },
      ]),
    ).toBe("out-of-picker-model");
  });

  it("选项缺 name / options 缺省 → 回退 currentValue 不崩", () => {
    expect(
      extractSessionModel([{ category: "model", type: "select", currentValue: "m-1" }]),
    ).toBe("m-1");
    expect(
      extractSessionModel([
        { category: "model", type: "select", currentValue: "m-1", options: [{ value: "m-1" }] },
      ]),
    ).toBe("m-1");
  });
});
