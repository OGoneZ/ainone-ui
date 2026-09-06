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

describe("buildActivityGroups（p22e 实时总耗时字段）", () => {
  const tw = (text: string, startTs?: number, ms?: number): BlockMsg => ({
    kind: "thought",
    text,
    ...(startTs !== undefined ? { startTs } : {}),
    ...(ms !== undefined ? { ms } : {}),
  });
  const tl = (id: string, status = "completed", startTs?: number, ms?: number): BlockMsg => ({
    kind: "tool",
    toolCallId: id,
    title: `工具${id}`,
    status,
    content: [],
    ...(startTs !== undefined ? { startTs } : {}),
    ...(ms !== undefined ? { ms } : {}),
  });

  it("firstStartTs = 组内第一块 startTs（墙钟起点）", () => {
    const r = buildActivityGroups([tw("想", 1000, 500), tl("a", "completed", 1500, 2000)]);
    const g = r[0] as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.firstStartTs).toBe(1000);
  });

  it("全封口组：endAt = 最后封口块 startTs+ms（墙钟终点，非 ms 之和）", () => {
    // 思考 1000→1500，间隙 5000（text 生成等），工具 6500→10000
    // 墙钟总耗时 = 9000；ms 之和 = 4500（旧口径）——两者不同是本需求的核心
    const r = buildActivityGroups([tw("想", 1000, 500), tl("a", "completed", 6500, 3500)]);
    const g = r[0] as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.endAt).toBe(10000);
    expect(g.running).toBe(false);
  });

  it("运行中 tool 不入组（独立渲染项）→ 组不会以运行中 tool 结尾", () => {
    const r = buildActivityGroups([tw("想", 1000, 500), tl("a", "in_progress", 6500)]);
    const g = r[0] as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.running).toBe(false); // 组内全是封口块
    expect(g.endAt).toBe(1500);
    expect(r).toHaveLength(2); // 运行中 tool 是独立 block 项
    expect(r[1].type).toBe("block");
  });

  it("组尾流式 thought（无 ms）→ running=true", () => {
    const r = buildActivityGroups([tl("a", "completed", 1000, 500), tw("流式思考", 2000)]);
    const g = r[0] as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.running).toBe(true);
  });

  it("旧日志块缺 startTs → firstStartTs/endAt undefined（渲染层回退 ms 之和）", () => {
    const r = buildActivityGroups([tw("旧思考", undefined, 800), tl("a", "completed", undefined, 1200)]);
    const g = r[0] as Extract<RenderItem, { type: "activity_group" }>;
    expect(g.firstStartTs).toBeUndefined();
    expect(g.endAt).toBeUndefined();
    expect(g.ms).toBe(2000); // 旧口径保留
  });
});
