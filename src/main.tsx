import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { attach, installConsoleForward } from "./lib/logger";
import "./index.css"; // Tailwind v4 + 设计令牌层（P7 F-7-1/F-7-2）
// P11：katex 公式字体样式（Streamdown math 插件要求）
import "katex/dist/katex.min.css";

// 尽早接入日志：前端 console 转发到 log 插件（与 Rust 同文件落盘）+ Rust 日志灌入 devtools
void attach();
installConsoleForward();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
