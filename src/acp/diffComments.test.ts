import { describe, expect, it } from "vitest";
import { composeDiffComments, type DiffComment } from "./diffComments";

describe("composeDiffComments（F-12-5，DEC-38）", () => {
  it("单条：路径:行号 + 行内容 + 评论", () => {
    const c: DiffComment[] = [
      { path: "/w/a.ts", line: 12, lineText: "const x = 1;", comment: "这里命名不对" },
    ];
    expect(composeDiffComments(c)).toBe(
      "[diff 评论 1] /w/a.ts:12\nconst x = 1;\n评论：这里命名不对\n---",
    );
  });

  it("多条：序号递增拼接", () => {
    const cs: DiffComment[] = [
      { path: "/w/a.ts", line: 1, lineText: "a", comment: "c1" },
      { path: "/w/b.ts", line: 2, lineText: "b", comment: "c2" },
    ];
    const out = composeDiffComments(cs);
    expect(out).toContain("[diff 评论 1] /w/a.ts:1");
    expect(out).toContain("[diff 评论 2] /w/b.ts:2");
    expect(out).toContain("评论：c1");
    expect(out).toContain("评论：c2");
  });

  it("新文件（line=0）不带行号", () => {
    const c: DiffComment[] = [{ path: "/w/new.ts", line: 0, lineText: "import x", comment: "缺 license" }];
    expect(composeDiffComments(c)).toBe("[diff 评论 1] /w/new.ts\nimport x\n评论：缺 license\n---");
  });

  it("空行内容（新文件无上下文）→ 省略行内容段", () => {
    const c: DiffComment[] = [{ path: "/w/new.ts", line: 0, lineText: "", comment: "整体看下" }];
    expect(composeDiffComments(c)).toBe("[diff 评论 1] /w/new.ts\n评论：整体看下\n---");
  });

  it("空集 → 空串", () => {
    expect(composeDiffComments([])).toBe("");
  });
});
