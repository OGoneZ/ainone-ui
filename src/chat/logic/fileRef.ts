// 文件引用的纯拼装逻辑（P8 · F-8-3）。零依赖，可单测。
//
// 语义（plan-p8.md F-8-3）：文件作为**绝对路径**传给 harness，由 harness 自行
// 读取（不注入内容、不占客户端上下文）。格式 `@file:/abs/path`，多文件换行。

export interface FileRef {
  path: string;
}

/** 是否绝对路径（ACP 只认绝对路径；本客户端主要面向 macOS/Linux） */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

/** 把一批文件引用拼成传给 harness 的文本（多文件换行；空集输出空串） */
export function composeFileReference(files: FileRef[]): string {
  return files.map((f) => `@file:${f.path}`).join("\n");
}

/** 过滤：只保留绝对路径的文件（相对路径无法被 harness 稳定读取） */
export function filterAbsoluteFiles(files: FileRef[]): FileRef[] {
  return files.filter((f) => isAbsolutePath(f.path));
}
