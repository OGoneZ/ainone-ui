// P7 F-7-0 冒烟专用入口：验证 Tailwind v4 在目标 WebKitGTK 能正确渲染
// 规格书点名的三处基线特性：@property 声明、oklch() 颜色、color-mix()。
// 每处一个可见色块 + 数值标签；渲染正确 = 三色块颜色符合预期（截图留档）。
//
// 这是临时入口，跑完冒烟即还原 index.html 指向 src/main.tsx，本文件不参与业务。

import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";

function Smoke() {
  return (
    <div style={{ padding: 24, fontFamily: "sans-serif", display: "grid", gap: 16 }}>
      <h1 style={{ fontSize: 18, margin: 0 }}>P7 F-7-0 WebKitGTK 冒烟</h1>
      <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
        三处基线特性：@property / oklch() / color-mix()。色块颜色正确即渲染通过。
      </p>

      {/* 1. oklch() 颜色：品牌蓝近似 oklch(60% 0.18 260) */}
      <div>
        <div data-smoke="oklch" style={{ width: 120, height: 48, background: "oklch(60% 0.18 260)", borderRadius: 8 }} />
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>oklch(60% 0.18 260) → 品牌蓝</span>
      </div>

      {/* 2. color-mix()：蓝 + 白 50% → 浅蓝 */}
      <div>
        <div data-smoke="color-mix" style={{ width: 120, height: 48, background: "color-mix(in srgb, oklch(60% 0.18 260) 50%, white)", borderRadius: 8 }} />
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>color-mix(蓝 50% + 白) → 浅蓝</span>
      </div>

      {/* 3. @property 动画：background 从红到蓝的过渡（WebKitGTK 支持 @property 才能平滑过渡） */}
      <style>{`
        @property --smoke-bg {
          syntax: '<color>';
          inherits: false;
          initial-value: #ff0000;
        }
        .smoke-property {
          animation: smoke-shift 3s ease-in-out infinite alternate;
        }
        @keyframes smoke-shift {
          from { --smoke-bg: #ff0000; }
          to   { --smoke-bg: #0066ff; }
        }
      `}</style>
      <div>
        <div
          data-smoke="property"
          className="smoke-property"
          style={{ width: 120, height: 48, background: "var(--smoke-bg)", borderRadius: 8 }}
        />
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>@property 动画（红↔蓝过渡）</span>
      </div>

      {/* 4. Tailwind v4 工具类自身发射：bg-primary（oklch var）+ ring（color-mix） */}
      <div>
        <div
          data-smoke="tailwind"
          className="bg-primary ring-2 ring-primary/50 rounded-lg"
          style={{ width: 120, height: 48 }}
        />
        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Tailwind 工具类（bg-primary + ring color-mix）</span>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Smoke />
  </React.StrictMode>,
);
