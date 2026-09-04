import { describe, expect, it } from "vitest";
import { aggregateFileChanges, countDiffLines } from "./fileChanges";

describe("countDiffLines（F-12-4，DEC-37 diff@9 diffLines）", () => {
  it("纯增", () => {
    expect(countDiffLines("a\nb\n", "a\nb\nc\nd\n")).toEqual({ added: 2, removed: 0 });
  });

  it("纯删", () => {
    expect(countDiffLines("a\nb\nc\n", "a\n")).toEqual({ added: 0, removed: 2 });
  });

  it("混合（中间替换）", () => {
    expect(countDiffLines("a\nx\nb\n", "a\ny\nz\nb\n")).toEqual({ added: 2, removed: 1 });
  });

  it("新文件（oldText 为 null/undefined/空）→ 全记 added", () => {
    expect(countDiffLines(null, "l1\nl2\n")).toEqual({ added: 2, removed: 0 });
    expect(countDiffLines(undefined, "l1\n")).toEqual({ added: 1, removed: 0 });
    expect(countDiffLines("", "l1\n")).toEqual({ added: 1, removed: 0 });
  });

  it("相同文本 → 0/0", () => {
    expect(countDiffLines("a\nb\n", "a\nb\n")).toEqual({ added: 0, removed: 0 });
  });

  it("双方皆空 → 0/0", () => {
    expect(countDiffLines("", "")).toEqual({ added: 0, removed: 0 });
  });
});

describe("aggregateFileChanges（同路径合并）", () => {
  it("同路径两次修改合并、行数累加，保持首次出现顺序", () => {
    const r = aggregateFileChanges([
      { path: "/w/a.ts", oldText: "a\n", newText: "a\nb\n" },
      { path: "/w/b.ts", oldText: "x\ny\n", newText: "x\n" },
      { path: "/w/a.ts", oldText: "a\nb\n", newText: "c\n" },
    ]);
    // 第二次修改 a,b→c：removed 2、added 1（diffLines 实际分块）
    expect(r).toEqual([
      { path: "/w/a.ts", added: 1 + 1, removed: 0 + 2 },
      { path: "/w/b.ts", added: 0, removed: 1 },
    ]);
  });

  it("空集 → 空", () => {
    expect(aggregateFileChanges([])).toEqual([]);
  });
});
