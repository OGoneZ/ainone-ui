// 终端会话面板（P23）：xterm.js 终端仿真 + PTY 接线，与 ChatPanel 同级窗格。
//
// 生命周期对齐 ChatPanel 范式（规格 §4.4）：
//   - mount → createTerminal（spawn shell 进 PTY），xterm 实例随 Tab 存续
//   - flexlayout 对已渲染 tab 保持 DOM（display:none 切换），后台持续收发，
//     重新可见时输出一次性呈现，无需重放
//   - unmount → kill()（连带 terminal_untrack）+ drop(tabKey) 清 store
// 接线：fit addon（ResizeObserver）→ pty.resize（SIGWINCH）；term.onData →
// pty.write；pty.onData → term.write；退出 → 状态条 + 重新打开（重建实例）。
// 主题跟随 app：xterm theme 读 CSS 变量，data-theme 切换时 effect 重算。

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { createTerminal, type TerminalSession } from "@/ipc/pty";
import { useTerminalStore } from "@/store/terminalStore";
import { TerminalIcon } from "@/components/ui/icons";

export interface TerminalPanelProps {
  tabKey: string;
  cwd?: string;
  active: boolean;
  /** P26f：shell 正常退出（code 0）时由面板回调 App 关闭本 tab（App 负责焦点移交）。
   *  异常退出（code≠0）不回调，保留「进程已退出」状态条供查看/重启。 */
  onNormalExit?: () => void;
}

/** 读 CSS 变量并转 xterm theme（lightningcss 不允许 js 直接拿 color-mix，token 均为裸值） */
function readTheme(dark: boolean): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--bg-base", "#ffffff"),
    foreground: v("--text-primary", "#1a1a1a"),
    cursor: v("--text-primary", "#1a1a1a"),
    cursorAccent: v("--bg-base", "#ffffff"),
    selectionBackground: dark ? "#3a4a63" : "#b4d5fe",
    // 16 色：对齐常见终端默认盘（ANSI 0-15），亮暗各一套
    black: v("--bg-3", "#e8e8e8"),
    red: "#e05561",
    green: "#6fbf73",
    yellow: "#e0a547",
    blue: "#7ba4f0",
    magenta: "#c586c0",
    cyan: "#4dc4c4",
    white: "#d4d4d4",
    brightBlack: "#767676",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  };
}

export function TerminalPanel({ tabKey, cwd, active, onNormalExit }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const ptyRef = useRef<TerminalSession | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [exited, setExited] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  // P26f：onNormalExit 走 ref（openTerminal 的 useCallback 依赖不含它，避免引用变化误重建）
  const onNormalExitRef = useRef<(() => void) | undefined>(undefined);
  onNormalExitRef.current = onNormalExit;
  const ensure = useTerminalStore((s) => s.ensure);
  const markExited = useTerminalStore((s) => s.markExited);
  const drop = useTerminalStore((s) => s.drop);

  /** 主题重算（挂载与 data-theme 变化时调用） */
  const applyTheme = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    const dark = document.documentElement.dataset.theme === "dark";
    term.options.theme = readTheme(dark);
  }, []);

  /** 创建（或重建）终端会话：dispose 旧实例 → spawn 新 shell */
  const openTerminal = useCallback(() => {
    setExited(false);
    setExitCode(null);
    setSpawnError(null);

    const term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    const host = containerRef.current;
    if (!host) return;
    term.open(host);

    createTerminal({
      cwd,
      cols: term.cols,
      rows: term.rows,
    })
      .then((pty) => {
        // 异步回来的会话可能已因 unmount/重建而作废（killRef 置位）
        if (killedRef.current) {
          pty.kill();
          return;
        }
        ptyRef.current = pty;
        term.onData((d) => pty.write(d));
        pty.onData((d) => term.write(d));
        pty.onExit((code) => {
          setExited(true);
          setExitCode(code);
          markExited(tabKey, code);
          // P26f：正常退出（Ctrl+D / exit）→ 自动关掉 tab；异常退出保留状态条。
          // onNormalExitRef 避免回调引用变化重建 openTerminal（会误 kill 重启）
          onNormalExitRef.current?.();
        });
        applyTheme();
        fit.fit();
        pty.resize(term.cols, term.rows);
        term.focus();
      })
      .catch((e) => {
        setSpawnError(e instanceof Error ? e.message : String(e));
      });
  }, [cwd, tabKey, markExited, applyTheme]);

  const killedRef = useRef(false);

  // 挂载：建终端 + 观察容器尺寸；卸载：全量清理
  useEffect(() => {
    ensure(tabKey);
    killedRef.current = false;
    openTerminal();

    const observer = new ResizeObserver(() => {
      const fit = fitRef.current;
      const pty = ptyRef.current;
      if (!fit || !containerRef.current) return;
      try {
        fit.fit();
        if (pty) pty.resize(termRef.current!.cols, termRef.current!.rows);
      } catch {
        // 容器 display:none（tab 隐藏）时 fit 抛错，忽略即可
      }
    });
    observerRef.current = observer;
    const hostEl = containerRef.current;
    if (hostEl) observer.observe(hostEl);

    return () => {
      killedRef.current = true;
      observer.disconnect();
      ptyRef.current?.kill();
      ptyRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      drop(tabKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey]);

  // 主题跟随：data-theme 变化 → 重读 CSS 变量
  useEffect(() => {
    const obs = new MutationObserver(() => applyTheme());
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, [applyTheme]);

  // 重新激活（tab 切回）：聚焦输入 + 重 fit（隐藏期间容器尺寸可能已变）
  useEffect(() => {
    if (!active) return;
    try {
      fitRef.current?.fit();
    } catch {
      /* 忽略 0 尺寸 */
    }
    termRef.current?.focus();
  }, [active]);

  return (
    <div className="panel terminal-panel" data-tab-key={tabKey}>
      {spawnError ? (
        <div className="terminal-error" role="alert">
          <TerminalIcon style={{ width: 16, height: 16 }} />
          <span>终端启动失败：{spawnError}</span>
        </div>
      ) : exited ? (
        <div className="terminal-exit-bar" data-testid="terminal-exit-bar">
          <span>进程已退出{exitCode !== null && exitCode !== 0 ? `（code ${exitCode}）` : ""}</span>
          <button
            className="terminal-revive"
            onClick={() => {
              // 重建：dispose 旧 xterm 实例后重新 openTerminal
              termRef.current?.dispose();
              termRef.current = null;
              useTerminalStore.getState().revive(tabKey);
              openTerminal();
            }}
          >
            重新打开
          </button>
        </div>
      ) : null}
      <div className="terminal-host" ref={containerRef} />
    </div>
  );
}
