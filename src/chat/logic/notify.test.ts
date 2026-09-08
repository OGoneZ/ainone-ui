import { describe, it, expect } from "vitest";
import { shouldNotify, turnEndBody, USER_CANCELLED, type NotifyDecisionInput } from "./notify";

// P32 AC-P32-5：触发决策四态矩阵。意图——防打扰原则下，
// 「失焦 + 非用户取消」才提醒；用户盯着屏幕或自己叫停时保持安静。

const base: NotifyDecisionInput = { reason: "turn_end", windowFocused: false };

describe("shouldNotify（F-32-1）", () => {
  it("失焦 + turn 正常结束 → 发", () => {
    expect(shouldNotify(base)).toEqual({ send: true, why: "unfocused-turn-end" });
  });

  it("聚焦时 turn 结束 → 不发（用户正看着）", () => {
    expect(shouldNotify({ ...base, windowFocused: true }).send).toBe(false);
  });

  it("失焦 + 用户主动取消 → 不发（自己叫停的不算完成提醒）", () => {
    const d = shouldNotify({ ...base, stopReason: USER_CANCELLED });
    expect(d.send).toBe(false);
  });

  it("失焦 + 权限等待 → 发（等批准是用户必须回来的事）", () => {
    expect(shouldNotify({ reason: "perm", windowFocused: false })).toEqual({
      send: true,
      why: "unfocused-perm",
    });
  });

  it("聚焦 + 权限等待 → 不发", () => {
    expect(shouldNotify({ reason: "perm", windowFocused: true }).send).toBe(false);
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
