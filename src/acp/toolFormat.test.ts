// P11 F-R6：工具输出格式化纯函数测试（looksLikeJson / prettyJson）。
// 意图：工具 text 内容自动识别 JSON 并 pretty 化，其余文本绝不被误改。

import { describe, it, expect } from "vitest";
import { looksLikeJson, prettyJson } from "./toolFormat";

describe("looksLikeJson", () => {
  it("合法 JSON 对象/数组 → true", () => {
    expect(looksLikeJson('{"a":1}')).toBe(true);
    expect(looksLikeJson('  [1,2,3]  ')).toBe(true);
    expect(looksLikeJson('{"nested":{"deep":[1,{"x":null}]}}')).toBe(true);
  });

  it("标量与普通文本 → false（保守判定，不误伤日志）", () => {
    expect(looksLikeJson("42")).toBe(false);
    expect(looksLikeJson('"just a string"')).toBe(false);
    expect(looksLikeJson("npm error code E404")).toBe(false);
    expect(looksLikeJson("key: {value} 混合文本")).toBe(false);
    expect(looksLikeJson('{"broken": ')).toBe(false);
    expect(looksLikeJson("")).toBe(false);
  });
});

describe("prettyJson", () => {
  it("JSON → 2 空格缩进 pretty 输出", () => {
    expect(prettyJson('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });

  it("非法文本 → null（回退原样路径）", () => {
    expect(prettyJson("plain log line")).toBeNull();
    expect(prettyJson('{"broken":')).toBeNull();
  });

  it("自定义缩进", () => {
    expect(prettyJson('{"a":1}', 4)).toBe('{\n    "a": 1\n}');
  });
});
