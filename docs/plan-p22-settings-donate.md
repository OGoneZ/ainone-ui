# P22 规格需求书：快问弹窗灵活性 + 设置页重构 + 双模型配置 + 打赏作者

> 状态：**待确认**。确认前不继续执行。
> 执行分支：worktree `settings-donate-ux`（基于 main，先 rebase 到最新 main）。

## 背景与问题

1. 选中文本的「批注/快速解释」悬浮窗（QuickAskPopup）尺寸死板：宽上限 360px，选中内容多时被截断（`overflow:hidden` + ellipsis），解释结果区 200px 封顶但滚动条体验差，长内容看不全。
2. 设置页（SettingsModal）排版混乱：适配器行是一排裸 input 平铺、快问配置区直接堆在底部，没有分区、没有层次，弹窗不限高，内容多时溢出。
3. 快问模型、语音服务需要用户手动填，门槛高。快问模型实际可以直接从本机 harness（Claude Code / Codex）的 settings 里取默认配置。
4. 无打赏入口。收款码原图在 `~/Downloads`（alipay.jpg 128K 1080x1620、wxpay.png 124K 1080x1468）。

## 前置事实（已探明）

- 本机 `~/.claude/settings.json` 存在：`env.ANTHROPIC_BASE_URL` + `env.ANTHROPIC_AUTH_TOKEN` + `env.ANTHROPIC_DEFAULT_HAIKU_MODEL`（Anthropic Messages 协议，`/v1/messages`）。
- 本机 `~/.codex/config.toml` + `auth.json` 存在：`base_url = https://codex.ysaikeji.cn/v1` + `OPENAI_API_KEY` + `model = gpt-5.4`（OpenAI 兼容协议）。
- 两种协议不同：Anthropic（`/v1/messages`，响应 `content[0].text`）≠ OpenAI 兼容（`/chat/completions`，响应 `choices[0].message.content`）。Rust 侧需支持两种调用协议，配置里记 `protocol` 字段。
- 项目已有 lucide-react（v1.39）依赖，图标纪律：组件禁散用，一律经 `src/components/ui/icons.ts` 语义映射入口。
- Tauri 密钥纪律：api_key 不回传 WebView 明文（config_get 只给 has_api_key），留空保存 = 保留既有密钥（quickask.rs 已按此实现，asr/新配置沿用）。

## 前置动作（执行第一步）

**A0. 同步 main 并去重**：main 已并行落地 `ac88c9b`（p21a），其中 ASR 配置化实现与本规格第 2 项几乎相同（另一会话完成）。执行时 rebase 到最新 main，**Rust 侧 ASR 实现以 main 为准，本 worktree 放弃重复实现**，只保留 main 缺的部分（ipc/asr.ts 的 `asrConfigGet/Save` TS 封装——main 只有 Rust 命令没有前端封装）。冲突时读 main 侧结构再合。

## 任务一：快问悬浮窗自适应尺寸 + 滚动

### 目标

弹窗宽度随内容自适应但有上限；选中文本区、解释结果区超限时内部滚动且滚动条可见；长内容不再被截断。

### 方案（已部分落地，随 A0 保留）

- `.quick-pop`：`width: max-content; max-width: min(480px, 72vw)`（短内容紧凑、长内容封顶 480px）。
- `.quick-pop-sel`（选中文本）：`max-height: 96px; overflow-y: auto`（原 hidden+ellipsis 改滚动）。
- `.quick-pop-body`（解释结果）：`max-height: min(40vh, 360px); overflow-y: auto`。
- 两区加 `overscroll-behavior: contain; word-break: break-word`（滚动不穿透、长串可断行）。

### 验收标准

| # | 验收项 | 判定方式 |
|---|--------|----------|
| 1.1 | 选中 ≤50 字：弹窗宽度紧凑（< 480px），无滚动条 | 实机选中短文本目测 |
| 1.2 | 选中 500+ 字：选中文本区封顶 96px，可滚动看到全部 | 实机选中长段目测 |
| 1.3 | 解释结果超 360px：区内滚动，可看全 | 实机触发长解释 |
| 1.4 | 弹窗不出屏（72vw/40vh 上限保证） | 小窗（半屏）下实测 |
| 1.5 | 点外/Esc 关闭、滚动关闭既有行为不回归 | `pnpm vitest run src/chat` 全绿 |

## 任务二：语音服务配置项

### 目标

语音服务 endpoint / api_key / model 可在设置页配置，持久化 `asr.json`，未配置回落默认值，旧部署零影响。

### 方案

- **Rust（main 已落地，直接采用）**：`AsrConfig { base_url, api_key, model }` → `app_config_dir()/asr.json`；`asr_config_get`（回 view：has_api_key 不给明文）/`asr_config_save`（留空 key = 保留旧值）；`effective_url/effective_model` 纯函数（配置 > `AINONE_ASR_URL` 环境变量 > `DEFAULT_*`）；`transcribe_to` 支持 bearer_auth。
- **本 worktree 补齐**：`src/ipc/asr.ts` 增加 `AsrConfigView/AsrConfigInput` 类型与 `asrConfigGet/asrConfigSave` 封装。

### 验收标准

| # | 验收项 | 判定方式 |
|---|--------|----------|
| 2.1 | 未配置时转写走默认端点 `asr.zhubaoduo.com`，行为与旧版一致 | cargo test effective_url/effective_model |
| 2.2 | 配置后按配置端点/模型发请求，key 走 `Authorization: Bearer` | 代码审读 + 手动配一次实测转写 |
| 2.3 | api_key 明文不回传（get 只给 has_api_key）；留空保存不丢旧 key | cargo test + 组件测试 |
| 2.4 | 设置页有「语音服务」分区（endpoint/model/key 三输入） | 组件测试断言 |
| 2.5 | asr.json 损坏时应用不崩溃、报可读错误 | 手动写坏 JSON 实测 |

## 任务三：快问模型自动取 harness settings

### 目标

快问模型默认自动取本机 harness 配置：探测 Claude Code 与 Codex 两份 settings，哪份能取到用哪份；设置页展示已配好的值与来源；用户可在设置里覆盖。

### 方案

**Rust 侧新增探测模块（`quickask.rs` 内或独立 `harness_probe.rs`）**：

- 探测顺序与结果：
  1. `~/.claude/settings.json` → 读 `env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_AUTH_TOKEN`、模型取 `env.ANTHROPIC_DEFAULT_HAIKU_MODEL`（轻量快问语义，回落 SONNET→OPUS→`model` 字段去 `[1m]` 后缀）→ `protocol = "anthropic"`，来源标记 `claude-code`。
  2. `~/.codex/config.toml` → `model_providers.*.base_url` + `model`；`~/.codex/auth.json` → `OPENAI_API_KEY` → `protocol = "openai"`，来源标记 `codex`。
  3. 两份都在 → **Claude Code 优先**（快问走 Anthropic 协议直连其网关，无需额外配置）。
  4. 都取不到 → 不自动配置，保持现状（手动填）。
- `quickask.json` 增加字段：`protocol: "openai" | "anthropic"`、`source: "auto:claude-code" | "auto:codex" | "manual"`。
- **自动探测时机**：`quickask_config_get` 时若配置为空（从未手动保存过）且文件不存在 → 执行探测并写入（一次性落盘，之后读缓存结果）。用户手动保存过（source=manual）则永不覆盖。
- **Rust 调用侧支持双协议**：
  - `protocol = "openai"`：现状不变（`/chat/completions`）。
  - `protocol = "anthropic"`：POST `{base}/v1/messages`，headers `x-api-key` + `anthropic-version: 2023-06-01`，body `{model, max_tokens, messages}`，取 `content[0].text`。
- base_url 归一化：Anthropic 侧用户写的 base 可能带尾斜杠/不带 `/v1`，拼 `/v1/messages` 前统一去尾斜杠。

### 验收标准

| # | 验收项 | 判定方式 |
|---|--------|----------|
| 3.1 | 本机实测：打开应用 → 设置页快问区已自动填好 claude-code 网关 + 模型，来源显示「自动：Claude Code」 | 实机验收 |
| 3.2 | 此状态下聊天里选中文本「快速解释」直接可用 | 实机验收 |
| 3.3 | 删除本机 claude settings（测试分支模拟）→ 回落 codex；都没有 → 留空不崩 | 单测（注入 home 路径参数） |
| 3.4 | 两份都在 → 取 claude-code | 单测 |
| 3.5 | 用户手动改过并保存 → 自动探测不再覆盖（含重启后） | 单测 + 实机 |
| 3.6 | anthropic 协议请求体/头/响应解析正确 | 单测（mock 响应解析 + 请求体构造纯函数） |
| 3.7 | 探测失败/JSON 损坏：静默降级为未配置，不影响应用启动 | 单测 |

## 任务四：设置页重排版 + 新配置项 UI

### 目标

设置弹窗排版清晰、可读；新增「语音服务」分区；快问分区展示来源；整体限高滚动。

### 方案

- 结构调整为两个分区（标题 + 描述行）：
  - **「模型服务」**：快问模型（含来源徽标：`自动：Claude Code` / `自动：Codex` / `自定义`，+「重新探测」按钮）与语音服务两组，各三输入（接口地址 / 模型名 / API Key），用现有 `.ns-label` 风格统一。
  - **「harness 适配器」**：现有适配器列表改为卡片式行（每行一张卡：id/名称/program/cwd/logo 网格两列排布，args textarea 独行，状态行 + 操作按钮行），替换现在 6 个 input 挤一行的平铺。
- 弹窗：`max-w-[720px]` 保持，内容区 `max-height: 70vh; overflow-y: auto`，底部操作栏（保存/关闭/新增）固定在弹窗底部不随滚动。
- 密钥输入保持 type=password + 「留空 = 保留既有密钥，已配置 ✓」占位语义。

### 验收标准

| # | 验收项 | 判定方式 |
|---|--------|----------|
| 4.1 | 打开设置：两个分区标题清晰，输入有 label，无裸 input 挤压 | 实机目测 |
| 4.2 | 内容超高时弹窗内滚动，保存/关闭按钮始终可见 | 缩小窗口实测 |
| 4.3 | 快问区显示当前来源徽标；点「重新探测」重新跑一次探测并刷新 | 实机 + 组件测试 |
| 4.4 | 语音服务区可填 endpoint/model/key 并保存成功 | 组件测试（mock invoke 断言 asr_config_save 调用） |
| 4.5 | 既有 SettingsModal 测试全绿（标题文案变化处同步更新） | `pnpm vitest run src/app/modals` |
| 4.6 | 保存链路：一次保存同时落 adapters + quickask + asr | 组件测试断言三次 invoke |

## 任务五：打赏作者按钮 + 弹窗

### 目标

主界面右上角「设置」左侧新增「打赏作者」入口，点开弹窗展示微信/支付宝两收款码 + 有趣文案；图片压缩后不影响扫码。

### 方案

- **图标**：lucide 现有图标选 `Heart`（或 `Coffee`），在 `icons.ts` 语义映射加 `DonateIcon = Heart`，组件从 icons.ts 取（遵守仓库纪律，不引入新图标库——lucide 已是本仓的社区图标方案，满足「社区成熟方案」金标准）。
- **图片压缩**（macOS 自带 `sips`，无新依赖）：
  - `alipay.jpg`：1080x1620 → 缩到宽 640（`sips -Z` 或 `--resampleWidth`），JPEG 质量 70（`-s formatOptions 70`）。
  - `wxpay.png`：1080x1468 → 缩到宽 640 转 JPEG（二维码底白，转 JPEG 前先贴白底避免透明通道发黑：sips 不支持合成底色，改用 `-s format png` 保持 PNG 仅缩尺寸，或用 `sips -s format jpeg` 后人工验码）。
  - **压缩后必须人工扫码验证一次**（微信/支付宝各扫一遍），不可识别则放宽尺寸重试。目标单张 ≤ 60KB。
  - 存放 `src/assets/donate/alipay.jpg`、`src/assets/donate/wxpay.png`，Vite import 引入。
- **UI**：toolbar 中 `<button>设置` 左侧加 `<button>打赏作者</button>`（图标 + 文字，与设置按钮同风格）；点击开 `DonateModal`（复用 shadcn Dialog）：
  - 标题：「请作者喝杯咖啡 ☕」
  - 两码并排（窄屏纵向堆叠），各配标签「微信支付」「支付宝」
  - 有趣文案：主句「你的鼓励是我修 bug 的最大动力（比 Coffee 更管用）」，辅句「金额不限，心意已收到」
  - Esc / 点外 / 右上 × 关闭。

### 验收标准

| # | 验收项 | 判定方式 |
|---|--------|----------|
| 5.1 | 按钮位于设置左侧，图标 + 文字，与现有按钮风格一致 | 实机目测 |
| 5.2 | 弹窗两码并排清晰、文案展示、可关闭（Esc/点外/×） | 实机 |
| 5.3 | 压缩后两图均能被微信/支付宝成功扫码（人工验证） | **人工扫码** |
| 5.4 | 单张图片 ≤ 60KB | `du -h` 检查 |
| 5.5 | 图标经 icons.ts 入口，无散用 lucide | 代码审读 |

## 提交策略

按任务分小提交（延续已开始的节奏），每提交前对应测试通过：

1. `chore: rebase main 去重`（A0）
2. 任务一（已在 0265b93，rebase 后保留）
3. 任务二收尾（ipc 层补齐，Rust 部分随 main）
4. 任务三（Rust 探测 + 双协议 + 前端展示，最大单项）
5. 任务四（设置页重构 + 测试更新）
6. 任务五（图片资源 + DonateModal + 按钮入口）

## 明确不做

- 不动主会话链路/quick_ask 之外的 agent 通信代码。
- 不给语音/快问配置加连接测试按钮（保持简单，出错靠调用时报错）。
- 不引入二维码生成/图片处理新依赖（sips 系统自带 + 压缩后人工验码）。
- 不在设置页引入 tab 组件（两个分区纵向排布 + 限高滚动足够，避免过度设计）。
