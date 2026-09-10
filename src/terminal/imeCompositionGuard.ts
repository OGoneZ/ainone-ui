// WebKitGTK/IBus IME 提交序列归一化（P23 终端打字重复修复）。
//
// 症状与根因（lumina-terminal PR#5 同栈实锤，xtermjs#6060/#6078 上游未修）：
// Linux 下 Tauri = WebKitGTK；fcitx5/IBus/Rime 提交字符的事件序列是
// keydown(229) → input(insertFromComposition) → compositionend，会【漏发
// compositionstart】（macOS WKWebView 与 Chrome 均发）。xterm 收到无归属的
// keydown 229 走「延迟 textarea 回读」兜底：value.replace(oldValue,"") 当本次
// 输入。WebKitGTK 会在回读前重写 textarea，oldValue 不再是子串 → replace 落空
// → 整个隐藏 textarea 积攒的历史输入被一次性重放（用户看到「打一个字母突然
// 多出一串」）；未匹配的 compositionend 再把同一文本重复提交一遍。
//
// 归一化（在 xterm 的 helper textarea 上 capture 监听，xterm 本体不动）：
//   - keydown 229 时快照 textarea value/selection，标记「兜底待发」窗口（一个 tick）
//   - 无 compositionstart 归属的 input(insertFromComposition) 到达时，按
//     InputEvent.data 把 textarea 精确重建为 keydown 时刻的值+本次提交，
//     使 xterm 延迟回读算出的 diff 恰好等于本次提交（不再整段重放）
//   - 无归属的 compositionend 直接拦下（xterm 的延迟 finalize 会重复提交）
// 正常 IME 序列（有 compositionstart）完全放行，本模块零干预。

/** 在 xterm helper textarea 上安装 guard，返回卸载函数。
 *  必须在 term.open() 之后调用（此时 textarea 才存在）。 */
export function installImeCompositionGuard(textarea: HTMLTextAreaElement): () => void {
  let sawCompositionStart = false;
  let pendingTextareaFallback = false;
  let fallbackMarkerTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackValue = "";
  let fallbackSelectionStart = 0;
  let fallbackSelectionEnd = 0;

  const clearFallbackMarker = () => {
    if (fallbackMarkerTimer !== undefined) {
      globalThis.clearTimeout(fallbackMarkerTimer);
      fallbackMarkerTimer = undefined;
    }
    pendingTextareaFallback = false;
    fallbackValue = "";
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.keyCode !== 229) return;
    clearFallbackMarker();
    pendingTextareaFallback = true;
    fallbackValue = textarea.value;
    fallbackSelectionStart = textarea.selectionStart ?? fallbackValue.length;
    fallbackSelectionEnd = textarea.selectionEnd ?? fallbackSelectionStart;
    // 窗口只开一个 tick：xterm 的兜底回读是 setTimeout(0)，窗口过后 229 状态作废
    fallbackMarkerTimer = globalThis.setTimeout(() => {
      fallbackMarkerTimer = undefined;
      pendingTextareaFallback = false;
    }, 0);
  };

  const handleCompositionStart = () => {
    sawCompositionStart = true;
  };

  const handleInput = (rawEvent: Event) => {
    const event = rawEvent as InputEvent;
    if (
      sawCompositionStart ||
      !pendingTextareaFallback ||
      event.inputType !== "insertFromComposition" ||
      typeof event.data !== "string"
    ) {
      return;
    }
    const start = Math.min(fallbackSelectionStart, fallbackSelectionEnd);
    const end = Math.max(fallbackSelectionStart, fallbackSelectionEnd);
    const caret = start + event.data.length;
    // xterm 的延迟回读用 String.remove(value, oldValue) 求 diff；WebKitGTK 在
    // 回读前重写 textarea 会让 oldValue 消失 → 整段重放。这里把 textarea 恢复
    // 成「keydown 时刻的值 + 本次提交」，diff 恰好等于本次提交。
    textarea.value = fallbackValue.substring(0, start) + event.data + fallbackValue.substring(end);
    textarea.setSelectionRange(caret, caret);
  };

  const handleCompositionEnd = (event: CompositionEvent) => {
    // 有 compositionstart 归属的正常序列放行；无归属的（WebKitGTK/IBus 重复提交源）拦下
    if (!sawCompositionStart && pendingTextareaFallback) {
      event.stopImmediatePropagation();
    }
    sawCompositionStart = false;
    clearFallbackMarker();
  };

  textarea.addEventListener("keydown", handleKeydown, true);
  textarea.addEventListener("compositionstart", handleCompositionStart, true);
  textarea.addEventListener("input", handleInput, true);
  textarea.addEventListener("compositionend", handleCompositionEnd, true);

  return () => {
    clearFallbackMarker();
    textarea.removeEventListener("keydown", handleKeydown, true);
    textarea.removeEventListener("compositionstart", handleCompositionStart, true);
    textarea.removeEventListener("input", handleInput, true);
    textarea.removeEventListener("compositionend", handleCompositionEnd, true);
  };
}
