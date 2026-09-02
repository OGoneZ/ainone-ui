# ainone-ui 测试策略与 Agent 交接指南

本文回答两个问题：**测试怎么构建**、**怎么防止回归**。核心目标：让接手这个仓库的 Agent（或人）能靠 `pnpm test` + `pnpm test:e2e` 放心重构，而不是靠肉眼点界面。

---

## 1. 分层：每层测什么、怎么跑

| 层 | 手段 | 文件位置 | 命令 | 依赖真实 harness |
|---|---|---|---|---|
| **纯函数** | vitest（node） | `src/**/*.test.ts` | `pnpm test` | 否 |
| **组件交互** | vitest + jsdom + testing-library | `src/**/*.test.tsx` | `pnpm test` | 否（mock `openSession`） |
| **Rust 逻辑** | `cargo test` | `src-tauri/src/**` | `cd src-tauri && cargo test` | 否 |
| **协议层 e2e** | bun 探针（复用生产 `session-core.ts`） | `tools/spike/e2e-*.ts` | `pnpm test:e2e` | 是（按 PATH 自动跳过缺的） |
| **GUI 冒烟** | `tauri dev` 手动 | — | — | 是 |

一条铁律（写进 plan 的 DEC-8）：**e2e 探针直接 `import` 生产代码，不写第二份副本**。测的就是前端真实在用的协议逻辑。

---

## 1.1 日志体系（定位问题的入口）

**位置**：

- **前端日志**：统一走 `src/lib/logger.ts` 的 `logger`（`trace/debug/info/warn/error`），不要直接用 `console.*`。
  `main.tsx` 已 `installConsoleForward()`——即使散落的 `console.*` 也会被转发进日志文件。
- **Rust 日志**：`log::info!/warn!/error!`（`tauri-plugin-log`）。
- **落盘文件**（三平台）：

```text
macOS   ~/Library/Logs/com.zhubaoduo.ainone-ui/ainone-ui.log
Linux   ~/.local/share/com.zhubaoduo.ainone-ui/logs/ainone-ui.log
Windows %LOCALAPPDATA%/com.zhubaoduo.ainone-ui/logs/ainone-ui.log
```

- 1MB 轮转、KeepAll 保留、本地时区；dev 下同时打到 stdout 与浏览器控制台。

**当前埋点覆盖的关键链路**：

| 层 | 埋点 |
|---|---|
| Rust | 启动、agent spawn/kill/退出/进程错误、fs_read/fs_write、sessions/workspaces 索引损坏 |
| 前端 bridge | spawn 成功、进程错误、进程退出 |
| 前端 session | openSession、session/new、session/load、session/prompt 起止、session/cancel、dispose |
| 前端 chat | prompt 失败（含 error 汇总）|

**定位套路**：报错时先看日志文件里的 `[session]`/`[acp]`/`[agent]` 前缀，按时间轴串起来：spawn → initialize → new/load → prompt 起止 → 进程退出。前端 `[chat] prompt 失败` 与 Rust `[agent]` 进程错误通常是同一条故障链。

---

## 2. 为什么这么分层

- **纯函数层是地基**：协议解析、消息序列化、turn 累加、状态推导、去重、slash 过滤、路径规范化……凡是「输入确定 → 输出确定」的，全抽纯函数 + node 单测。快（几十 ms）、稳、可穷举边界。
- **组件层不碰真实 Tauri**：`@tauri-apps/api` 的 `invoke` 走 `window.__TAURI_INTERNALS__`，用 `src/test/mockIpc.ts` 注入假后端；`openSession` 用 `vi.mock` 替换，直接驱动 `session.prompt` 的 `onOutgoing` 回调模拟 ACP 事件流。**这层能抓到「白屏」这类渲染/状态 bug**（2026-09-02 的 `Maximum update depth exceeded` 白屏就是先在这里复现定位的）。
- **真实 harness e2e 是「慢」的最后一道**：验证协议层与真实 omp/claude-agent-acp 的互通。它依赖本机装了 harness，所以 `run-e2e.sh` 按 `command -v` 探测，缺了就跳过而不报错。

---

## 3. 关键 mock 约定（写测试前必读）

### mock IPC（组件/App 测试）

```ts
import { mockTauriIpc } from "../test/mockIpc";

mockTauriIpc({
  handlers: {
    adapters_list: () => [...],
    sessions_list: () => [...],
    workspaces_list: () => [...],
    log_read: () => "",   // 未声明的命令默认 resolve(null)
  },
});
```

### mock 虚拟列表（ChatPanel/App 用到了 react-virtual）

jsdom 容器高度为 0，`getVirtualItems` 返回空数组会导致消息不渲染。组件测试里固定用：

```ts
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => {
    const items = Array.from({ length: opts.count }, (_, i) => ({ key: i, index: i, start: 0 }));
    return { getTotalSize: () => opts.count * 80, getVirtualItems: () => items, measureElement: () => {} };
  },
}));
```

### zustand 状态隔离

每个测试 `beforeEach` 里 `useSessionStore.setState({ runtime: {}, commands: {} })`，否则上个测试的状态会泄漏进来。

### jsdom 环境标记

组件测试文件头加 `// @vitest-environment jsdom`；纯函数 `.test.ts` 保持 node（更快）。

---

## 4. 怎么防回归（给 Agent 的护栏）

1. **跑全套**：`pnpm test:all` = vitest + cargo test + e2e（自动跳过缺 harness 的）。重构前后各跑一次，diff 无新失败才算完。
2. **每修一个 bug，先补一个能红→绿的测试**（红绿开发）。特别是「显示未归组」「白屏」这类，光改代码不够，要有测试钉住。
3. **验收标准 = 测试**：`docs/plan-v2.md` 每条 AC-* 都应对应至少一条能失败的测试。找不到测试支撑的 AC，等于没实现。
4. **别在已有测试外套 `skip` 或放宽断言**来「修绿」。测试失败 = 行为变了，要么修代码，要么（若需求真改了）改规格文档 + 改测试，两者都改并说明。
5. **e2e 探针不可删注释里的断言**：每个探针末尾是 `process.exit(命中 ? 0 : 1)`，它本身就是 CI 闸门，不是临时脚本。

---

## 5. 加新功能时的检查清单

- [ ] 有纯逻辑 → 抽进 `src/store/*.ts` 或 `src/acp/*.ts` + node 单测
- [ ] 有 UI 交互 → `src/components/*.test.tsx` 用 mock IPC / mock session 覆盖
- [ ] 有 Rust 数据命令 → `src-tauri/src/*.rs` `#[cfg(test)]` 单测
- [ ] 有协议互通 → 新 `tools/spike/e2e-*.ts` 并注册进 `tools/run-e2e.sh`
- [ ] `pnpm test:all` 全绿后才提交

---

## 6. 当前测试规模

- vitest：**56 条**（纯函数 47 + 组件 ChatPanel 3 + App 编排 3 + 路径规范化 3）
- Rust：**7 条**
- e2e 探针：**7 个**（load / p4-history / steering / markdown / parallel / pi / perf）

> 这份清单是「越详尽越好」的起点，不是终点。每修一个 bug、每加一个功能，都应按上面清单扩一步测试。
