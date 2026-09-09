// P33 F-32-3 自动更新前端封装：检查更新 + 下载安装 + macOS 降级判定。
// tauri-plugin-updater JS API。版本比较/验签/下载全在插件（Rust 侧），不自研。

import { check, type Update } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";

/** 检查结果（UI 三态） */
export interface CheckResult {
  /** "up-to-date"：已是最新；"available"：有新版；"error"：检查失败 */
  kind: "up-to-date" | "available" | "error";
  /** kind=available 时的新版本号与更新说明 */
  version?: string;
  notes?: string;
  /** 原始 Update 句柄（downloadAndInstall 用），仅前端内存持有 */
  update?: Update;
  /** kind=error 时的原因 */
  message?: string;
}

/** 检查更新（查询 endpoints 的 latest-updater.json，插件内部比对版本+验签清单） */
export async function checkForUpdate(): Promise<CheckResult> {
  try {
    const update = await check();
    if (!update) return { kind: "up-to-date" };
    return { kind: "available", version: update.version, notes: update.body ?? "", update };
  } catch (e) {
    return { kind: "error", message: String(e) };
  }
}

/** 下载并安装（Windows passive 安装 / Linux 替换 AppImage；macOS 不应调用——UI 降级为跳下载页） */
export async function downloadAndInstall(update: Update, onProgress?: (received: number, total: number | null) => void): Promise<void> {
  let received = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        onProgress?.(0, event.data.contentLength ?? null);
        break;
      case "Progress":
        received += event.data.chunkLength;
        onProgress?.(received, null);
        break;
      case "Finished":
        onProgress?.(received, received);
        break;
    }
  });
}

/** 是否 macOS（未签名 → updater 安装路径不可用，UI 降级「前往下载页」） */
export function isMacOS(): boolean {
  return navigator.userAgent.includes("Macintosh");
}

/** 官网门户站（官网 / 更新日志 / 下载页同域） */
const WEBSITE_URL = "https://agent.zhubaoduo.com";

/** 官网首页（设置页「官方网站」入口） */
export async function openWebsite(): Promise<void> {
  await openUrl(`${WEBSITE_URL}/`);
}

/** 更新日志（官网 devlog 页，hash 路由） */
export async function openChangelog(): Promise<void> {
  await openUrl(`${WEBSITE_URL}/#/devlog`);
}

/** 打开下载页（macOS 降级路径 + 「前往 Release」入口） */
export async function openDownloadPage(): Promise<void> {
  await openUrl(`${WEBSITE_URL}/`);
}
