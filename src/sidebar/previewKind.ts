// 文件预览类型判定（P16 · F-16-1，DEC-48）：扩展名 → 渲染器类型单点映射。
//
// 参考 AionUi fileUtils.ts 的 FILE_EXTENSION_MAP 模式，按本仓渲染器能力裁剪：
// markdown → Streamdown；image → asset protocol <img>；code → shiki 高亮；
// text → 纯文本兜底；binary → 不读内容，提供系统应用打开。
// 纯函数，无 Tauri 依赖，可单测。

export type PreviewKind = "markdown" | "image" | "code" | "text" | "binary";

/** 文本类可读上限（字符数，UTF-8 下近似字节数）。超过提示过大改用系统打开。 */
export const PREVIEW_TEXT_LIMIT = 1_000_000;

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"]);

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
]);

/** 明确不可读的格式（不读内容，直接给系统打开） */
const BINARY_EXTS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "zip", "tar", "gz", "bz2", "7z", "rar", "dmg", "exe", "app", "bin",
  "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "ogg", "webm",
  "ttf", "otf", "woff", "woff2", "eot", "psd", "ai", "sketch", "wasm",
  "so", "dylib", "dll", "class", "jar", "pyc", "o", "a", "lockb",
]);

/** 扩展名 → shiki 语言 id（预览常用白名单，按需扩充；值必须能被 LANG_LOADERS 加载） */
const CODE_LANGS: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", go: "go", java: "java", kt: "kotlin", c: "c", h: "c",
  cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", swift: "swift", php: "php",
  json: "json", jsonc: "json", json5: "json", toml: "toml", yaml: "yaml", yml: "yaml",
  xml: "xml", html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  sql: "sql",
  vue: "vue", svelte: "svelte",
  lua: "lua", zig: "zig",
  dockerfile: "dockerfile", makefile: "makefile",
};

/** 取小写扩展名（无点返回 ""） */
export function extname(path: string): string {
  const base = path.split("/").pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function resolvePreviewKind(path: string): PreviewKind {
  const ext = extname(path);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (BINARY_EXTS.has(ext)) return "binary";
  // 已知代码扩展名，或特殊无扩展名文件名（Makefile/Dockerfile 等）
  if (CODE_LANGS[ext]) return "code";
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (base === "makefile" || base === "dockerfile" || base === ".gitignore" || base === ".env") {
    return "code";
  }
  // 未知扩展名与无扩展名 → 纯文本兜底（读出来再说）
  return "text";
}

/** code 类型对应的 shiki 语言（text/markdown 不走 shiki） */
export function shikiLangFor(path: string): string | undefined {
  const ext = extname(path);
  if (CODE_LANGS[ext]) return CODE_LANGS[ext];
  const base = (path.split("/").pop() ?? path).toLowerCase();
  if (base === "makefile") return "makefile";
  if (base === "dockerfile") return "dockerfile";
  return undefined;
}
