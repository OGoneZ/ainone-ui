// 文件预览（P16 · F-16-1，DEC-48）：窗格内右侧浮层，按 previewKind 分流渲染。
//
// markdown → Streamdown（static）；image → asset protocol；code → shiki 双主题；
// text → pre 纯文本；binary / 超限 → 占位 + 系统应用打开（plugin-opener）。
// 关闭：× / Esc；非模态（左侧消息区仍可滚动）。
// P16a：右上角全屏切换；左缘拖拽手柄调宽（280px~80% 窗宽，非全屏态生效）。

import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { XIcon, FileTextIcon } from "lucide-react";
import { MaximizeIcon as FlexMaximizeIcon, RestoreIcon as FlexRestoreIcon } from "flexlayout-react";
import { resolvePreviewKind, shikiLangFor, PREVIEW_TEXT_LIMIT, type PreviewKind } from "./previewKind";
import { logger } from "@/lib/logger";
import { Button } from "@/components/ui/button";

interface Props {
  path: string;
  onClose: () => void;
}

type LoadState =
  | { t: "loading" }
  | { t: "ready" }
  | { t: "too-large" }
  | { t: "error"; msg: string };

/* —— shiki highlighter 单例（DEC-48：全 app 共享，按需载语言） —— */
let highlighterPromise: Promise<Awaited<ReturnType<typeof createHighlighterCore>>> | null = null;
const loadedLangs = new Set<string>();

// 预载语言（静态 import：vite 可静态分析，进预打包缓存）
const COMMON_LANGS = [
  import("shiki/langs/typescript.mjs"), import("shiki/langs/tsx.mjs"),
  import("shiki/langs/javascript.mjs"), import("shiki/langs/jsx.mjs"),
  import("shiki/langs/python.mjs"), import("shiki/langs/rust.mjs"),
  import("shiki/langs/go.mjs"), import("shiki/langs/json.mjs"),
  import("shiki/langs/yaml.mjs"), import("shiki/langs/toml.mjs"),
  import("shiki/langs/css.mjs"), import("shiki/langs/html.mjs"),
  import("shiki/langs/bash.mjs"), import("shiki/langs/markdown.mjs"),
  import("shiki/langs/sql.mjs"),
];
// P16a 修复：动态模板 import + @vite-ignore 在浏览器里按相对 URL 解析（拿到
// SPA fallback 的 HTML → SyntaxError → 全部降级纯文本）。改为静态注册表：
// 每种语言一个可被 vite 改写的静态 import，白名单外语言不加载（降级纯文本）。
const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
};

async function getHighlighter(lang: string) {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: COMMON_LANGS,
      engine: createJavaScriptRegexEngine(),
    });
  }
  const hl = await highlighterPromise;
  if (!loadedLangs.has(lang)) {
    const load = LANG_LOADERS[lang];
    if (!load) return null; // 白名单外语言 → 降级纯文本
    try {
      const mod = await load();
      await hl.loadLanguage(mod.default as never);
      loadedLangs.add(lang);
    } catch (e) {
      logger.warn("preview", "shiki-lang-load-fail", { lang, e: String(e) });
      return null; // 语言加载失败 → 调用方降级纯文本
    }
  }
  return hl;
}

// P16a 修 md 预览卡顿：plugins/shikiTheme 必须是模块级常量——
// 内联对象每次渲染都是新引用，会击穿 Streamdown 的 memo，导致 ChatPanel
// 流式期间的高频重渲染每次都驱动 md 文档全量重 reconcile（肉眼可见卡顿）。
const MD_PLUGINS = { code, math };
const SHIKI_THEMES: [string, string] = ["github-light", "github-dark"];

/** 跟随 App 的 root data-theme（自持 matchMedia 会与 App 的 auto/light/dark 设置不一致） */
function subscribeRootTheme(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => obs.disconnect();
}

function FilePreviewImpl({ path, onClose }: Props) {
  const kind: PreviewKind = useMemo(() => resolvePreviewKind(path), [path]);
  const [state, setState] = useState<LoadState>({ t: "loading" });
  const [content, setContent] = useState("");
  const [html, setHtml] = useState("");
  const isDark = useSyncExternalStore(
    subscribeRootTheme,
    () => document.documentElement.getAttribute("data-theme") === "dark",
  );
  // P16a：全屏态 + 拖宽（px，null=默认 min(50%,720px)）
  const [fullscreen, setFullscreen] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  // P16a 修闪烁：code 容器走 ref 手动注入（详见 codeRef effect 注释）
  const codeRef = useRef<HTMLDivElement | null>(null);

  // Esc 关闭（全屏态先退全屏）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (fullscreen) setFullscreen(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, fullscreen]);

  // P16a：左缘拖拽手柄——向左拖增宽；280px ~ 80% 窗宽夹取
  function onDragHandleDown(e: React.PointerEvent) {
    if (fullscreen) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startW: width ?? previewDefaultWidth() };
  }
  function onDragHandleMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const maxW = Math.floor(window.innerWidth * 0.8);
    setWidth(Math.min(maxW, Math.max(280, d.startW + (d.startX - e.clientX))));
  }
  function onDragHandleUp() {
    dragRef.current = null;
  }

  // 按类型加载
  useEffect(() => {
    let cancelled = false;
    setState({ t: "loading" });

    if (kind === "image") {
      // asset protocol 直接加载，无法预判失败 → 用 <img> onError 转 error
      setState({ t: "ready" });
      return;
    }
    if (kind === "binary") {
      setState({ t: "ready" });
      return;
    }

    invoke<string>("fd_read", { path })
      .then((text) => {
        if (cancelled) return;
        if (text.length > PREVIEW_TEXT_LIMIT) {
          setState({ t: "too-large" });
          logger.info("preview", "too-large", { path, len: text.length });
          return;
        }
        setContent(text);
        setState({ t: "ready" });
        if (kind === "code") {
          const lang = shikiLangFor(path);
          if (lang) {
            getHighlighter(lang).then((hl) => {
              if (cancelled) return;
              if (!hl) return; // 降级：保持 pre 纯文本
              try {
                // tabindex:false：shiki 默认给 <pre> 加 tabindex=0 → 点击代码即聚焦，
                // 重渲染时焦点 scrollIntoView 会把选区拉回文件头并闪烁（P16a 用户反馈）
                setHtml(hl.codeToHtml(text, {
                  lang,
                  themes: { light: "github-light", dark: "github-dark" },
                  tabindex: false,
                }));
              } catch {
                /* 保持纯文本 */
              }
            });
          }
        }
        logger.info("preview", "open", { path, kind, len: text.length });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ t: "error", msg: String(e) });
        logger.warn("preview", "read-fail", { path, e: String(e) });
      });

    return () => {
      cancelled = true;
    };
  }, [path, kind]);

  // P16a 修闪烁：code 容器手动注入 innerHTML。
  // 原实现走 dangerouslySetInnerHTML——ChatPanel 流式期间高频重渲染，该通道
  // 在 WKWebView 上反复清空选区（闪烁）。改为：React 不托管该子树，仅在
  // html 真正变化时写一次 DOM；正在拖选时 DOM 不动 → 选区稳定。
  useEffect(() => {
    const el = codeRef.current;
    if (!el) return;
    const next = html || `<pre>${escapeHtml(content)}</pre>`;
    if (el.dataset.rendered !== next) {
      el.innerHTML = next;
      el.dataset.rendered = next;
    }
  }, [html, content, state.t, kind]);

  const title = path.split("/").pop() ?? path;

  return (
    <div
      className={`filepreview ${fullscreen ? "fullscreen" : ""}`}
      data-testid="file-preview"
      style={width !== null && !fullscreen ? { width } : undefined}
    >
      {/* P16a：左缘拖拽手柄（全屏态隐藏） */}
      {!fullscreen && (
        <div
          className="filepreview-resize"
          onPointerDown={onDragHandleDown}
          onPointerMove={onDragHandleMove}
          onPointerUp={onDragHandleUp}
          role="separator"
          aria-label="拖拽调整预览宽度"
        />
      )}
      <div className="filepreview-head">
        <FileTextIcon style={{ width: 14, height: 14, flexShrink: 0 }} />
        <span className="filepreview-title" title={path}>{title}</span>
        <span className="filepreview-kind">{kind}</span>
        {/* P16a：右侧按钮组（… [⛶ 全屏] [× 关闭]，⛶ 在 × 左侧）——
            auto margin 只放在组上，避免两个按钮各吃一份 auto 被推开 */}
        <span className="filepreview-actions">
          <button
            type="button"
            className="filepreview-close"
            aria-label={fullscreen ? "退出全屏" : "全屏预览"}
            title={fullscreen ? "退出全屏" : "全屏"}
            onClick={() => setFullscreen((v) => !v)}
          >
            {fullscreen ? <FlexRestoreIcon /> : <FlexMaximizeIcon />}
          </button>
          <button type="button" className="filepreview-close" aria-label="关闭预览" onClick={onClose}>
            <XIcon style={{ width: 14, height: 14 }} />
          </button>
        </span>
      </div>
      <div className="filepreview-body">
        {state.t === "loading" && <div className="hint">加载中…</div>}

        {state.t === "error" && (
          <div className="hint" role="alert">读取失败：{state.msg}</div>
        )}

        {state.t === "too-large" && (
          <div className="filepreview-fallback">
            <p>文件过大，无法在软件内预览。</p>
            <Button size="sm" variant="outline" onClick={() => void openPath(path)}>
              用系统应用打开
            </Button>
          </div>
        )}

        {state.t === "ready" && kind === "image" && (
          <img
            src={convertFileSrc(path)}
            alt={title}
            className="filepreview-img"
            onError={() => setState({ t: "error", msg: "图片加载失败" })}
          />
        )}

        {state.t === "ready" && kind === "markdown" && (
          <div className="filepreview-md">
            <Streamdown mode="static" plugins={MD_PLUGINS} shikiTheme={SHIKI_THEMES}>
              {content}
            </Streamdown>
          </div>
        )}

        {state.t === "ready" && kind === "code" && (
          <div
            ref={codeRef}
            className="filepreview-code"
            // shiki codeToHtml 输出受信主题模板包裹的转义代码，非用户可控 HTML；
            // 注入逻辑见上方 effect（手动 innerHTML，修选区闪烁）
            data-theme={isDark ? "dark" : "light"}
          />
        )}

        {state.t === "ready" && kind === "text" && (
          <pre className="filepreview-plain">{content}</pre>
        )}

        {state.t === "ready" && kind === "binary" && (
          <div className="filepreview-fallback">
            <p>此格式（{title.split(".").pop()}）不支持软件内预览。</p>
            <Button size="sm" variant="outline" onClick={() => void openPath(path)}>
              用系统应用打开
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 拖宽起点：默认宽 min(50%, 720px) 的像素值 */
function previewDefaultWidth(): number {
  return Math.min(Math.floor(window.innerWidth / 2), 720);
}

export const FilePreview = memo(FilePreviewImpl);
