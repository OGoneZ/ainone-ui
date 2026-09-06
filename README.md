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

### 调试方法论（AI agent 排查 UI 交互 bug 的标准流程）

p20 系列排查（光晕/焦点/快捷键）沉淀出的可复用套路，按序使用：

**1. 版本指纹先行**——先确认被测实例跑的是哪份代码。多 worktree 并行开发时，
1420 端口可能被别的 worktree 的 vite 占用，改完代码页面纹丝不动白查半天：

```bash
lsof -nP -iTCP:1420 -sTCP:LISTEN          # 端口归属进程
lsof -p <PID> | grep cwd                   # 该进程的工作目录 → 哪个仓/worktree
curl -s http://localhost:1420/src/index.css | grep <刚改的规则>   # 编译产物里有没有
```

页面内同样可验（绕开 fetch）：

```js
for (const s of document.styleSheets) { /* 遍历 cssRules 找目标规则 */ }
```

**2. 事件黑匣子**——「用户操作 → 应用无反应」类 bug，在 window 捕获阶段装探针，
记录真实事件的 `isTrusted`/坐标/命中元素，让用户复现一次后读日志：

```js
const bb = [];
window.addEventListener('pointerdown', e => bb.push({trusted: e.isTrusted,
  x: e.clientX, y: e.clientY, target: String(e.target.className).slice(0,30)}), true);
window.addEventListener('mousedown',  e => bb.push({type:'md', trusted: e.isTrusted}), true);
window.addEventListener('keydown',    e => bb.push({type:'kd', key: e.key,
  ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, trusted: e.isTrusted}), true);
// 键盘取证同理；存 localStorage 可跨 HMR/reload 存活
```

读日志时逐条核对：事件到没到 window？`isTrusted` 是 true 还是 false？
命中元素是否在预期容器内？

**3. WKWebView 的坑（本仓库实测，Chrome 复现不了）**：
- **原生鼠标点击不派发 pointerdown**（只有 mousedown+click；`PointerEvent`
  构造器存在但只对合成派发生效）→ 点击类全局监听必须用 `mousedown`
  （或双通道 + 200ms 去重）。合成 `dispatchEvent(new PointerEvent(...))`
  测试通过 ≠ 原生点击有效——p20m 之前被这个假象误导了数轮
- 后台窗口冻结 rAF 和 CSS transition（永远停在起始帧）→ 探测计算样式前先
  临时 `transition: none !important`，焦点等待用 `setTimeout` 不用 rAF
- WebDriver `element click` 走 trusted 管线但只派发 `click` 不带 `pointerdown`；
  不支持 Actions 端点 → 机器无法模拟真实点击，只能靠黑匣子 + 用户复现

**4. 合成事件对照实验**——黑匣子确认真实事件到达后，用合成事件逐级复现处理链，
哪一级断掉即问题所在：`dispatchEvent` 一直有效而真实无效 → 差异只在
isTrusted/原生管线；`elementFromPoint` 命中的元素和处理函数 `closest` 的
选择器对不上 → 命中判定漏分支。

**5. 布局/样式层叠问题用「边缘命中探测」**——光晕被盖、元素被裁类问题：

```js
// 对目标元素四边外扩 1px/4px 逐点采样，看每点 elementFromPoint 命中的是谁
document.elementFromPoint(x, y)  // 命中 splitter/邻居/容器 → 盖住者实锤
// 再配 getComputedStyle 读 z-index/position/overflow，祖先链找中间层叠上下文
// （transform/filter/isolation/z!=auto 的 position）判定谁压谁
```

**6. 提交纪律**：每个实锤根因单独小提交，commit message 里写清「症状 → 根因
证据 → 修法 → 验证数据」，下一个 agent 不用重查一遍。

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
