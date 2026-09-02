# ainone-ui · Agent in One

统一多 harness 的 **ACP**（Agent Client Protocol）桌面客户端。一个窗口同时驱动多个本地 AI coding agent，把它们都接进同一套现代聊天界面。

**核心边界**：只做「对话/展示前端」，LLM 调用全程留在原 harness 内，不代理、不重造轮子。

## 支持的 harness

| 名称          | ACP 桥接程序                           | 备注                                   |
| ------------- | -------------------------------------- | -------------------------------------- |
| Oh My Pi      | `omp acp --model <model>`              | 需先配置 `~/.omp/agent/models.yml`     |
| Pi            | `pi-acp`                               | 需先配 LLM API key                     |
| Claude Code   | `claude-agent-acp`                     | 官方 ACP 桥接器                        |
| Codex         | `codex-acp`                            | 需 OpenAI 账号可用额度                 |
| OpenCode      | `opencode acp`                         |                                        |

harness 未安装或未配置凭据时，对应下拉项会标记「未安装」，不影响其他 harness。

## 开发

```bash
pnpm install
pnpm dev          # 前端 vite
pnpm tauri dev    # 桌面应用（含 Rust 后端）
```

## 测试

```bash
pnpm test        # vitest：纯函数(node) + 组件交互(jsdom+testing-library)，56 条
pnpm test:e2e    # 真实 harness e2e 探针（按 PATH 自动跳过缺的 harness）
pnpm test:all    # 前端 + Rust cargo test + e2e 三件套
```

完整的分层策略、mock 约定、防回归护栏见 **`TESTING.md`**——接手重构前必读。

## 架构

```
src/acp/           协议层（零 Tauri 依赖，可被 bun 探针直接复用）
  session-core.ts  ACP 客户端核心：JSON-RPC 队列、session/new|load、工具/权限/fs 回调
  turn.ts          流式事件 → 气泡块（text/thought/tool）累加
  message-log.ts   本地消息日志（JSONL）序列化/解析
  slash.ts         / 命令补全过滤
src/store/         zustand 运行时 store + Tab 去重纯函数
src-tauri/src/     Rust 后端：子进程管理 + fs 读写信道 + 消息日志存盘
```

**关键决策**（详见 `docs/plan.md` DEC-*）：ACP 用官方 TS SDK；传输层为 Rust 自管子进程（不经 capability 白名单，配置驱动的 adapter 无需逐个注册）；历史回填用本地 JSONL 日志（单一真源），ACP 回放仅供 agent 内部上下文。

## 计划

- `docs/plan.md` —— v1 基线（P0–P3，已 tag 至 v0.3.0）
- `docs/plan-v2.md` —— v2 基线（P4 现代聊天体验 / P5 工作区 / P6 会话状态）
- `docs/acceptance/` —— 各期验收记录
