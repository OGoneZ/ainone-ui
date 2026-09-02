import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { attach, installConsoleForward } from "./lib/logger";
import "highlight.js/styles/github.css";

// 尽早接入日志：前端 console 转发到 log 插件（与 Rust 同文件落盘）+ Rust 日志灌入 devtools
void attach();
installConsoleForward();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
