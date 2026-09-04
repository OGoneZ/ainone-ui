import { describe, expect, it } from "vitest";
import { askComplete, composeAskAnswers, type AskQuestion } from "./askCard";

const qs: AskQuestion[] = [
  { question: "用哪个方案？", options: ["方案 A", "方案 B"], multi: false },
  { question: "要哪些功能？", options: ["日志", "通知"], multi: true },
];

describe("askCard（F-12-2）", () => {
  it("askComplete：全答 true；缺题/空多选/空白文本 false", () => {
    expect(askComplete(qs, { "用哪个方案？": "方案 A", "要哪些功能？": ["日志"] })).toBe(true);
    expect(askComplete(qs, { "要哪些功能？": ["日志"] })).toBe(false);
    expect(askComplete(qs, { "用哪个方案？": "方案 A", "要哪些功能？": [] })).toBe(false);
    expect(askComplete(qs, { "用哪个方案？": "  ", "要哪些功能？": ["日志"] })).toBe(false);
  });

  it("composeAskAnswers：单选 + 多选顿号连接", () => {
    const out = composeAskAnswers(qs, { "用哪个方案？": "方案 B", "要哪些功能？": ["日志", "通知"] });
    expect(out).toBe("问：用哪个方案？\n答：方案 B\n问：要哪些功能？\n答：日志、通知");
  });

  it("composeAskAnswers：缺答降级「（未回答）」", () => {
    const out = composeAskAnswers(qs, { "用哪个方案？": "方案 A" });
    expect(out).toContain("答：（未回答）");
  });
});
