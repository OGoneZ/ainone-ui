// 基准 C：zustand persist 每次 set 落盘成本 —— 验证流式期间高频 set × persist 的真实开销
// 复刻 sessionStore 的 persist 配置（partialize 只取 commands），测量 set→localStorage.setItem
// 的单次成本，以及「commands 含全量模型白名单」时的量级
import { performance } from "node:perf_hooks";

// 模拟 zustand persist 的 setItem 路径：partialize → JSON.stringify → localStorage.setItem
// jsdom 的 localStorage 落在内存，测量近似但会低估真实 WebView 的同步 IO。
// 这里直接量 stringify + 写入的结构性成本。
const commands = {
  claude: Array.from({ length: 40 }, (_, i) => ({ name: `model-gateway-alias-${i}`, description: "Available model from gateway probe" })),
};

function partialize(s) { return { commands: s.commands }; }

const store = { commands };
// warmup
for (let i = 0; i < 100; i++) JSON.stringify(partialize(store));

const N = 2000;
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const json = JSON.stringify(partialize(store));
  globalThis.__sink = json.length;
}
const dt = performance.now() - t0;
console.log(`persist setItem 路径（partialize+stringify）: ${(dt / N).toFixed(3)} ms/次 × 每帧 2 次 set = ${((dt / N) * 2).toFixed(3)} ms/帧`);
console.log(`payload 大小: ${(JSON.stringify(partialize(store)).length / 1024).toFixed(1)}KB`);
// 结论判据：若 <0.1ms/帧 则 persist 不是主要矛盾
