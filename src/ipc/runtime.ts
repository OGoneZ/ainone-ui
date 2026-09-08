// 运行时诊断前端封装（P31）：设置页展示 bun/npm 解析结果与内嵌状态。

import { invoke } from "@tauri-apps/api/core";

/** 单个运行时的解析结果（Rust RuntimeInfo，camelCase 序列化） */
export interface RuntimeInfo {
  /** 绝对路径 */
  path: string;
  /** "system" | "bundled"（npm 另有 "bundled-bun"） */
  source: string;
  /** `<path> --version` 输出（失败为 null） */
  version: string | null;
}

/** 运行时诊断快照（Rust RuntimeDiagnostics） */
export interface RuntimeDiagnostics {
  bun: RuntimeInfo | null;
  npm: RuntimeInfo | null;
  /** 内嵌目录是否落位 */
  bundledDirExists: boolean;
  /** 内嵌 bun sha 校验：true=通过 / false=不符 / null=缺文件或不在清单 */
  bundledShaVerified: boolean | null;
}

export async function runtimeDiagnostics(): Promise<RuntimeDiagnostics> {
  return invoke<RuntimeDiagnostics>("runtime_diagnostics_cmd");
}

/** 运行时小字状态一行文案（如「bun 1.3.4（内嵌）· npm 10.9.4（系统）」）；
 *  全缺时返回兜底文案。纯函数便于单测。 */
export function runtimeSummaryLine(d: RuntimeDiagnostics | null): string {
  if (!d) return "运行时：未知";
  if (!d.bun && !d.npm) return "运行时：未找到 bun / npm";
  const parts: string[] = [];
  if (d.bun) {
    const src = d.bun.source === "bundled" ? "内嵌" : "系统";
    parts.push(`bun${d.bun.version ? ` ${d.bun.version}` : ""}（${src}）`);
  }
  if (d.npm) {
    const src = d.npm.source === "bundled-bun" ? "bun 兜底" : "系统";
    parts.push(`npm${d.npm.version ? ` ${d.npm.version}` : ""}（${src}）`);
  }
  return `运行时：${parts.join(" · ")}`;
}
