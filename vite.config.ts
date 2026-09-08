/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// P32：应用版本号从 package.json 注入（设置页「版本与更新」显示），
// 单一事实源 = package.json（发布时与 tauri.conf.json 一并由门禁核对）。
const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // shadcn 组件用 `@/` 路径别名（见 components.json）
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // vitest：纯逻辑单测（node）+ 组件交互测试（jsdom）
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    globals: false,
    setupFiles: ["src/test/setup.ts"],
    environmentMatchGlobs: [
      // 组件测试（.test.tsx）跑 jsdom；纯逻辑 .test.ts 保持 node（更快、无 DOM 干扰）
      ["src/**/*.test.tsx", "jsdom"],
    ],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
