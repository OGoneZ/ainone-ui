import { describe, it, expect } from "vitest";
import { shouldNotify, turnEndBody, USER_CANCELLED, type NotifyDecisionInput } from "./notify";

// P33 AC-P33-5：触发决策矩阵（2026-09-09 调整）。意图——完成/权限等待一律提醒
// （不再看窗口聚焦）；用户自己叫停的不发完成提醒。

const base: NotifyDecisionInput = { reason: "turn_end", windowFocused: false };

describe("shouldNotify（F-32-1）", () => {
  it("turn 正常结束（失焦）→ 发", () => {
    expect(shouldNotify(base)).toEqual({ send: true, why: "turn-end" });
  });

  it("turn 正常结束（聚焦）→ 也发（只要完成就提醒）", () => {
    expect(shouldNotify({ ...base, windowFocused: true })).toEqual({ send: true, why: "turn-end" });
  });

  it("用户主动取消 → 不发（自己叫停的不算完成提醒）", () => {
    expect(shouldNotify({ ...base, stopReason: USER_CANCELLED }).send).toBe(false);
    expect(shouldNotify({ ...base, windowFocused: true, stopReason: USER_CANCELLED }).send).toBe(false);
  });

  it("权限等待（失焦）→ 发（等批准是用户必须回来的事）", () => {
    expect(shouldNotify({ reason: "perm", windowFocused: false })).toEqual({
      send: true,
      why: "perm",
    });
  });

  it("权限等待（聚焦）→ 也发", () => {
    expect(shouldNotify({ reason: "perm", windowFocused: true }).send).toBe(true);
  });

  it("stopReason 缺省（无响应字段）→ 视为正常完成发", () => {
    expect(shouldNotify(base).send).toBe(true);
  });
});

describe("turnEndBody 摘要截断（F-32-1）", () => {
  it("首行原文 ≤60 直用", () => {
    expect(turnEndBody("改完了，3 个文件")).toBe("改完了，3 个文件");
  });

  it("超 60 截断加省略号", () => {
    const long = "a".repeat(61);
    expect(turnEndBody(long)).toBe("a".repeat(60) + "…");
    expect(turnEndBody(long).length).toBe(61);
  });

  it("空正文回退默认提示", () => {
    expect(turnEndBody(undefined)).toBe("任务已完成");
    expect(turnEndBody("   ")).toBe("任务已完成");
  });

  it("取首行之外的缩进已 trim", () => {
    expect(turnEndBody("  hi  ")).toBe("hi");
  });
});
