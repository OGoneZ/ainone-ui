// 输入区（composer）：悬浮输入框（F-10-4）+ slash 菜单（F-4-7/F-11-1）+ @ 文件联想
// 菜单（F-11-3）+ 附件按钮 + 语音输入 + 发送/停止/排队。
// 自 ChatPanel 拆出（P13 C3b）：菜单键盘导航 / IME 防护（M4）/ 菜单互斥（M3）逻辑
// 逐字随迁，行为不变。

import { useEffect, useState, type FormEvent, type KeyboardEvent, type ChangeEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { isSlashInput, completeCommand, filterCommands } from "@/chat/logic/slash";
import { detectAtToken, applyAtToken } from "@/chat/logic/atFile";
import type { CommandWord } from "@/store/sessionStore";
import { VoiceInput } from "./VoiceInput";
import { SendIcon, StopIcon, ExpandIcon, ShrinkIcon } from "@/components/ui/icons";

export interface AtToken {
  query: string;
  start: number;
  end: number;
}

export interface AtEntry {
  rel: string;
  abs: string;
  isDir: boolean;
}

export function Composer({
  input,
  setInput,
  textareaRef,
  busy,
  starting,
  typeText,
  commands,
  atMenu,
  setAtMenu,
  atMatches,
  slashMenuRef,
  atMenuRef,
  onSubmit,
  onStop,
  onPickFiles,
  onEnqueue,
  onVoice,
  onPickSlash,
  onPickAt,
}: {
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  starting: boolean;
  typeText: string;
  commands: CommandWord[];
  atMenu: AtToken | null;
  setAtMenu: React.Dispatch<React.SetStateAction<AtToken | null>>;
  atMatches: AtEntry[];
  slashMenuRef: RefObject<HTMLDivElement | null>;
  atMenuRef: RefObject<HTMLDivElement | null>;
  onSubmit: () => void;
  onStop: () => void;
  onPickFiles: () => void;
  onEnqueue: (text: string) => void;
  onVoice: (text: string) => void;
  onPickSlash?: (w: CommandWord) => void;
  onPickAt: (entry: AtEntry) => void;
}) {
  // L1：Esc 显式关闭 slash 菜单（下次输入变化时重置重新可开）
  const [slashClosed, setSlashClosed] = useState(false);
  const [slashIdx, setSlashIdx] = useState(-1);
  const [atIdx, setAtIdx] = useState(0);
  // F-18-2：输入框全屏编辑态
  const [expanded, setExpanded] = useState(false);
  const slashOpen = isSlashInput(input) && !slashClosed;
  const slashMatches = slashOpen ? filterCommands(commands, input) : [];
  const slashHighlight = slashIdx >= 0 && slashIdx < slashMatches.length ? slashIdx : 0;
  const atHighlight = atIdx >= 0 && atIdx < atMatches.length ? atIdx : 0;

  // F-18-1：textarea 高度自适应（随内容增长，上限 8 行；全屏态交给 CSS 不在此限）
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || expanded) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 8 * 22)}px`;
  }, [input, expanded, textareaRef]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSlashIdx(-1);
    setAtMenu(null);
    onSubmit();
  }

  function handleSlashPick(w: CommandWord) {
    setInput(completeCommand(w));
    setSlashIdx(-1);
    textareaRef.current?.focus();
    onPickSlash?.(w);
  }

  function handleAtPick(entry: AtEntry) {
    if (!atMenu) return;
    const nextText = applyAtToken(input, atMenu, entry);
    setInput(nextText);
    setAtMenu(null);
    setAtIdx(0);
    // M7：文件只走「文本 token」路径——submit 时 composeFileReference 会把
    // 附件胶囊再拼一遍 @file:，同一路径会出现两次引用。文本已含该路径 →
    // 不进胶囊。
    const tokenized = `@file:${entry.abs}`;
    if (!nextText.includes(tokenized)) {
      // 附件胶囊由 ChatPanel 统一管理：目录展开/胶囊添加都经回调上抛
      onPickAt(entry);
      return;
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const v = e.currentTarget.value;
    const caret = e.currentTarget.selectionStart ?? v.length;
    setInput(v);
    setSlashIdx(-1); // 输入变化重置高亮
    setSlashClosed(false); // L1：输入变化重新允许 slash 菜单展开
    // F-11-3：@ 联想开合（词首 @ 才触发）。
    // M3：与 slash 互斥——行首 / 命令输入时不开 @ 菜单（两个菜单同帧
    // 展开会重叠渲染，键盘链互相吞噬）
    const token = isSlashInput(v) ? null : detectAtToken(v, caret);
    if (token) {
      setAtMenu((m) => (m ? { ...token } : token));
      setAtIdx(0);
    } else {
      setAtMenu(null);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // M4：IME 组合中（中文输入法选词）不触发菜单选中/发送——
    // 组合中的 Enter 是确认候选，不是提交意图
    if (e.nativeEvent.isComposing) return;
    // F-11-3 @ 菜单键盘导航（与 slash 互斥：同帧只开一个菜单）
    if (atMenu && atMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAtIdx((i) => (i + 1) % atMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAtIdx((i) => (i <= 0 ? atMatches.length - 1 : i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        handleAtPick(atMatches[atIdx >= 0 && atIdx < atMatches.length ? atIdx : 0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setAtMenu(null);
        return;
      }
    }
    // slash 键盘导航由 ChatPanel 经 commands 过滤后传入 matches（见 props.slashMatches）
    if (slashOpen && slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => (i <= 0 ? slashMatches.length - 1 : i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        handleSlashPick(slashMatches[slashHighlight]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // L1：Esc 语义与 @ 菜单对齐——关闭菜单（原只重置高亮，菜单仍开，
        // Enter 会误选第 0 项）。重开靠再次输入 /。
        setSlashClosed(true);
        setSlashIdx(-1);
        return;
      }
    }
    // F-18-2：全屏编辑态 Esc 退出（在菜单 Esc 判定之后，菜单优先关闭）
    if (e.key === "Escape" && expanded) {
      e.preventDefault();
      setExpanded(false);
      return;
    }
    // F-18-3：Enter 发送 / Shift+Enter 换行（默认行为）
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  // F-19-2：全屏编辑用 Portal 渲染到 body——祖先 .composer-dock 有
  // transform（居中偏移），按 CSS 规范 transform 非 none 的元素是 fixed
  // 后代的包含块，form 的 fixed 定位会被锁死在 dock 内（实测「坍塌」根因）。
  if (expanded) {
    return createPortal(
      <form className="row composer-expanded" onSubmit={submit}>
        <div className="composer-expand-head">
          <span>编辑消息（Shift+Enter 换行，Enter 发送）</span>
          <button
            type="button"
            aria-label="退出全屏编辑"
            title="收起（Esc）"
            className="msg-action-btn"
            onClick={() => setExpanded(false)}
          >
            <ShrinkIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          autoFocus
          aria-label="消息输入"
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={busy ? "运行中，输入将打断当前 turn…" : "输入消息…"}
          disabled={starting}
          rows={1}
        />
        <div className="composer-expand-actions">
          <button
            type="button"
            onClick={onStop}
            disabled={!busy}
            aria-label="停止"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: "var(--bg-2)", color: busy ? "var(--danger)" : "var(--text-secondary)" }}
          >
            <StopIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
          </button>
          <button
            type="submit"
            disabled={starting}
            aria-label="发送"
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-4"
            style={{ backgroundColor: "var(--primary)", color: "var(--primary-foreground)" }}
          >
            <SendIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
            发送
          </button>
        </div>
      </form>,
      document.body,
    );
  }

  return (
    <form className="row" onSubmit={submit}>
      <button type="button" className="attach-btn" aria-label="添加文件" title="添加文件" onClick={onPickFiles}>
        ＋
      </button>
      <VoiceInput onTranscribed={onVoice} />
      <div className="input-wrap">
        {slashOpen && slashMatches.length > 0 && (
          <div className="slash-menu" ref={slashMenuRef}>
            {slashMatches.map((w, i) => (
              <button
                type="button"
                key={w.name}
                aria-selected={i === slashHighlight}
                className={i === slashHighlight ? "slash-item active" : "slash-item"}
                onMouseDown={(e) => {
                  e.preventDefault(); // 抢在 textarea blur 前选中
                  handleSlashPick(w);
                }}
              >
                <span className="slash-name">/{w.name}</span>
                <span className="slash-desc">{w.description}</span>
              </button>
            ))}
          </div>
        )}
        {/* F-11-3 @ 文件联想菜单（复用 slash 菜单结构） */}
        {atMenu && atMatches.length > 0 && (
          <div className="slash-menu at-menu" ref={atMenuRef}>
            {atMatches.map((f, i) => (
              <button
                type="button"
                key={f.rel}
                aria-selected={i === atHighlight}
                className={i === atHighlight ? "slash-item active" : "slash-item"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleAtPick(f);
                }}
              >
                <span className="slash-name">{f.isDir ? "📁" : "📄"} {f.rel}</span>
                <span className="slash-desc">{f.isDir ? "目录" : "文件"}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          aria-label="消息输入"
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            busy
              ? "运行中，输入将打断当前 turn…"
              : input.startsWith("!")
                ? "！命令将交由 harness 执行（claude-code 支持；omp/pi-acp 未验证）"
                : typeText
          }
          disabled={starting}
          rows={1}
        />
      </div>
      {/* F-18-2：全屏编辑开关（收起态显示展开钮；展开态由头部收起钮负责） */}
      {!expanded && (
        <button
          type="button"
          aria-label="全屏编辑"
          title="全屏编辑长消息"
          className="msg-action-btn composer-expand-btn"
          onClick={() => setExpanded(true)}
        >
          <ExpandIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
        </button>
      )}
      <button
        type="submit"
        disabled={starting}
        aria-label="发送"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ backgroundColor: "var(--primary)", color: "var(--primary-foreground)", transitionDuration: "var(--motion-default)" }}
      >
        <SendIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
      </button>
      <button
        type="button"
        onClick={onStop}
        disabled={!busy}
        aria-label="停止"
        className={`stop-btn inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
          busy ? "run-pulse" : ""
        }`}
        style={{
          backgroundColor: "var(--bg-2)",
          color: busy ? "var(--danger)" : "var(--text-secondary)",
          transitionDuration: "var(--motion-default)",
        }}
      >
        <StopIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
      </button>
      {/* F-9-3 命令队列：排队追加按钮（区别于立即发送） */}
      <button
        type="button"
        disabled={!input.trim() || starting}
        aria-label="排队发送"
        title="加入命令队列"
        className="inline-flex h-9 px-2.5 shrink-0 items-center justify-center rounded-full text-xs"
        style={{ backgroundColor: "var(--bg-2)", color: "var(--text-secondary)", transitionDuration: "var(--motion-default)" }}
        onClick={() => {
          const t = input.trim();
          if (t) {
            onEnqueue(t);
            setInput("");
          }
        }}
      >
        排队
      </button>
    </form>
  );
}
