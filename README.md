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
pnpm tauri:dev    # 桌面应用（含 Rust 后端 + AI 调试桥，见「前端调试」）
pnpm tauri:build  # 打包 release（不含调试桥）
```

## 测试

```bash
pnpm test        # vitest：纯函数(node) + 组件交互(jsdom+testing-library)，56 条
pnpm test:e2e    # 真实 harness e2e 探针（按 PATH 自动跳过缺的 harness）
pnpm test:all    # 前端 + Rust cargo test + e2e 三件套
```

完整的分层策略、mock 约定、防回归护栏见 **`TESTING.md`**——接手重构前必读。

## 前端调试（AI agent 直连调试桥）

应用内置一个**仅 dev 生效**的调试桥（`tauri-plugin-webdriver`，W3C WebDriver 内嵌服务），
让 AI agent（或任意 HTTP 客户端）**直接驱动 WebView**：执行 JS、截图、查元素、读页面源码——
无需人工复制错误信息。

**生效条件**：`pnpm tauri:dev`（= `tauri dev --features webdriver`，显式启用 feature；仅 debug 构建注册插件）。
**打包不含**：`pnpm tauri:build` 不带该 feature，release 二进制完全不编译此插件。

### 使用方式

1. `pnpm tauri:dev` 启动应用后，调试桥监听 `127.0.0.1:4445`（可用 `TAURI_WEBDRIVER_PORT` 环境变量改端口）
2. 直接发 HTTP 请求驱动 WebView（POST body 为 WebDriver 协议格式）：

```bash
# 建会话（WebDriver 客户端均可：Selenium / WebdriverIO / 裸 curl）
SID=$(curl -s -X POST http://127.0.0.1:4445/session \
  -H 'Content-Type: application/json' \
  -d '{"capabilities":{}}' | jq -r .value.sessionId)

# 在 WebView 里执行任意 JS（查 DOM 状态 / 解卡 / 读取 store）
curl -s -X POST http://127.0.0.1:4445/session/$SID/execute/sync \
  -H 'Content-Type: application/json' \
  -d '{"script":"return document.querySelector(\".flexlayout__layout_overlay\").style.display","args":[]}'

# 截图（base64 PNG）
curl -s http://127.0.0.1:4445/session/$SID/screenshot | jq -r .value | base64 -d > shot.png
```

3. 常用端点：`POST /session`（建会话）、`POST /session/{id}/execute/sync`（执行 JS）、
   `GET /session/{id}/screenshot`（截图）、`GET /session/{id}/source`（页面源码）、
   `POST /session/{id}/element`（查元素，支持 css/xpath）

### 平台差异（为什么 macOS 需要这个桥）

| 平台 | WebView | 外部直连调试 |
| --- | --- | --- |
| Windows | WebView2 | ✅ 原生支持 `--remote-debugging-port`（CDP） |
| Linux | WebKitGTK | ✅ 原生支持 `WEBKIT_INSPECTOR_SERVER` |
| macOS | WKWebView | ❌ Apple 不提供远程调试端口；**人工调试用 Cmd+Option+I 打开 Safari Web Inspector** |

macOS 上 AI agent 无法直连 WebView，调试桥是唯一途径；人工调试时快捷键即可。

### 卡死自救（历史遗留问题：flexlayout 拖拽遮罩残留）

应用已内置自动恢复（mouseup 兜底隐藏残留遮罩）。若仍遇到「界面点不动」：

```bash
# 经调试桥远程解卡（或本地 Cmd+Option+I 在 Console 执行同样语句）
curl -s -X POST http://127.0.0.1:4445/session/$SID/execute/sync \
  -H 'Content-Type: application/json' \
  -d '{"script":"document.querySelectorAll(\".flexlayout__layout_overlay,.flexlayout__outline_rect,.flexlayout__edge_rect\").forEach(e=>e.style.display=\"none\")","args":[]}'
```

后端日志：`~/Library/Logs/com.zhubaoduo.ainone-ui/ainone-ui.log`。

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
