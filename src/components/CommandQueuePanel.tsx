// 命令队列面板（P9 · F-9-3）：输入框上方（计划栏之下，DEC-19）待执行指令列表。
// 条目可编辑、删除、上移/下移；容量上限 10（超出 toaster 提示不静默丢弃）。

import { useState } from "react";
import { useQueueStore } from "../store/queueStore";
import { ChevronRightIcon, CloseIcon } from "./ui/icons";

interface Props {
  tabKey: string;
}

export function CommandQueuePanel({ tabKey }: Props) {
  // 订阅整个 queues 对象（稳定引用）再取本 tabKey 的列表——避免 `?? []`
  // 每次返回新数组触发 zustand 无限重渲染（白屏根因，同 sessionStore.commands）。
  const queues = useQueueStore((s) => s.queues);
  const items = queues[tabKey] ?? [];
  const remove = useQueueStore((s) => s.remove);
  const edit = useQueueStore((s) => s.edit);
  const move = useQueueStore((s) => s.move);
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  return (
    <div className="queue-panel">
      <button
        type="button"
        role="button"
        aria-expanded={open}
        className="queue-head"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="inline-flex transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none", transitionDuration: "var(--motion-fast)" }}
        >
          <ChevronRightIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
        </span>
        <span className="queue-summary">命令队列 · {items.length} 条待执行</span>
      </button>
      {open && (
        <ul className="queue-list">
          {items.map((item, i) => (
            <li key={item.id} className="queue-item">
              <input
                aria-label={`队列指令 ${i + 1}`}
                className="queue-input"
                value={item.text}
                onChange={(e) => edit(tabKey, item.id, e.target.value)}
              />
              <button
                type="button"
                className="queue-move"
                aria-label={`上移指令 ${i + 1}`}
                onClick={() => move(tabKey, item.id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="queue-move"
                aria-label={`下移指令 ${i + 1}`}
                onClick={() => move(tabKey, item.id, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="queue-remove"
                aria-label={`删除队列指令 ${i + 1}`}
                onClick={() => remove(tabKey, item.id)}
              >
                <CloseIcon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
