# P29 规格需求书：分发就绪——一键补齐 Harness + 配置文件代写 + 设置页重排

> 状态：**已确认**（用户三轮对话共识，2026-09-07）。
> 执行分支：main（小步提交，每步全绿后 commit，不做超级大提交）。

## 0. 背景与共识

分发目标：新用户装好应用后，零终端知识用上五种 harness（Claude Code / Codex / Pi / omp / OpenCode）。

三轮对话确立的共识：

1. **两层补齐，天然解耦**：装 harness 本体 CLI 与装 ACP 桥是两步，但应用内自动串联。CLI 装完即使装桥失败，CLI 保留——下次打开识别 CLI 已在，只需重装桥。两步绝不耦合。
2. **订阅用户零配置**：Claude Code / Codex 已有订阅（OAuth 登录）的用户不需要任何配置，UI 要能识别并显示「已登录」。
3. **配置文件代写**：支持自定义第三方 endpoint/key/model——由用户填三格表单，应用帮他生成或**合并修改** harness 原生配置文件。已有文件只改指定键，绝不整体覆盖。
4. **状态显示区分「CLI 未装」与「只差 ACP 桥」**，两者都一键安装补齐。

## 0.1 前置事实（已探明）

### 五家 harness 的配置文件映射（社区调研 + 本机验证）

| Harness | 本体安装（免 sudo，用户级） | 配置文件 | endpoint / key / model 的键位 |
|---|---|---|---|
| Claude Code | 官方脚本 `claude.ai/install.sh` → `~/.local/bin/claude` | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL` / `env.ANTHROPIC_AUTH_TOKEN` / 顶层 `model` |
| Codex | `bun i -g @openai/codex`（npm 回退） | `~/.codex/config.toml` | `model` + `model_provider` + `[model_providers.<id>]` 的 `base_url`/`env_key`/`wire_api` |
| Pi | `@mariozechner/pi-coding-agent`（bun/npm 全局，bin=pi，已 npm view 核实） | `~/.pi/agent/models.json` | `providers.<id>.baseUrl`/`apiKey`/`api` + `models[].id` |
| omp | `@oh-my-pi/pi-coding-agent`（bun/npm 全局，bin=omp，已核实） | `~/.omp/agent/models.yml` | 同 Pi（YAML 形态） |
| OpenCode | 官方脚本 `opencode.ai/install`（装到 `~/.opencode/bin`，**不在既有增强 PATH**→ env_path.rs 补该目录；脚本支持 `--no-modify-path`，传之以兑现「不写 shell profile」） | `~/.config/opencode/opencode.json` | `provider.<id>.options.baseURL`/`apiKey` + `models.{<model>: {name}}` + 顶层 `model` |

### 认证态探测依据（本机验证过文件结构）

- Claude Code：settings env 有 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` = API 配置态；`~/.claude/.credentials.json`（OAuth 字段）= 订阅登录态。
- Codex：`~/.codex/auth.json` 有 `tokens` = ChatGPT 订阅；有 `OPENAI_API_KEY` = API 态（`harness_probe.rs` 现只认后者）。
- Pi / omp：`~/.pi/agent/auth.json`（本机为空对象 = 未配置；非空 = 已配置）。
- OpenCode：`~/.local/share/opencode/auth.json` 非空 = 已配置。

### 既有基建（直接复用）

- `connector.rs` `run_install`：逐行进度 Channel、串行锁、bun→npm 回退、15min 超时、失败清半成品——装 CLI 完全同构。
- `env_path.rs` 增强 PATH 已覆盖 `~/.local/bin`、`~/.bun/bin`、nvm——claude/codex/omp/pi 装完即被 `find_program` 命中；OpenCode 落点 `~/.opencode/bin` 需在本模块补一行（S1 顺带）。
- `serde_json` 需开 `preserve_order` feature（S3 合并写保键序）；`toml_edit`（S3 codex）、`serde_yaml`（S3 omp）届时按需引入。
- `adapters.rs` 三态 ready/installable/absent + `bridge_status` 纯函数（单测覆盖）。
- `agent.rs` spawn 时 `envs()` 注入能力（codex 的 env_key 机制要用）。
- 前端 `installBridge(program, onLine)` 进度流模式（P28）。

## 0.2 范围外（明确不做）

- 不做 OAuth 登录流程自动化（浏览器跳转登录交给内嵌终端或用户自己的终端；本期只做「识别登录态」）。
- 不动快问（quickask）的探测逻辑——它已有独立的 claude/codex 探测链且工作正常。
- 不做 Windows（仓库现状不支持）。
- 不替用户写 shell profile。

---

## 任务一：CLI 一键安装（Rust 侧）

### 目标

五种 harness 本体 CLI 在应用内一键安装。CLI 安装与桥安装解耦：任一步失败不回滚已成功的部分；重启后按真实状态重新判定，可从断点继续补齐。

### 方案

**`connector.rs` 新增 `CLI_INSTALLERS` 表**（与 `BRIDGES` 平行的登记表，新增 harness = 加一行）：

```rust
pub struct CliSpec {
    pub program: &'static str,           // find_program 检索名
    pub display: &'static str,           // 错误文案用
    pub candidates: &'static [CliCandidateKind],
}

pub enum CliCandidateKind {
    /// 官方安装脚本：curl -fsSL <url> -o <tmp> && sh <tmp>（两步 argv，不跑 shell 管道）
    Script { url: &'static str },
    /// 包管理器全局安装
    Package { runtime: Runtime, pkg: &'static str },  // Runtime = Bun | Npm
}
```

候选链有序尝试，脚本型优先（无 node/bun 依赖）。全部 URL 与包名已实机核实（2026-09-07：两脚本 200 可达、三个 npm 包 bin 名匹配）：

| program | 候选链 | 落点 |
|---|---|---|
| claude | Script(`https://claude.ai/install.sh`) | `~/.local/bin/claude`（本机验证：symlink → ~/.local/share/claude/versions/*） |
| opencode | Script(`https://opencode.ai/install` + `--no-modify-path`) | `~/.opencode/bin/opencode`（env_path.rs 需补该目录） |
| codex | Package(Bun, `@openai/codex`) → Package(Npm, `@openai/codex`) | bin=codex |
| omp | Package(Bun, `@oh-my-pi/pi-coding-agent`) → Package(Npm, 同) | bin=omp |
| pi | Package(Bun, `@mariozechner/pi-coding-agent`) → Package(Npm, 同) | bin=pi |

**候选可用性判定**（纯函数，单测覆盖）：Script 恒可用；Package 需对应 runtime 在（bun/npm）。全部候选不可用 → 报缺失运行时文案。

**新命令 `cli_install(app, program, on_event: Channel<CliEvent>)`**：复用 `run_install` 机制（锁、超时、逐行进度），装完以 `find_program` 验证命中（CLI 无 marker，真值即验证）；未命中报错并展示输出尾迹。失败**不清理任何东西**（与装桥不同：CLI 装到系统用户目录，无半成品目录概念）。

**三态扩为四态**（`adapters.rs`）：

- `ready`：CLI 在 + （桥程序）桥在 —— 可用
- `installable`：CLI 在 + 桥不在但可装（P28 语义不变）
- `cli_installable`：**新增**。CLI 不在但存在可用安装候选 → 一键装 CLI
- `absent`：CLI 不在且无可用候选（文案点名缺什么，如「缺 bun/npm」）

`AdapterStatus` 增 `cli: Option<CliInstallInfo>`（`{ display, installable, missing_runtime }`），供 absent/cli_installable 文案与按钮态。非桥程序的 installable 概念不变（无桥即 ready/absent 二态 + 新增 cli_installable）。

**安装串联不进 Rust**：串联由前端编排（装 CLI 成功 → 刷新三态 → 自动接 `install_bridge`），保证两步解耦、失败停在失败处。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 1.1 | `cli_status` 纯函数：脚本候选恒 installable；包候选按 bun/npm 在否判定；全缺 → absent | cargo test |
| 1.2 | 四态序列化为 `ready/installable/cli_installable/absent` 小写字面量 | cargo test |
| 1.3 | `cli_install` claude 实机：装到 `~/.local/bin/claude`，进度 Channel 逐行回显，装完 `adapter_status` 变 `installable`（CLI 在、桥未装） | 实机（先改名隐藏本机 claude 验证，验后还原） |
| 1.4 | CLI 装完、桥装失败 → 重启应用 `adapter_status` 报 `installable`（CLI 保留可识别） | 实机 + 代码走查（cli_install 失败路径无清理） |
| 1.5 | 装桥失败路径现状（清半成品）不回归 | cargo test 存量全绿 |
| 1.6 | 并发 cli_install 串行化（同 install_lock 或独立锁） | 代码走查 + 存量模式一致 |

## 任务二：认证态探测

### 目标

`adapter_status` 透出每个 harness 的认证态，UI 可显示「✓ 订阅已登录 / ✓ API 已配置 / 未配置」——兑现「订阅用户零配置」的可见性。

### 方案

**`adapters.rs` 新增 `auth` 模块**（纯函数 + home 注入，单测覆盖）：

```rust
pub struct AuthInfo {
    pub state: AuthState,  // Subscription | Api | None
    pub detail: String,    // 文案细节
}
```

探测规则（全部只读文件、不读内容到 WebView、不回传密钥）：

- claude：`~/.claude/.credentials.json` 存在且含 OAuth 字段 → Subscription；settings env 有 `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` → Api；否则 None。
- codex：`auth.json` 有 `tokens` → Subscription；有 `OPENAI_API_KEY` → Api；否则 None。
- pi / omp：`auth.json` 存在且非空对象 → Api（detail「已配置」）；否则 None。
- opencode：`~/.local/share/opencode/auth.json` 存在且非空对象 → Api；否则 None。

`AdapterStatus` 增 `auth: AuthInfo`（三态序列化小写）。探测失败（文件读不了）一律 None，不报错。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 2.1 | 各家探测纯函数：fixtures 矩阵（订阅/API/无/文件缺失/JSON 损坏）全覆盖 | cargo test |
| 2.2 | 实机：本机 claude（env TOKEN）→ Api；codex（OPENAI_API_KEY）→ Api | 实机 adapter_status 输出 |
| 2.3 | 不回传密钥明文（AuthInfo 只有 state + detail） | 代码走查 + 结构体字段审查 |

## 任务三：配置文件读与合并写（Rust 侧）

### 目标

用户在表单填 endpoint / key / model 三格 → 应用帮他生成或**合并修改** harness 原生配置文件。已有文件只替换指定键，其余键、结构、顺序（TOML 含注释）原样保留。写前备份。

### 方案

**新模块 `src-tauri/src/harness_config.rs`**：

```rust
/// 读当前配置（回显表单；key 不回传明文）
pub struct HarnessConfigView {
    pub endpoint: String,
    pub has_api_key: bool,
    pub model: String,
    pub source_file: String,   // 展示「写入哪个文件」
    pub present: bool,         // 配置文件是否存在（false = 将新建）
}

/// 保存输入
pub struct HarnessConfigInput {
    pub program: String,       // 按预置 adapter 的 program 分派（claude/codex/pi/omp/opencode）
    pub endpoint: String,
    pub api_key: String,       // 留空 = 保留既有（与 quickask 纪律一致）
    pub model: String,
}
```

**写入规则（合并语义，provider id 统一 `ainone`）**：

- **claude**（`~/.claude/settings.json`）：读全文 → `serde_json`（开 `preserve_order`）parse → `env.ANTHROPIC_BASE_URL = endpoint`、`env.ANTHROPIC_AUTH_TOKEN = key`（仅在用户填了 key 时写）、顶层 `model = model` → 写回。env 对象不存在则创建；其余键（permissions/hooks/…）一律不动。键不存在 = 添加，存在 = 替换。
- **codex**（`~/.codex/config.toml`）：`toml_edit` 格式保留编辑——顶层 `model`、`model_provider = "ainone"`、`[model_providers.ainone]`（`name`/`base_url`/`env_key = "AINONE_CODEX_API_KEY"`/`wire_api = "responses"`）。key **不写 toml**（Codex 官方 env_key 机制）：key 存 `appConfigDir/harness-keys.json`（app 自管），spawn 时 `agent.rs` 注入 env `AINONE_CODEX_API_KEY`。
- **pi**（`~/.pi/agent/models.json`）：`providers.ainone = { baseUrl, api: "openai-completions", apiKey, models: [{ id: model }] }`。
- **omp**（`~/.omp/agent/models.yml`）：serde_yaml 同构写（YAML 无注释保留要求，最后做）。
- **opencode**（`~/.config/opencode/opencode.json`）：`provider.ainone = { npm: "@ai-sdk/openai-compatible", name: "ainone", options: { baseURL, apiKey }, models: { "<model>": { name: "<model>" } } }` + 顶层 `model = "ainone/<model>"`。

**通用保障**：写前备份为 `<file>.ainone-bak`（覆盖上一次备份，不留堆积）；目标目录不存在则创建；JSON 损坏/解析失败 → 报错不写（绝不覆盖损坏文件）；save 返回写入的文件路径供 UI 展示。

**codex env 注入**：`agent.rs` spawn 时若 program 是 `codex`（经桥）→ 读 `harness-keys.json` 中的 codex key → `envs()` 注入 `AINONE_CODEX_API_KEY`。key 缺失不注入（桥报原生错误）。

**读回显**：`harness_config_read(program)` 按上表反向读（claude 读 settings env / codex 读 toml provider ainone / pi 读 models.json / omp 读 yml / opencode 读 json）。claude 复用 `harness_probe.rs` 已有的解析纯函数。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 3.1 | claude 合并写：已有 settings.json（含 permissions/hooks 等无关键）只变 env 三键 + model，其余键序与内容逐字节不变 | cargo test（输入 fixture → 断言输出 JSON 等价 + 无关键集合不变） |
| 3.2 | claude env 对象不存在 → 创建 env 并写入 | cargo test |
| 3.3 | JSON 损坏文件 → 报错且原文件未被改动 | cargo test |
| 3.4 | codex toml_edit：已有 config.toml 带注释 → 写入后注释与既有键保留，ainone provider 增/改正确 | cargo test |
| 3.5 | 写前备份生成 `<file>.ainone-bak` 且内容为写前原文 | cargo test |
| 3.6 | key 留空 = 保留既有 key（claude settings 不丢 AUTH_TOKEN；codex keys.json 不覆盖） | cargo test |
| 3.7 | pi/opencode provider 增改；model 更新同步 models 映射 | cargo test |
| 3.8 | 实机：对本机 claude settings 走一遍 read → save（同值）→ diff 除格式外无语义变化 | 实机 |
| 3.9 | codex key spawn 注入：keys.json 有 key 时 env 出现 `AINONE_CODEX_API_KEY` | cargo test（注入函数纯化） |

## 任务四：设置页重排 + 前端接线

### 目标

设置页从「一排裸 input」改为「每 harness 一张状态卡片」：状态徽标 + 一键安装 + 配置模型表单。CLI 未装 / 只差 ACP 桥 / 未认证三种缺失在 UI 上视觉区分，各有对应一键动作。快问/语音/自定义 harness 高级字段折叠。

### 方案

**卡片布局**（预置五家）：

```
[色点] Claude Code        ✓ 就绪 · API 已配置          [配置模型] [测试连接]
[色点] Codex              未装 ACP 桥接器 · 一键安装    [安装桥接器] [配置模型]
[色点] Pi                 未安装 · 一键安装             [安装]（CLI → 桥自动串联）
[色点] OpenCode           未安装（缺 bun/npm）          禁用 + 缺失说明
```

- 状态行按四态 + auth 组合渲染；`cli_installable`/`installable` 的按钮点击 → 进度行（复用 P28 尾迹回显）。
- **串联编排**（前端 `installAdapter(program)`）：state == cli_installable → `cli_install` 成功 → 刷新三态 → 若转 `installable` → 自动 `install_bridge` → 再刷新。任一步失败停留展示错误，已装部分保留。
- **配置模型**：内联展开三格（endpoint / API Key / 模型名）+「读取当前配置」回显（`harness_config_read`）+ 保存（`harness_config_save`，key 留空保留）。保存成功显示「已写入 <source_file>」。仅预置五家显示此按钮；认证态 Subscription 的卡片提示「已登录订阅，无需配置」。
- **向导同步**（NewSessionModal）：`absent` 判禁用改为 `absent`（无候选）才禁用；`cli_installable` 显示「未安装 · 首次使用自动安装」并可点「开始对话」触发 `installAdapter` 串联（复用 P28 先装后建模式）。
- **高级折叠**：预置卡片不暴露 id/program/args/cwd/logo 编辑（防误改，program 配置由 Rust 预置表负责）；「新增 harness」自定义行保留完整编辑字段。快问/语音服务移入折叠区「更多服务」；主题保留顶部。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 4.1 | 设置页五卡片渲染四态 × auth 组合文案正确 | vitest（组件测试：四态 fixture 矩阵） |
| 4.2 | cli_installable 点安装 → cli_install → 自动接 install_bridge → 三态刷新为 ready | vitest（mock 两命令可编程 Promise，断言调用顺序与刷新） |
| 4.3 | CLI 装成功、桥装失败 → 错误展示、不建会话、重开设置页状态为 installable | vitest |
| 4.4 | 配置模型：读取回显、保存调用 harness_config_save、key 留空提示「保留既有」 | vitest |
| 4.5 | 预置卡片无 id/program/args 编辑框；自定义 harness 保留 | vitest |
| 4.6 | 向导 cli_installable 可进 →「开始对话」触发串联安装 → 成功后建会话 | vitest（改造存量 P28 测试） |
| 4.7 | 快问/语音在折叠区内可展开配置，保存行为不回归 | vitest 存量迁移 |
| 4.8 | 全量回归 | `pnpm tsc --noEmit` 0 错 + `pnpm vitest run` 全绿 + `cargo test` 全绿 |

## 执行顺序与 commit 划分

| 步 | 内容 | commit 前置全绿 |
|---|---|---|
| S1 | 任务一 Rust：CLI_INSTALLERS + cli_install + 四态（cargo test） | cargo |
| S2 | 任务二 Rust：auth 探测 + adapter_status 扩展（cargo test） | cargo |
| S3 | 任务三 Rust：harness_config 读写 + codex env 注入（cargo test） | cargo |
| S4 | 任务四前端：一键安装串联 + 认证徽标 + 配置模型表单 + 设置页重排 + 向导门控（分小步提交：先安装串联，再配置表单，再重排） | tsc + vitest |
| S5 | 实机验收（1.3/1.4/2.2/3.8）+ 规格回填验收记录 | 全部 |

S4 内部仍按「一个可验收单元一个 commit」拆分，不积累。
