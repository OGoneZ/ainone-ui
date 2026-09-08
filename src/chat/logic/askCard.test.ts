import { describe, expect, it } from "vitest";
import {
  answersToContent,
  askComplete,
  composeAskAnswers,
  fieldsToQuestions,
  parseSchemaFields,
  type AskQuestion,
  type SchemaProperties,
} from "./askCard";

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

// —— P30 回归：claude-agent-acp 的 AskUserQuestion 桥 schema 适配 ——
//
// 背景（P30 实测缺陷，勿删）：旧实现以「问题标题」为键回传 content，而桥
// （elicitation.js applyAskElicitationResponse）按 question_<n>[_custom] 原始键
// 回读 → 全 miss → harness 收到 "The user did not answer the questions."；
// 且 per-question Other 字段被当独立问题渲染，2 题变 4 组。

/** 与桥 askUserQuestionsToCreateRequest 输出同构的最小 schema（2 题 + 2 个 Other 字段） */
const bridgeProps: SchemaProperties = {
  question_0: {
    type: "string",
    title: "动效风格",
    description: "Logo 动效选哪种风格？",
    oneOf: [
      { const: "橙格眨眼 + 悬浮 (推荐)", title: "橙格眨眼 + 悬浮 (推荐)", description: "…" },
      { const: "真画眼睛（改图形）", title: "真画眼睛（改图形）", description: "…" },
    ],
  },
  question_0_custom: {
    type: "string",
    title: "Other",
    description: "Type your own answer instead of choosing an option above (optional).",
    _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } },
  },
  question_1: {
    type: "string",
    title: "打字机",
    description: "宣传语打字机用哪种行为？",
    oneOf: [
      { const: "打完停住 + 光标闪 (推荐)", title: "打完停住 + 光标闪 (推荐)", description: "…" },
      { const: "打完删除再重打", title: "打完删除再重打", description: "…" },
    ],
  },
  question_1_custom: {
    type: "string",
    title: "Other",
    description: "…",
    _meta: { _askUserQuestionCustomAnswer: { questionId: "question_1", isCustomAnswer: true } },
  },
};

describe("askCard · P30 elicitation 键契约（防回归）", () => {
  it("parseSchemaFields：提取原始键 + Other 标记 + oneOf 枚举", () => {
    const fields = parseSchemaFields(bridgeProps);
    expect(fields.map((f) => f.key)).toEqual([
      "question_0",
      "question_0_custom",
      "question_1",
      "question_1_custom",
    ]);
    expect(fields[0].isCustomAnswer).toBe(false);
    expect(fields[0].oneOf).toEqual(["橙格眨眼 + 悬浮 (推荐)", "真画眼睛（改图形）"]);
    // Other 字段：isCustomAnswer + 归属 question_0
    expect(fields[1].isCustomAnswer).toBe(true);
    expect(fields[1].customFor).toBe("question_0");
  });

  it("fieldsToQuestions：Other 并入所属题——2 题渲染 2 组（旧实现 4 组的根因）", () => {
    const qs2 = fieldsToQuestions(parseSchemaFields(bridgeProps));
    expect(qs2).toHaveLength(2);
    expect(qs2[0].question).toBe("动效风格");
    expect(qs2[0].key).toBe("question_0");
    expect(qs2[0].customKey).toBe("question_0_custom");
    expect(qs2[1].question).toBe("打字机");
    expect(qs2[1].key).toBe("question_1");
    expect(qs2[1].customKey).toBe("question_1_custom");
  });

  it("answersToContent：以 schema 原始键回传（桥按 question_<n> 回读，标题键会全 miss）", () => {
    const qs2 = fieldsToQuestions(parseSchemaFields(bridgeProps));
    const content = answersToContent(
      qs2,
      { 动效风格: "橙格眨眼 + 悬浮 (推荐)", 打字机: "打完停住 + 光标闪 (推荐)" },
      { 动效风格: "string", 打字机: "string" },
    );
    expect(content).toEqual({
      question_0: "橙格眨眼 + 悬浮 (推荐)",
      question_1: "打完停住 + 光标闪 (推荐)",
    });
    // 回传键绝不包含问题标题（旧缺陷的直接判据）
    expect(Object.keys(content)).not.toContain("动效风格");
  });

  it("answersToContent：写了 Other 自由文本 → 只写 custom 键（对齐 CLI 优先语义）", () => {
    const qs2 = fieldsToQuestions(parseSchemaFields(bridgeProps));
    const content = answersToContent(
      qs2,
      { 动效风格: "其他：闪烁呼吸一体", 打字机: "打完删除再重打" },
      { 动效风格: "string", 打字机: "string" },
    );
    expect(content).toEqual({ question_0_custom: "闪烁呼吸一体", question_1: "打完删除再重打" });
  });

  it("answersToContent：选了「其他」但未写字 → 两键都不写（视为未作答）", () => {
    const qs2 = fieldsToQuestions(parseSchemaFields(bridgeProps));
    const content = answersToContent(qs2, { 动效风格: "其他：" }, { 动效风格: "string" });
    expect(content).toEqual({});
  });

  it("answersToContent：多选拆键——枚举选择走数组键，「其他：x」并入 custom 键", () => {
    const props: SchemaProperties = {
      question_0: {
        type: "array",
        title: "要哪些功能？",
        items: {
          anyOf: [
            { const: "日志", title: "日志" },
            { const: "通知", title: "通知" },
          ],
        },
      },
      question_0_custom: {
        type: "string",
        title: "Other",
        _meta: { _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true } },
      },
    };
    const qs2 = fieldsToQuestions(parseSchemaFields(props));
    expect(qs2[0].multi).toBe(true);
    const content = answersToContent(
      qs2,
      { "要哪些功能？": ["日志", "其他：语音播报"] },
      { "要哪些功能？": "array" },
    );
    expect(content).toEqual({ question_0: ["日志"], question_0_custom: "语音播报" });
  });

  it("answersToContent：number/boolean 按类型转原生值（H11）", () => {
    const props: SchemaProperties = {
      count: { type: "integer", title: "数量" },
      flag: { type: "boolean", title: "开关" },
    };
    const qs2 = fieldsToQuestions(parseSchemaFields(props));
    const content = answersToContent(qs2, { 数量: "3", 开关: "true" }, { 数量: "integer", 开关: "boolean" });
    expect(content).toEqual({ count: 3, flag: true });
  });

  it("通用 MCP form（无 custom 标记）：裸 enum string / items.enum 多选照常解析，未知答案不回传", () => {
    const props: SchemaProperties = {
      color: { type: "string", title: "颜色", enum: ["红", "绿"] },
      tags: { type: "array", title: "标签", items: { enum: ["a", "b"] } },
    };
    const qs2 = fieldsToQuestions(parseSchemaFields(props));
    expect(qs2[0]).toMatchObject({ question: "颜色", options: ["红", "绿"], multi: false });
    expect(qs2[1]).toMatchObject({ question: "标签", options: ["a", "b"], multi: true });
    // 未知题（答案键对不上任何题）防键污染
    const content = answersToContent(qs2, { 颜色: "红", 不存在的题: "x" }, { 颜色: "string" });
    expect(content).toEqual({ color: "红" });
  });
});
