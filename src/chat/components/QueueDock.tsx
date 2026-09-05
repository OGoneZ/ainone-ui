// 队列悬浮 Dock（P16 · F-16-3，DEC-50）：右下角浮层替代原静态条带（CommandQueuePanel）。
//
// 两态：收起 = 「队列 N」徽标（0 条不渲染）；展开 = 卡片浮层。
// 拖拽 = @dnd-kit sortable（挤位过渡即手机桌面效果）；条目悬停另一条目 600ms
// → 合并候选高亮 → 松手吸入合并（文本按原顺序空行拼接，DEC-50）。
// 消费时机不变：ChatPanel 在 turn_stop 非 cancelled/user 时 dequeue（P9 F-9-3 + M1）。
//
// 拖拽标准统一条款（DEC-51）：应用内列表拖拽统一 dnd-kit，不再手搓 HTML5 DnD。

import { useEffect, useRef, useState } from "react";
import { useQueueStore } from "@/store/queueStore";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDownIcon, ChevronUpIcon, XIcon, SendIcon, GripVerticalIcon } from "lucide-react";
import { logger } from "@/lib/logger";

/** 合并候选触发时长（悬停另一条目多久后进入「吸入待合并」高亮态） */
const MERGE_HOLD_MS = 600;

interface Props {
  tabKey: string;
  /** busy 时徽标呼吸提示（消费会自动发生）+「立即发」可用性不受影响 */
  busy: boolean;
  /** 「立即发」：打断当前 turn 并把该条作为 steering 立即发出（M2 先赋值再 stop） */
  onSendNow: (text: string) => void;
}

export function QueueDock({ tabKey, busy, onSendNow }: Props) {
  const items = useQueueStore((s) => s.queues[tabKey]) ?? [];
  const remove = useQueueStore((s) => s.remove);
  const reorder = useQueueStore((s) => s.reorder);
  const merge = useQueueStore((s) => s.merge);

  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mergeCandidate, setMergeCandidate] = useState<string | null>(null);
  const [merging, setMerging] = useState<{ dragId: string; overId: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  // 悬停计时：dragOver 持续命中同一条目 MERGE_HOLD_MS → 进入合并候选
  const hoverRef = useRef<{ id: string; since: number } | null>(null);
  const holdTimerRef = useRef<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // 键盘路径保 reorder（合并仅指针路径，AC 规定）
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => () => {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
  }, []);

  if (items.length === 0) return null;

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    logger.debug("queue", "dock-drag-start", { id: String(e.active.id) });
  }

  function handleDragOver(e: DragOverEvent) {
    const overId = e.over ? String(e.over.id) : null;
    const dragId = activeId;
    if (!overId || !dragId || overId === dragId) {
      hoverRef.current = null;
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
      setMergeCandidate(null);
      return;
    }
    if (hoverRef.current?.id !== overId) {
      hoverRef.current = { id: overId, since: performance.now() };
      setMergeCandidate(null);
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = window.setTimeout(() => {
        setMergeCandidate(overId);
      }, MERGE_HOLD_MS);
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    const dragId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    setActiveId(null);
    setMergeCandidate(null);
    hoverRef.current = null;
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);

    if (!overId || overId === dragId) return;
    if (mergeCandidate === overId) {
      // 合并：先播吸入动画（overlay 由 CSS transition 收缩），落账延迟到动画尾
      setMerging({ dragId, overId });
      window.setTimeout(() => {
        merge(tabKey, dragId, overId);
        setMerging(null);
        logger.info("queue", "merge", { dragId, overId, len: items.length - 1 });
      }, 320);
    } else {
      // 普通重排：拖到谁头上落到谁的位置（L9 语义不变）
      reorder(tabKey, dragId, overId);
      logger.debug("queue", "dock-reorder", { dragId, overId });
    }
  }

  function startEdit(id: string, text: string) {
    setEditingId(id);
    setEditText(text);
  }

  function commitEdit() {
    if (editingId !== null) {
      useQueueStore.getState().edit(tabKey, editingId, editText);
      logger.debug("queue", "dock-edit", { id: editingId });
    }
    setEditingId(null);
  }

  const activeItem = activeId ? items.find((i) => i.id === activeId) : null;

  return (
    <div className={`queue-dock ${open ? "open" : ""}`} data-testid="queue-dock">
      <button
        type="button"
        className="queue-dock-badge"
        aria-label={`命令队列 ${items.length} 条待执行`}
        onClick={() => {
          setOpen((v) => !v);
          logger.debug("queue", "dock-toggle", { open: !open, len: items.length });
        }}
      >
        {busy && <span className="queue-dock-pulse" aria-hidden />}
        队列 {items.length}
        {open ? <ChevronDownIcon style={{ width: 12, height: 12 }} /> : <ChevronUpIcon style={{ width: 12, height: 12 }} />}
      </button>

      {open && (
        <div className="queue-dock-card" role="list" aria-label="待执行队列">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={() => {
              setActiveId(null);
              setMergeCandidate(null);
              hoverRef.current = null;
            }}
          >
            <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              {items.map((it, idx) => (
                <DockItem
                  key={it.id}
                  id={it.id}
                  text={it.text}
                  order={idx + 1}
                  isMerging={merging?.dragId === it.id || merging?.overId === it.id}
                  isCandidate={mergeCandidate === it.id}
                  isEditing={editingId === it.id}
                  editText={editText}
                  onEditText={setEditText}
                  onStartEdit={() => startEdit(it.id, it.text)}
                  onCommitEdit={commitEdit}
                  onCancelEdit={() => setEditingId(null)}
                  onRemove={() => {
                    remove(tabKey, it.id);
                    logger.info("queue", "dock-remove", { id: it.id });
                  }}
                  onSendNow={() => {
                    logger.info("queue", "immediate-send", { id: it.id });
                    onSendNow(it.text);
                  }}
                />
              ))}
            </SortableContext>
            {/* 拖拽影子：原位条目降透明，影子跟随指针；合并时吸入动画（transform 到目标 + scale + fade） */}
            <DragOverlay dropAnimation={null}>
              {activeItem ? (
                <div className={`queue-dock-item dragging ${merging ? "merge-sink" : ""}`}>
                  <span className="queue-dock-order">•</span>
                  <span className="queue-dock-text">{activeItem.text}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}
    </div>
  );
}

/** 单条目：手柄 + 序号 + 文本（点击编辑）+ 立即发 + 删除 */
function DockItem({
  id,
  text,
  order,
  isMerging,
  isCandidate,
  isEditing,
  editText,
  onEditText,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onRemove,
  onSendNow,
}: {
  id: string;
  text: string;
  order: number;
  isMerging: boolean;
  isCandidate: boolean;
  isEditing: boolean;
  editText: string;
  onEditText: (v: string) => void;
  onStartEdit: () => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onRemove: () => void;
  onSendNow: (text: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`queue-dock-item ${isDragging ? "ghost" : ""} ${isCandidate ? "candidate" : ""} ${isMerging ? "merging" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-id={id}
    >
      <button
        type="button"
        className="queue-dock-grip"
        aria-label="拖拽排序"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon style={{ width: 12, height: 12 }} />
      </button>
      <span className="queue-dock-order">{order}</span>
      {isEditing ? (
        <input
          className="queue-dock-input"
          value={editText}
          autoFocus
          onChange={(e) => onEditText(e.target.value)}
          onBlur={onCommitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) onCommitEdit();
            if (e.key === "Escape") onCancelEdit();
          }}
        />
      ) : (
        <button type="button" className="queue-dock-text" title={text} onClick={onStartEdit}>
          {text}
        </button>
      )}
      <button type="button" className="queue-dock-act" aria-label="立即发送" title="立即发送（打断当前任务）" onClick={() => onSendNow(text)}>
        <SendIcon style={{ width: 12, height: 12 }} />
      </button>
      <button type="button" className="queue-dock-act" aria-label="删除" title="删除" onClick={onRemove}>
        <XIcon style={{ width: 12, height: 12 }} />
      </button>
    </div>
  );
}
