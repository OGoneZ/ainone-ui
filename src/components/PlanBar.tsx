// 计划栏（P9 · F-9-1）：输入框上方常驻计划面板。
//
// 数据源：store.runtime[tabKey].plan（ACP plan 全量替换，turn 结束清除）。
// 只在「当前 turn 运行中且收到过 plan」时显示（busy && plan != null）。
// 折叠态显示「已完成 N / 共 M」，展开态列条目（三态着色）。

import { useEffect, useState } from "react";
import { useSessionStore } from "../store/sessionStore";
import { planProgress } from "../acp/plan";
import { ChevronRightIcon } from "./ui/icons";

interface Props {
  tabKey: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "已完成",
};

export function PlanBar({ tabKey }: Props) {
  const plan = useSessionStore((s) => s.runtime[tabKey]?.plan ?? null);
  const busy = useSessionStore((s) => s.runtime[tabKey]?.busy ?? false);
  const [open, setOpen] = useState(false);

  // turn 结束 plan 清空 → 折叠复位（下一轮重新展开）
  useEffect(() => {
    if (!plan) setOpen(false);
  }, [plan]);

  if (!busy || !plan || plan.length === 0) return null;

  const { done, total } = planProgress(
    plan.map((p) => ({ content: p.content, status: p.status as "pending" | "in_progress" | "completed" })),
  );

  return (
    <div className="plan-bar">
      <button
        type="button"
        role="button"
        aria-expanded={open}
        className="plan-head"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="inline-flex transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)" }}
        >
          <ChevronRightIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
        </span>
        <span className="plan-summary">
          执行计划 · 已完成 {done} / 共 {total}
        </span>
      </button>
      {open && (
        <ul className="plan-list">
          {plan.map((p, i) => (
            <li key={i} className={`plan-item plan-${p.status}`}>
              <span className="plan-dot" aria-hidden="true" />
              <span className="plan-content">{p.content}</span>
              <span className="plan-status">{STATUS_LABEL[p.status] ?? p.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
