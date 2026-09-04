// P11 渲染增强 · 视觉验收专用入口（`pnpm dev` 后浏览器带 ?demo=1 参数生效）。
//
// 作用：浏览器直开 http://localhost:1420/?demo=1 时，不走 Tauri 后端与真实 harness，
// 直接把一份「覆盖全部 P11 渲染特性」的假会话灌进 sessionStore，供肉眼验收：
//   - F-R1 GFM 全要素（标题/表格/任务列表/删除线/引用）
//   - F-R1 raw HTML 安全（script 以文本呈现）
//   - F-R2 代码块（语言标签/复制/横向滚动）+ F-R3 mermaid + F-R4 KaTeX
//   - F-R5 图片（lazy + lightbox）
//   - F-R6 工具输出（JSON pretty / ANSI 彩色 / 折叠 / diff）
//   - F-R8 thinking 走 markdown（折叠卡片「已思考 N 秒」）
//
// 与生产入口的切换点只有一个：URL 带 ?demo=1。Vite build 会 tree-shake 掉
// demoMode 为 false 的分支引用不到的代码？不会——本文件本身静态 import Demo，
// 但 Demo 只在 demo 分支渲染，且 tauri build 的入口同样是本文件，无副作用
// （Demo 不发任何请求）。若想彻底排除，可将 import 改为动态 import。

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DemoApp } from "@/demo/DemoApp";
import { attach, installConsoleForward } from "@/lib/logger";
import "@/index.css"; // Tailwind v4 + 设计令牌层（P7 F-7-1/F-7-2）
// P11：katex 公式字体样式（Streamdown math 插件要求）
import "flexlayout-react/style/light.css"; // P10 分屏基础样式（主题色映射见 index.css）
import "katex/dist/katex.min.css";

// 浏览器预览（非 Tauri）下 logger 依赖的 invoke 不存在 → 不接入，避免报错
const isTauri = "__TAURI_INTERNALS__" in window;
if (isTauri) {
  void attach();
  installConsoleForward();
}

const demoMode = new URLSearchParams(window.location.search).has("demo");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{demoMode ? <DemoApp /> : <App />}</React.StrictMode>,
);
