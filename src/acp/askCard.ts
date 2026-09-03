// F-12-2 结构化提问卡：把 agent 的提问请求组装为可回传的答案文本（DEC-36 同路径注入 prompt 通道）。
// 答案以 question 文本为键，与 AionUi MessageQuestion 的应答契约对齐。

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
