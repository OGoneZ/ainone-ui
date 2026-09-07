// F-12-2 结构化提问卡：把 agent 的提问请求组装为可回传的答案文本（DEC-36 同路径注入 prompt 通道）。
// 答案以 question 文本为键，与 AionUi MessageQuestion 的应答契约对齐。
//
// P30 elicitation 数据链（ChatPanel handler 的纯逻辑层，可单测防回归）：
//   - 键契约：回传 content 必须以 requestedSchema 的**原始属性键**为键——
//     claude-agent-acp 的 AskUserQuestion 桥把问题渲染为 question_<n>（每题伴随
//     一个 question_<n>_custom 自由填写字段，带 _meta._askUserQuestionCustomAnswer
//     标记），回读按这些键取值；以「问题标题」为键回传会全部 miss，被 harness
//     判定「The user did not answer the questions.」（P30 实测缺陷）。
//   - 渲染与作答（AskCard）仍以标题为键，本层负责两侧映射。

export interface AskQuestion {
  question: string;
  /** 供选择的选项（含 Other 时用户自由输入） */
  options: string[];
  multi: boolean;
}

/** question → 用户答案（多选/Other 为数组；拒绝回答时整组为 null） */
export type AskAnswer = string | string[];

/** 全部作答才可提交（调用方据此禁用按钮） */
export function askComplete(questions: AskQuestion[], answers: Record<string, AskAnswer | undefined>): boolean {
  return questions.every((q) => {
    const a = answers[q.question];
    if (a === undefined) return false;
    if (Array.isArray(a)) return a.length > 0;
    return a.trim().length > 0;
  });
}

/** 答案组装为 prompt 注入文本（确定性，可单测） */
export function composeAskAnswers(
  questions: AskQuestion[],
  answers: Record<string, AskAnswer | undefined>,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const a = answers[q.question];
    const val = Array.isArray(a) ? a.join("、") : (a ?? "").trim();
    lines.push(`问：${q.question}`);
    lines.push(`答：${val || "（未回答）"}`);
  }
  return lines.join("\n");
}

// —— P30：claude-agent-acp AskUserQuestion 桥的 schema 适配（纯函数，可单测）——

/** 桥接器给「Other」自由填写字段打的 _meta 标记键（elicitation.js CUSTOM_ANSWER_META_KEY） */
const CUSTOM_ANSWER_META_KEY = "_askUserQuestionCustomAnswer";

export interface SchemaField {
  /** schema 原始属性键（question_<n> / question_<n>_custom / 通用 harness 的任意键） */
  key: string;
  /** 展示标题（title ?? key） */
  title: string;
  type: string;
  /** 单选枚举（oneOf 的 title/const） */
  oneOf?: string[];
  /** 多选枚举（items.anyOf 的 title/const） */
  anyOf?: string[];
  /** 裸枚举（string 的 enum / 多选 items.enum，通用 MCP form 形态） */
  enumValues?: string[];
  /** 自由填写标记（桥的 question_<n>_custom 字段带此 _meta） */
  isCustomAnswer: boolean;
  /** 自由填写字段归属的问题键（_meta 里带） */
  customFor?: string;
}

/** ElicitationCreateRequest.requestedSchema.properties 的宽松形状（各 harness 不一） */
export type SchemaProperties = Record<string, Record<string, unknown>>;

function toTitles(arr: unknown[]): string[] {
  return arr
    .map((o) => {
      if (typeof o === "string") return o;
      const v = o as { const?: string; title?: string };
      return v.title ?? v.const;
    })
    .filter((t): t is string => typeof t === "string");
}

export function parseSchemaFields(properties: SchemaProperties): SchemaField[] {
  return Object.entries(properties).map(([key, raw]) => {
    const meta = raw._meta as Record<string, unknown> | null | undefined;
    const custom = meta?.[CUSTOM_ANSWER_META_KEY] as
      | { questionId?: string; isCustomAnswer?: boolean }
      | null
      | undefined;
    const oneOf = Array.isArray(raw.oneOf) ? toTitles(raw.oneOf) : undefined;
    const items = raw.items as Record<string, unknown> | undefined;
    const anyOf = items && Array.isArray(items.anyOf) ? toTitles(items.anyOf) : undefined;
    const rawEnum = Array.isArray(raw.enum)
      ? toTitles(raw.enum)
      : items && Array.isArray(items.enum)
        ? toTitles(items.enum)
        : undefined;
    return {
      key,
      title: (typeof raw.title === "string" ? raw.title : "") || key,
      type: typeof raw.type === "string" ? raw.type : "string",
      ...(oneOf ? { oneOf } : {}),
      ...(anyOf ? { anyOf } : {}),
      ...(rawEnum ? { enumValues: rawEnum } : {}),
      isCustomAnswer: custom?.isCustomAnswer === true || typeof custom?.questionId === "string",
      ...(custom?.questionId ? { customFor: custom.questionId } : {}),
    };
  });
}

/** 待回答的一题：AskCard 渲染模型 + 回传所需的 schema 键位 */
export interface AskCardQuestion {
  question: string;
  options: string[];
  multi: boolean;
  /** schema 原始属性键（答案枚举选择的回传键） */
  key: string;
  /** 所属「Other」自由填写字段的键（无则不存在） */
  customKey?: string;
}

/**
 * schema 字段 → AskCard 渲染模型：按**题**分组（custom 字段并入所属题，不再
 * 渲染成独立问题——旧实现把桥的 2 个问题渲染成 4 组的根因）。
 * 无 custom 标记的裸自由字段（无 options 且非 custom）作为独立提问保留（通用 MCP form）。
 */
export function fieldsToQuestions(fields: SchemaField[]): AskCardQuestion[] {
  const out: AskCardQuestion[] = [];
  for (const f of fields) {
    if (f.isCustomAnswer) {
      // Other 字段：并入其归属题（customFor 缺失时挂到最后一题；无题可挂则忽略——
      // 悬空 Other 无从作答，乱归属反而污染答案键）
      const target = f.customFor
        ? out.find((q) => q.key === f.customFor)
        : out.length > 0
          ? out[out.length - 1]
          : undefined;
      if (target) target.customKey = f.key;
      continue;
    }
    if (f.type === "array") {
      out.push({ question: f.title, options: f.anyOf ?? f.enumValues ?? [], multi: true, key: f.key });
    } else if (f.type === "string" && (f.oneOf?.length ?? f.enumValues?.length)) {
      out.push({ question: f.title, options: f.oneOf ?? f.enumValues ?? [], multi: false, key: f.key });
    } else {
      // number/integer/boolean 或裸 string：自由文本（AskCard 以 Other 输入框兜底渲染）
      out.push({ question: f.title, options: [], multi: false, key: f.key });
    }
  }
  return out;
}

/** AskCard 的「其他」前缀（与 AskCard.tsx OTHER + "：" 一致，全角冒号） */
const OTHER_PREFIX = "其他：";

/**
 * 把 AskCard 的作答（以题目标题为键）转回 harness 的 content（以 schema 原始键为键）。
 * - customKey 存在且用户写了自由文本 → 只写 custom 键（对齐 CLI 的 Other 语义：优先于枚举选择）
 * - customKey 存在但选的是枚举选项（或选了其他没写字）→ 只写枚举键 / 两键都不写
 * - 多选：「其他：x」条目拆到 custom 键（桥按字符串读），其余枚举选择走数组键
 * - 文本按 schema 类型转原生值（number/integer→数字，boolean→布尔，H11）
 */
export function answersToContent(
  questions: AskCardQuestion[],
  answers: Record<string, AskAnswer | undefined>,
  propTypes: Record<string, string>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  const byQuestion = new Map(questions.map((q) => [q.question, q]));
  const coerce = (val: string, type: string): unknown => {
    if (type === "number" || type === "integer") {
      const n = Number(val);
      return Number.isFinite(n) ? n : val;
    }
    if (type === "boolean") return val === "true" || val === "是";
    return val;
  };
  for (const [q, a] of Object.entries(answers)) {
    const qd = byQuestion.get(q);
    if (!qd || a === undefined) continue; // 不认识的题/未作答不回传（防键污染）
    const type = propTypes[q] ?? "string";
    if (Array.isArray(a)) {
      const picks = qd.customKey
        ? a.filter((v) => !(typeof v === "string" && v.startsWith(OTHER_PREFIX)))
        : a;
      const custom = qd.customKey
        ? a
            .filter((v) => typeof v === "string" && v.startsWith(OTHER_PREFIX))
            .map((v) => (v as string).slice(OTHER_PREFIX.length).trim())
            .filter(Boolean)
        : [];
      if (qd.customKey && custom.length > 0) content[qd.customKey] = custom.join("，");
      if (picks.length > 0) content[qd.key] = picks;
      continue;
    }
    const customPicked = qd.customKey !== undefined && a.startsWith(OTHER_PREFIX);
    const customText = customPicked ? a.slice(OTHER_PREFIX.length).trim() : "";
    if (qd.customKey && customText !== "") {
      content[qd.customKey] = coerce(customText, type);
    } else if (!customPicked) {
      content[qd.key] = coerce(a, type);
    }
    // 选了其他但未写字 → 两键都不写（视为未作答该题，harness 按缺省处理）
  }
  return content;
}
