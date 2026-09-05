// 文件预览（P16 · F-16-1，DEC-48）：窗格内右侧浮层，按 previewKind 分流渲染。
//
// markdown → Streamdown（static）；image → asset protocol；code → shiki 双主题；
// text → pre 纯文本；binary / 超限 → 占位 + 系统应用打开（plugin-opener）。
// 关闭：× / Esc；非模态（左侧消息区仍可滚动）。

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { XIcon, FileTextIcon } from "lucide-react";
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
    try {
      const mod = await import(/* @vite-ignore */ `shiki/langs/${lang}.mjs`);
      await hl.loadLanguage(mod.default);
      loadedLangs.add(lang);
    } catch (e) {
      logger.warn("preview", "shiki-lang-load-fail", { lang, e: String(e) });
      return null; // 语言加载失败 → 调用方降级纯文本
    }
  }
  return hl;
}

export function FilePreview({ path, onClose }: Props) {
  const kind: PreviewKind = useMemo(() => resolvePreviewKind(path), [path]);
  const [state, setState] = useState<LoadState>({ t: "loading" });
  const [content, setContent] = useState("");
  const [html, setHtml] = useState("");
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    setIsDark(mql.matches);
    const fn = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mql.addEventListener("change", fn);
    return () => mql.removeEventListener("change", fn);
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
                setHtml(hl.codeToHtml(text, { lang, themes: { light: "github-light", dark: "github-dark" } }));
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

  const title = path.split("/").pop() ?? path;

  return (
    <div className="filepreview" data-testid="file-preview">
      <div className="filepreview-head">
        <FileTextIcon style={{ width: 14, height: 14, flexShrink: 0 }} />
        <span className="filepreview-title" title={path}>{title}</span>
        <span className="filepreview-kind">{kind}</span>
        <button type="button" className="filepreview-close" aria-label="关闭预览" onClick={onClose}>
          <XIcon style={{ width: 14, height: 14 }} />
        </button>
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
            <Streamdown
              mode="static"
              plugins={{ code, math }}
              shikiTheme={["github-light", "github-dark"]}
            >
              {content}
            </Streamdown>
          </div>
        )}

        {state.t === "ready" && kind === "code" && (
          <div
            className="filepreview-code"
            // shiki codeToHtml 输出受信主题模板包裹的转义代码，非用户可控 HTML
            dangerouslySetInnerHTML={{ __html: html || `<pre>${escapeHtml(content)}</pre>` }}
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
