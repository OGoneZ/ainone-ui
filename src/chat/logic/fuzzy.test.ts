import { describe, it, expect } from "vitest";
import { filterFuzzy, filterCommandsFuzzy, filterPathsFuzzy } from "./fuzzy";
import type { CommandWord } from "@/store/sessionStore";

const words: CommandWord[] = [
  { name: "clear", description: "清屏" },
  { name: "compact", description: "压缩" },
  { name: "review-plan", description: "计划" },
  { name: "cost", description: "成本" },
];

describe("filterFuzzy（fuzzysort 封装）", () => {
  it("空查询 → 全部保留，原序，score 0", () => {
    const out = filterFuzzy(words, (w) => w.name, "");
    expect(out.map((x) => x.item.name)).toEqual(["clear", "compact", "review-plan", "cost"]);
    expect(out[0].score).toBe(0);
  });

  it("连续命中（前缀）排最前", () => {
    const out = filterFuzzy(words, (w) => w.name, "cl");
    expect(out[0].item.name).toBe("clear");
  });

  it("子序列命中：cmp → compact", () => {
    const out = filterFuzzy(words, (w) => w.name, "cmp");
    expect(out.map((x) => x.item.name)).toContain("compact");
  });

  it("分隔符后词首命中排前：plan → review-plan", () => {
    const out = filterFuzzy(words, (w) => w.name, "plan");
    expect(out[0].item.name).toBe("review-plan");
  });

  it("无匹配 → 空数组", () => {
    expect(filterFuzzy(words, (w) => w.name, "zzz")).toEqual([]);
  });

  it("同分（浮点误差内）顺序不保证稳定 → 以 score 降序为准", () => {
    // fuzzysort v4 内部用 heap 排序，精确同分不保证稳定；业务上不存在「完全等价
    // 字符串竞争」的真实场景，此处只断言全部命中且分数一致
    const dup = [{ n: "aa1" }, { n: "aa2" }, { n: "aa3" }];
    const out = filterFuzzy(dup, (d) => d.n, "aa");
    expect(out).toHaveLength(3);
    expect(new Set(out.map((x) => x.score)).size).toBe(1);
  });

  it("大小写不敏感", () => {
    expect(filterFuzzy(words, (w) => w.name, "CLR").map((x) => x.item.name)).toContain("clear");
  });
});

describe("filterCommandsFuzzy / filterPathsFuzzy", () => {
  it("命令过滤直通", () => {
    expect(filterCommandsFuzzy(words, "co")[0].name).toMatch(/co/);
  });

  it("路径过滤：fzy 命中 src/fuzzy.ts 类路径", () => {
    const paths = ["src/fuzzy.ts", "docs/plan.md", "README.md"];
    expect(filterPathsFuzzy(paths, "fzy")).toContain("src/fuzzy.ts");
  });
});
