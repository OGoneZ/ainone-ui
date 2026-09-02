import { describe, it, expect } from "vitest";
import { normPath } from "./normPath";

describe("路径规范化（与 Rust normalize_path 对齐）", () => {
  it("去尾部斜杠", () => {
    expect(normPath("/a/b/")).toBe("/a/b");
    expect(normPath("/a/b")).toBe("/a/b");
  });

  it("大小写不敏感", () => {
    expect(normPath("/Users/Dev")).toBe("/users/dev");
  });

  it("不同路径不同", () => {
    expect(normPath("/a/b")).not.toBe("/a/c");
  });
});
