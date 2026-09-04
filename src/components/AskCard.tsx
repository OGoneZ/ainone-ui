// F-12-2 结构化提问交互卡（AskCard）：
// agent 的结构化提问渲染为可交互卡片（单选/多选/Other/拒绝），
// 全部作答才可提交，提交后显示「已回答」态；拒绝走 reject 语义。
//
// 视觉遵循 F-12-6b 灵动规范（悬浮卡 + 入场动画，CSS 类在 App.css）。
// 交互经 radix-ui（RadioGroup/Checkbox，ui/radio-group、ui/checkbox 薄封装）。

import { useMemo, useState } from "react";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import {
  askComplete,
  composeAskAnswers,
  type AskAnswer,
  type AskQuestion,
} from "../chat/logic/askCard";

const OTHER = "其他";

export function AskCard({
  questions,
  onAnswer,
  onDecline,
}: {
  questions: AskQuestion[];
  /** 提交：answers 以 question 文本为键 */
  onAnswer: (answers: Record<string, AskAnswer>) => void;
  /** 拒绝回答（整体 decline） */
  onDecline: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, AskAnswer | undefined>>({});
  const [answered, setAnswered] = useState(false);

  const complete = useMemo(() => askComplete(questions, draft), [questions, draft]);

  function submit() {
    if (!complete || answered) return;
    onAnswer(draft as Record<string, AskAnswer>);
    setAnswered(true);
  }

  function decline() {
    if (answered) return;
    onDecline();
    setAnswered(true);
  }

  return (
    <div className="ask-card" data-testid="ask-card" data-answered={answered ? "true" : "false"}>
      {questions.map((q) => (
        <div key={q.question} className="ask-question">
          <div className="ask-question-text">{q.question}</div>
          {q.multi ? (
            <MultiOptions
              q={q}
              value={(draft[q.question] as string[] | undefined) ?? []}
              onChange={(v) => setDraft((d) => ({ ...d, [q.question]: v }))}
              disabled={answered}
            />
          ) : (
            <SingleOptions
              q={q}
              value={(draft[q.question] as string | undefined) ?? ""}
              onChange={(v) => setDraft((d) => ({ ...d, [q.question]: v }))}
              disabled={answered}
            />
          )}
        </div>
      ))}
      {answered ? (
        <div className="ask-answered" data-testid="ask-answered">
          已回答
        </div>
      ) : (
        <div className="ask-actions">
          <Button variant="outline" size="sm" onClick={decline} aria-label="拒绝回答">
            拒绝回答
          </Button>
          <Button size="sm" disabled={!complete} onClick={submit} aria-label="提交回答">
            提交
          </Button>
        </div>
      )}
    </div>
  );
}

function SingleOptions({
  q,
  value,
  onChange,
  disabled,
}: {
  q: AskQuestion;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const isOther = value.startsWith(OTHER);
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => (v === OTHER ? onChange(OTHER + "：") : onChange(v))}
      disabled={disabled}
    >
      {q.options.map((opt) => (
        <label key={opt} className="ask-option">
          <RadioGroupItem value={opt} />
          <span>{opt}</span>
        </label>
      ))}
      <label className="ask-option">
        <RadioGroupItem value={OTHER} />
        <span>{OTHER}</span>
      </label>
      {isOther && (
        <input
          className="ask-other-input"
          aria-label="其他（自由填写）"
          autoFocus
          value={value.slice(OTHER.length + 1)}
          onChange={(e) => onChange(OTHER + "：" + e.target.value)}
          disabled={disabled}
        />
      )}
    </RadioGroup>
  );
}

function MultiOptions({
  q,
  value,
  onChange,
  disabled,
}: {
  q: AskQuestion;
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
}) {
  const otherPicked = value.some((v) => v.startsWith(OTHER));
  function toggle(opt: string) {
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  }
  return (
    <div className="ask-multi">
      {q.options.map((opt) => (
        <label key={opt} className="ask-option">
          <Checkbox
            checked={value.includes(opt)}
            onCheckedChange={() => toggle(opt)}
            disabled={disabled}
          />
          <span>{opt}</span>
        </label>
      ))}
      <label className="ask-option">
        <Checkbox
          checked={otherPicked}
          onCheckedChange={() =>
            onChange(otherPicked ? value.filter((v) => !v.startsWith(OTHER)) : [...value, OTHER + "："])
          }
          disabled={disabled}
        />
        <span>{OTHER}</span>
      </label>
      {otherPicked && (
        <input
          className="ask-other-input"
          aria-label="其他（自由填写）"
          autoFocus
          value={value.find((v) => v.startsWith(OTHER))?.slice(OTHER.length + 1) ?? ""}
          onChange={(e) =>
            onChange([...value.filter((v) => !v.startsWith(OTHER)), OTHER + "：" + e.target.value])
          }
          disabled={disabled}
        />
      )}
    </div>
  );
}

/** 供上层把答案组装为 prompt 注入文本 */
export { composeAskAnswers };
