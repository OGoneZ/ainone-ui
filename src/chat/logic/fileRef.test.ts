// composeFileReference 单测：多文件/绝对路径校验/空集（AC-P8-18）。

import { describe, it, expect } from "vitest";
import { isAbsolutePath, composeFileReference, filterAbsoluteFiles } from "./fileRef";

describe("isAbsolutePath", () => {
  it("以 / 开头 = 绝对路径", () => {
    expect(isAbsolutePath("/a/b/c.ts")).toBe(true);
    expect(isAbsolutePath("a/b.ts")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});

describe("composeFileReference", () => {
  it("单文件：@file:/abs/path", () => {
    expect(composeFileReference([{ path: "/a/b.md" }])).toBe("@file:/a/b.md");
  });

  it("多文件：换行拼接", () => {
    expect(composeFileReference([{ path: "/a" }, { path: "/b" }])).toBe("@file:/a\n@file:/b");
  });

  it("空集：输出空串", () => {
    expect(composeFileReference([])).toBe("");
  });
});

describe("filterAbsoluteFiles", () => {
  it("保留绝对路径、丢弃相对路径", () => {
    const out = filterAbsoluteFiles([{ path: "/a" }, { path: "b" }, { path: "/c" }]);
    expect(out).toEqual([{ path: "/a" }, { path: "/c" }]);
  });
});
