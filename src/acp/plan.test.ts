// extractPlan / planProgress 单测：全量替换 / 空 entries / 未知 status（AC-P9-4）。

import { describe, it, expect } from "vitest";
import { extractPlan, planProgress } from "./plan";

describe("extractPlan", () => {
  it("正常：提取 content + status + priority", () => {
    const r = extractPlan({
      entries: [
        { content: "分析需求", status: "completed", priority: "high" },
        { content: "写代码", status: "in_progress", priority: "medium" },
      ],
    });
    expect(r).toEqual([
      { content: "分析需求", status: "completed", priority: "high" },
      { content: "写代码", status: "in_progress", priority: "medium" },
    ]);
  });

  it("空 entries / null → 空数组", () => {
    expect(extractPlan(null)).toEqual([]);
    expect(extractPlan({ entries: [] })).toEqual([]);
    expect(extractPlan({})).toEqual([]);
  });

  it("未知 status → 归 pending；非 string content 跳过", () => {
    const r = extractPlan({
      entries: [
        { content: "a", status: "weird" },
        { content: 123, status: "pending" },
      ],
    });
    expect(r).toEqual([{ content: "a", status: "pending", priority: undefined }]);
  });

  it("全量替换语义：entries 整体覆盖（无增量合并）", () => {
    // 两次调用结果互不影响——纯函数无状态
    const r1 = extractPlan({ entries: [{ content: "x", status: "pending" }] });
    const r2 = extractPlan({ entries: [{ content: "y", status: "completed" }] });
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r2[0].content).toBe("y");
  });
});

describe("planProgress", () => {
  it("统计 done/total", () => {
    const entries = [
      { content: "a", status: "completed" as const },
      { content: "b", status: "in_progress" as const },
      { content: "c", status: "pending" as const },
    ];
    expect(planProgress(entries)).toEqual({ done: 1, total: 3 });
  });

  it("空 → 0/0", () => {
    expect(planProgress([])).toEqual({ done: 0, total: 0 });
  });
});
