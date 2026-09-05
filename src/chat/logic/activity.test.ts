import { describe, expect, it } from "vitest";
import { buildActivityGroups, type RenderItem } from "./activity";
import type { BlockMsg } from "@/acp/message-log";

const t = (id: string, status = "completed", ms?: number): BlockMsg => ({
  kind: "tool",
  toolCallId: id,
  title: `工具${id}`,
  status,
  content: [],
  ...(ms !== undefined ? { ms } : {}),
});
const th = (text: string, ms?: number): BlockMsg => ({ kind: "thought", text, ...(ms !== undefined ? { ms } : {}) });
const tx = (text: string): BlockMsg => ({ kind: "text", text });

const count = (items: RenderItem[], type: RenderItem["type"]) =>
  items.filter((i) => i.type === type).length;

describe("buildActivityGroups（F-12-3，DEC-36）", () => {
  it("连续已完成 tool 合并为一组", () => {
    const r = buildActivityGroups([t("a"), t("b"), t("c")]);
    expect(r).toHaveLength(1);
    const g = r[0] as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.tools).toBe(3);
    expect(g.thoughts).toBe(0);
    expect(g.blocks).toHaveLength(3);
  });

  it("thought + tool 混合连续段：分别计数、ms 累加", () => {
    const r = buildActivityGroups([th("想1", 1200), t("a"), th("想2", 800), t("b")]);
    expect(r).toHaveLength(1);
    const g = r[0] as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.thoughts).toBe(2);
    expect(g.tools).toBe(2);
    expect(g.ms).toBe(2000);
  });

  it("F-16-2（DEC-49）：组耗时 = 思考 + 工具全段", () => {
    const r = buildActivityGroups([th("想", 2000), t("a", "completed", 5000)]);
    expect(r).toHaveLength(1);
    const g = r[0] as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.ms).toBe(7000);
  });

  it("F-16-2：工具无 ms（旧日志/运行中）按 0 计不参与累加", () => {
    const r = buildActivityGroups([t("a"), t("b", "completed", 1500)]);
    const g = r[0] as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.ms).toBe(1500);
  });

  it("text 块截断分组", () => {
    const r = buildActivityGroups([t("a"), tx("正文"), t("b")]);
    expect(r).toHaveLength(3);
    expect(count(r, "activity_group")).toBe(2);
    expect(count(r, "block")).toBe(1);
  });

  it("运行中 tool 不入组（独立渲染）", () => {
    const r = buildActivityGroups([t("a"), t("b", "in_progress")]);
    expect(count(r, "block")).toBe(1);
    expect(count(r, "activity_group")).toBe(1);
    const g = r.find((i) => i.type === "activity_group") as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.tools).toBe(1);
  });

  it("运行中 thought 保持可见（独立渲染）", () => {
    // 流式中 thought 无 ms → 视为运行中？规格：运行中的 thought = 无 ms 且 turn 未结束。
    // 渲染层约定：无 ms 的 thought 仍入组（历史回填无 ms 常见），运行中判定由 UI 层“流式末块不分组”实现。
    const r = buildActivityGroups([th("流式思考"), t("a")]);
    expect(r).toHaveLength(1);
    expect(count(r, "activity_group")).toBe(1);
  });

  it("空数组 → 空渲染项", () => {
    expect(buildActivityGroups([])).toEqual([]);
  });

  it("全 text → 全部独立", () => {
    const r = buildActivityGroups([tx("a"), tx("b")]);
    expect(count(r, "block")).toBe(2);
  });

  it("纯函数：不修改输入数组", () => {
    const input = [t("a"), tx("x"), t("b")];
    buildActivityGroups(input);
    expect(input).toHaveLength(3);
  });
});
