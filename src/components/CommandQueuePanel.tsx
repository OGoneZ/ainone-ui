// 命令队列面板（P9 · F-9-3）：输入框上方（计划栏之下，DEC-19）待执行指令列表。
// 条目可编辑、删除、上移/下移、拖拽重排；容量上限 10（超出 toaster 提示不静默丢弃）。

import { useState } from "react";
import { useQueueStore } from "@/store/queueStore";
import { ChevronRightIcon, CloseIcon, GripVerticalIcon } from "./ui/icons";

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
  const reorder = useQueueStore((s) => s.reorder);
  const [open, setOpen] = useState(false);
  // 拖拽中：被拖拽的条目 id + 悬停目标 id
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  if (items.length === 0) return null;

  function onDragStart(e: React.DragEvent, id: string) {
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
    // Firefox 需 setData 才允许拖拽
    e.dataTransfer.setData("text/plain", id);
  }

  function onDragOver(e: React.DragEvent, id: string) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropId !== id) setDropId(id);
  }

  function onDrop(e: React.DragEvent, toId: string) {
    e.preventDefault();
    const fromId = dragId ?? e.dataTransfer.getData("text/plain");
    setDragId(null);
    setDropId(null);
    if (fromId && fromId !== toId) reorder(tabKey, fromId, toId);
  }

  function onDragEnd() {
    setDragId(null);
    setDropId(null);
  }

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
            <li
              key={item.id}
              className={`queue-item ${dropId === item.id ? "queue-drop-target" : ""}`}
              onDragOver={(e) => onDragOver(e, item.id)}
              onDrop={(e) => onDrop(e, item.id)}
              onDragLeave={() => {
                if (dropId === item.id) setDropId(null);
              }}
            >
              {/* 拖拽手柄（draggable，触发重排；不干扰 input 编辑） */}
              <span
                className={`queue-grip ${dragId === item.id ? "queue-grip-dragging" : ""}`}
                draggable
                aria-label={`拖拽排序 ${i + 1}`}
                title="拖拽排序"
                onDragStart={(e) => onDragStart(e, item.id)}
                onDragEnd={onDragEnd}
              >
                <GripVerticalIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
              </span>
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
