// P36：logger 的 Error 序列化——JSON.stringify(new Error) 恒 "{}"，2026-09-09 崩溃
// 事故中真实错误信息全被吞掉。fmtValue 必须对 Error 输出 message/stack。

import { describe, it, expect } from "vitest";
import { fmtValue, formatReactError } from "./logger";

describe("fmtValue（P36 日志修复）", () => {
  it("Error → name: message + stack（非 {}）", () => {
    const out = fmtValue(new TypeError("boom-x"));
    expect(out).toContain("TypeError: boom-x");
    expect(out).not.toBe("{}");
  });

  it("Error 无 stack 时退化为 name: message", () => {
    const e = new Error("plain");
    e.stack = undefined;
    expect(fmtValue(e)).toBe("Error: plain");
  });

  it("普通对象仍走 JSON 序列化", () => {
    expect(fmtValue({ a: 1 })).toBe('{"a":1}');
  });

  it("不可序列化对象退化为 String()", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(fmtValue(cyc)).toBe("[object Object]");
  });
});

describe("formatReactError（P36 main.tsx 钩子）", () => {
  it("拼出 caught 前缀 + Error 详情 + componentStack", () => {
    const out = formatReactError(new Error("render-fail"), "    at ToolBlock");
    expect(out).toContain("React caught:");
    expect(out).toContain("Error: render-fail");
    expect(out).toContain("at ToolBlock");
  });

  it("非 Error 值不崩", () => {
    expect(formatReactError("str-err")).toContain("str-err");
  });
});
