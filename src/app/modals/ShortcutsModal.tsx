// P25 快捷键帮助弹窗：全部动作 + 当前键位 + 录制改绑 + 恢复默认。
//
// 交互：每行「改绑」进入录制态（下一组 keydown 捕获为新键位，Esc 取消，
// 纯修饰键忽略）；冲突 → toast 拒绝；「恢复默认」清空全部覆盖。
// 键位数据源 keymapStore（overrides 持久化 ainone-keymap）。

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { findConflictId, formatBinding, type Binding, type ShortcutDef, type ShortcutId } from "@/app/logic/keymap";
import { useKeymapStore } from "@/store/keymapStore";

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "MetaLeft", "MetaRight",
  "AltLeft", "AltRight", "ShiftLeft", "ShiftRight",
  "CapsLock", "Fn", "FnLock",
]);

/** 作用域分组标题（展示顺序 = defs 顺序的稳定分组） */
function scopeLabel(scope: ShortcutDef["scope"]): string {
  if (scope === "global") return "全局";
  if (scope === "chord") return "会话（多击）";
  return "会话窗格";
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const defs = useKeymapStore((s) => s.defs);
  const overrides = useKeymapStore((s) => s.overrides);
  const setBinding = useKeymapStore((s) => s.setBinding);
  const resetAll = useKeymapStore((s) => s.resetAll);
  // 录制态：正在为哪个 id 录制（null = 非录制态）
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // 录制态：capture 捕获全部 keydown（抢在 Dialog Esc 关闭前消费）
  useEffect(() => {
    if (!recording) return;
    function onRecKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (MODIFIER_CODES.has(e.code)) return; // 纯修饰键按下忽略
      if (e.isComposing) return;
      const currentId = recording;
      if (!currentId) return;
      const binding: Binding = {
        code: e.code,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      };
      const label = defs.find((d) => d.id === currentId)?.label ?? currentId;
      const conflict = findConflictId(binding, defs, overrides, currentId);
      if (conflict) {
        const conflictLabel = defs.find((d) => d.id === conflict)?.label ?? conflict;
        toast.error(`与「${conflictLabel}」冲突，请先改绑或换一个键`);
        return;
      }
      setBinding(currentId, [binding]);
      toast.success(`「${label}」已绑定为 ${formatBinding(binding)}`);
      setRecording(null);
    }
    // capture=true + 顶层容器监听，确保先于 Dialog 的 Esc 处理
    document.addEventListener("keydown", onRecKey, true);
    return () => document.removeEventListener("keydown", onRecKey, true);
  }, [recording, defs, overrides, setBinding]);

  // 展示顺序：global → pane → chord 分组（defs 原序稳定）
  const groups: ShortcutDef["scope"][] = ["global", "pane", "chord"];

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setRecording(null); onClose(); } }}>
      <DialogContent className="shortcuts-modal">
        <DialogHeader>
          <DialogTitle>快捷键</DialogTitle>
        </DialogHeader>
        {/* 宽度足够（≥860px 视口）时按分组拆两列，免长滚动 */}
        <div className="shortcuts-list" ref={contentRef}>
          {groups.map((scope) => {
            const items = defs.filter((d) => d.scope === scope);
            if (items.length === 0) return null;
            return (
              <section key={scope} className="shortcut-group">
                <h4 className="shortcut-group-title">{scopeLabel(scope)}</h4>
                {items.map((d) => {
                  const bindings = overrides[d.id] ?? d.defaults;
                  const isDefault = !overrides[d.id];
                  return (
                    <div key={d.id} className="shortcut-row" data-recording={recording === d.id ? "true" : undefined}>
                      <span className="shortcut-label">{d.label}</span>
                      {recording === d.id ? (
                        <span className="shortcut-recording">按新按键…（Esc 取消）</span>
                      ) : (
                        <span className="shortcut-keys">
                          {bindings.map((b, i) => (
                            <kbd key={i}>{formatBinding(b)}</kbd>
                          ))}
                          {!isDefault && <span className="shortcut-custom" title="已自定义">改</span>}
                        </span>
                      )}
                      <button
                        type="button"
                        className="shortcut-rebind"
                        onClick={() => setRecording(recording === d.id ? null : d.id)}
                      >
                        {recording === d.id ? "取消" : "改绑"}
                      </button>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
        <div className="modal-actions shortcuts-actions">
          <button
            onClick={() => {
              resetAll();
              toast.success("已恢复默认键位");
            }}
          >
            恢复默认
          </button>
          <button onClick={onClose}>关闭</button>
        </div>
        <p className="shortcut-note">注：macOS 上 Ctrl 与 ⌘ 等效；个别组合键若被系统占用（如 ⌘M 最小化窗口），事件不会到达应用。</p>
      </DialogContent>
    </Dialog>
  );
}
