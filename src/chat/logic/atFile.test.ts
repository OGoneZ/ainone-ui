import { describe, it, expect } from "vitest";
import { detectAtToken, flattenWorkspaceFiles, filterAtFiles, applyAtToken } from "./atFile";

describe("detectAtToken", () => {
  it("行首 @ 触发", () => {
    expect(detectAtToken("@", 1)).toEqual({ query: "", start: 0, end: 1 });
    expect(detectAtToken("@re", 3)).toEqual({ query: "re", start: 0, end: 3 });
  });

  it("空白后 @ 触发", () => {
    expect(detectAtToken("看下 @src", 8)).toEqual({ query: "src", start: 3, end: 8 });
  });

  it("词中 @ 不触发（邮箱）", () => {
    expect(detectAtToken("a@b", 3)).toBeNull();
  });

  it("token 内含空白不触发（@ 前有非空白字符）", () => {
    expect(detectAtToken("hello @w", 8)).toEqual({ query: "w", start: 6, end: 8 });
  });

  it("空文本 / caret 0 不触发", () => {
    expect(detectAtToken("", 0)).toBeNull();
  });
});

describe("flattenWorkspaceFiles", () => {
  const cwd = "/w";
  const tree = {
    "/w": [
      { name: "src", is_dir: true },
      { name: "README.md", is_dir: false },
    ],
    "src": [
      { name: "a.ts", is_dir: false },
      { name: "lib", is_dir: true },
    ],
    "src/lib": [{ name: "x.ts", is_dir: false }],
  };

  it("递归扁平化 + rel/abs 正确", () => {
    const files = flattenWorkspaceFiles(cwd, tree);
    const rels = files.map((f) => f.rel);
    expect(rels).toContain("src");
    expect(rels).toContain("src/a.ts");
    expect(rels).toContain("src/lib/x.ts");
    expect(rels).toContain("README.md");
    const x = files.find((f) => f.rel === "src/lib/x.ts")!;
    expect(x.abs).toBe("/w/src/lib/x.ts");
    expect(x.isDir).toBe(false);
  });
});

describe("filterAtFiles", () => {
  const files = [
    { rel: "src/fuzzy.ts", abs: "/w/src/fuzzy.ts", isDir: false },
    { rel: "docs", abs: "/w/docs", isDir: true },
    { rel: "README.md", abs: "/w/README.md", isDir: false },
  ];

  it("空查询保留原序", () => {
    expect(filterAtFiles(files, "")).toHaveLength(3);
  });

  it("fuzzy 命中：目录优先", () => {
    const out = filterAtFiles(files, "fzy");
    expect(out.map((f) => f.rel)).toContain("src/fuzzy.ts");
  });

  it("无命中为空", () => {
    expect(filterAtFiles(files, "zzz")).toEqual([]);
  });
});

describe("applyAtToken", () => {
  it("替换 @ token 为 @file: 绝对路径 + 尾空格", () => {
    const token = { query: "re", start: 3, end: 6 };
    const out = applyAtToken("看下 @re 这", token, { rel: "README.md", abs: "/w/README.md", isDir: false });
    expect(out).toBe("看下 @file:/w/README.md  这");
  });
});
