// vitest 组件测试环境：注入 jest-dom 匹配器 + 全局 mock Tauri IPC。
//
// 所有组件测试都在 node/jsdom 里跑（无需 Tauri 运行时）；@tauri-apps/api 的
// invoke 走 window.__TAURI_INTERNALS__，此处在每个测试里用 vi.mock 覆盖，
// 也可在此默认挂一个「全命令返回 null」的兜底，防止组件挂载时的首屏 invoke
// 抛错污染测试。

import "@testing-library/jest-dom/vitest";

// jsdom 缺 matchMedia（App 主题跟随系统用到），这里补一个恒返回 light 的桩。
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
