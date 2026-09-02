import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css"; // Tailwind v4 + 设计令牌层（P7 F-7-1/F-7-2）
import "highlight.js/styles/github.css"; // F-7-10 会改为随 data-theme 切换双主题

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
