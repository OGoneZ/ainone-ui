# P29 需求规格书：文件树隐藏文件 + 元数据补全 + 模型/URL 在线切换

> 背景：①右侧文件树完全不显示点开头的文件/文件夹（`.github`、`.vscode`、`.env`、`.gitignore` 全部不可见），与 VS Code 惯例相悖；②部分会话的 session ID 不显示，且模型列对 pi/claude-code/codex/opencode 恒为「—」，baseUrl 对 omp/pi 恒为「—」；③用户需要在元数据面板点击模型/URL 直接探测远端模型列表并写回各 harness 配置文件。
> 本规格书基于真机探索（本机 4 个 harness 真实 ACP 握手 + 配置文件实读 + 两个真实网关 `/v1/models` 实测）与社区验证（ACP 官网规范、Zed/Cursor/Pydantic 社区实践）。

---

## 0. 探索结论（实现依据，均已实测）

### 0.1 五 harness 配置与元数据来源矩阵

| harness | baseUrl 来源（读取） | 模型来源（读取） | 持久化写回可行？ |
|---|---|---|---|
| claude-code | `~/.claude/settings.json` → `env.ANTHROPIC_BASE_URL`（本机实读：`https://aiapi.lejurobot.com/`） | 同文件顶层 `model` 字段（含 `[1m]` 后缀，`harness_probe.rs::strip_model_suffix` 已有去后缀实现）；⚠️ 若 `env.ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL` 存在则它们优先 | ✅ JSON 写回（写前备份） |
| codex | `~/.codex/config.toml` → `model_providers.<active>.base_url`（本机实读：`https://codex.ysaikeji.cn/v1`） | 同文件顶层 `model` 字段 | ✅ TOML 文本锚定替换（保注释，写前备份） |
| omp | `~/.omp/agent/models.yml` → `providers.<id>.baseUrl`（本机实读：`https://token.zhubaoduo.com/v1`） | adapters.json 的 args `--model`（p28 已去硬编码）；ACP `session/new` 的 `configOptions[model].currentValue` 实测返回完整模型目录 | ✅ adapters.json `--model` 参数 + models.yml `baseUrl:` 行文本替换 |
| pi | 无可靠单文件：`~/.pi/agent/models-store.json` 是模型目录缓存（本机实测 14 anthropic + 39 openai 条目），auth.json 为 `{}` | ACP `session/new` 的 `configOptions[model]` 实测返回完整目录（`currentValue: anthropic/claude-opus-4-8`） | ❌ 无验证过的写回文件，仅会话级切换 + 只读展示 |
| opencode | `~/.config/opencode/opencode.json`（官方文档；本机未装，无法实测） | 同上 | ❌ 本期只读，不承诺写回 |

### 0.2 ACP 协议实测（4 个 harness 真实握手，本机 2026-09-07）

| 能力 | omp 18.1.0 | pi-acp 0.0.33 | claude-agent-acp 0.73.0 | codex-acp 1.8.0 |
|---|---|---|---|---|
| `providers/list` | ❌ 未声明 | ❌ 未声明 | ✅ 返回 `main`/anthropic/baseUrl | ✅ 返回 `openai`/baseUrl |
| `session/new` 返回 `configOptions` | ✅ mode+model（含全部 options） | ✅ model（含全部 options） | ✅ 仅 mode | ✅ mode+collaboration_mode |
| `session/new` 返回 `models.availableModels` | ❌ | ✅ | ❌ | ✅（gpt-5.6-sol[low..max] 等） |
| `session/set_config_option`（含 model option） | ✅ 实测切换成功 | ✅ 实测切换成功 | ✅（仅 mode） | ✅（仅 mode） |
| `session/new` 返回 `modes` | ✅ | ✅（thinking level） | ✅ | ✅ |

⚠️ 实测发现：codex-acp 的 `providers/list` 返回 `api.openai.com/v1`，而用户 config.toml 配的是 `codex.ysaikeji.cn/v1`——桥未注入自定义 provider。baseUrl 展示对 codex 以 `providers/list`（会话真实生效值）优先，静态文件值作兜底，并在 UI 提示来源。

### 0.3 社区验证结论（Tavily 检索，2026-09-07）

- **Session Config Options 已 Stabilized**（ACP 官网 Updates：RFD Completed；`agentclientprotocol.com/protocol/v1/session-config-options`），`category: "model"` 是官方稳定分类；`session/set_config_option` 是官方运行时切模型通道。
- **`providers/*` 仍是 UNSTABLE**（schema 标注），omp/pi 不实现属正常，不能作为唯一 baseUrl 来源。
- Zed 的外部 Agent 模型选择器即消费 `configOptions[model]`；Cursor 论坛、Pydantic AI、ex_mcp 均以 `configOptions[model].currentValue` 为当前模型事实源。→ 本项目方案与社区主流一致。

### 0.4 网关 `/v1/models` 实测（两个真实网关）

| 网关 | 鉴权 | 响应 |
|---|---|---|
| `https://token.zhubaoduo.com/v1`（openai 协议） | `Authorization: Bearer <key>` | 200 `{data:[{id:"claude-opus-4-7",...},{id:"duo-king-6.6",...}]}` |
| `https://aiapi.lejurobot.com/`（anthropic 协议） | `x-api-key` + `anthropic-version` | 200 `{data:[{id:"saver/deepseek-v4-pro",...},...]}`（同样是 OpenAI 格式 data 数组） |

结论：统一按 OpenAI `{data:[{id}]}` 解析；请求头按协议分叉（anthropic → `x-api-key`，openai → `Bearer`）。URL 拼接规则：trim 尾斜杠；不以 `/v1` 结尾补 `/v1`；再拼 `/models`（复用 `anthropic_messages_url` 同款思路）。

### 0.5 现状代码定位（根因）

| 现象 | 根因 |
|---|---|
| 文件树不见点开头条目 | `src-tauri/src/fslist.rs:38` 后端无条件 `name.starts_with('.') → continue`（连 `.github` 文件夹也吞掉） |
| 新建会话 session ID 不显示 | `App.tsx:1212` 传 `activeTab.sessionId`（Tab 接口字段，仅恢复会话时有值）；新建会话的 sessionId 只写进 sessionStore（`ChatPanel.tsx:588 bindSession`），**从未回写 Tab** → RightRail 拿到 null |
| 模型恒「—」（pi/cc/codex/opencode） | `metadata.ts::extractModel` 只认 args `--model`；omp 之外四家 args 为空 |
| baseUrl 恒「—」（omp/pi） | 唯一来源是 `providers/list`（ChatPanel 两处拉取），omp/pi 不支持该方法 |
| 历史会话无 baseUrl | `ChatPanel.tsx:611` 仅 resume 会话补拉 providers；首条消息后也拉（`:950`），但空回答时 UI 一直是「—」 |

---

## 1. 需求与验收标准

### R1 文件树显示点开头的文件与文件夹（VS Code 式）

**目标**：`.github/`、`.vscode/`、`.claude/`、`.env`、`.gitignore` 等点开头条目正常显示、可展开、可引用、可预览；仅排除清单命中项继续隐藏。

**方案要点**：
- `fslist.rs` 删除 `.` 前缀跳过；隐藏过滤权统一收归前端 `fileTree.ts`（与 EXCLUDED_DIRS 同层，纯函数可单测）。
- 前端排除清单：保留 `node_modules/.git/target/dist/build`（目录），新增 `.DS_Store`（文件级排除：`shouldExclude` 扩展为目录+文件清单）。
- 不做「显示/隐藏切换开关」（用户未要求，避免过度设计）；`.git` 目录仍在排除清单内。

**验收标准**：
- AC-R1-1：`list_dir_sorted` 对点开头文件/文件夹不再跳过（Rust 单测：含 `.github/`、`.env`、`.gitignore` 的临时目录全数返回，排序规则不变——目录优先、忽略大小写）。
- AC-R1-2：前端 `filterExcluded` 排除 `.git`/`node_modules`/`target`/`dist`/`build` 目录与 `.DS_Store` 文件，保留其余点开头条目（单测锁定：`.github` 在、`.git` 不在、`.env` 在）。
- AC-R1-3：文件树 UI 中 `.github` 可展开子级、`.env`/`.gitignore` 可「引用」与「预览」（复用现有交互，不新增代码路径）。
- AC-R1-4：`@` 引用菜单若复用 `workspace_list_dir`，同样可见点开头文件（引用 `.env` 全链路不报错）。

### R2 session ID 全会话可见（新建会话不再缺失）

**目标**：任何会话（新建/恢复/降级重建）建立后，元数据面板立即显示 harness sessionId。

**方案要点**：`MetadataPanel` 的 sessionId 改为直接读 `sessionStore.runtime[tabKey].sessionId`（`bindSession` 后即有值），不再依赖 App 透传的 `activeTab.sessionId` prop；RightRail 相应删除该 prop。

**验收标准**：
- AC-R2-1：新建会话发出首条消息（`bindSession` 触发）后，session ID 行立即显示真实 harness sessionId（组件测试：mock store 值渲染断言）。
- AC-R2-2：恢复历史会话、load 降级 new 两种链路下显示值与 store 一致（降级换 sessionId 后显示新值）。
- AC-R2-3：点击复制行为不变（CopyableItem 语义不回归）。

### R3 模型显示全 harness 补齐

**目标**：五个 harness 的模型行不再恒「—」。显示优先级（自上而下取第一个非空）：
1. **会话级**：`session/new` 响应 `configOptions` 中 `category === "model"` 的 `currentValue`（omp/pi 实测有）；
2. **会话级**：providers 路由与静态探测（见 R4 的 `harness_meta`）返回的 model（claude-code 从 settings.json、codex 从 config.toml）；
3. **启动参数**：`extractModel(adapter.args)`（omp）。

**方案要点**：
- `session-core.ts`：`session/new` 响应的 `configOptions`/`models`/`modes` 存档进返回值与 store（新字段 `configOptions`），`dispatchUpdate` 处理 `config_option_update` 通知（切换后 currentValue 实时更新）。
- Rust 新增 `harness_meta(adapter_id)` 命令：读 0.1 矩阵静态配置 → `{ baseUrl, model, apiKeyPresent: bool }`（**key 不回传 WebView**，沿用 quickask.rs 密钥纪律；显示侧只有 `apiKeyPresent` 与脱敏提示）。
- 模型 ID 统一过 `strip_model_suffix` 等价逻辑（前端 metadata.ts 增纯函数，与 Rust 对齐）。

**验收标准**：
- AC-R3-1：omp 会话模型显示 `--model` 值；pi 会话显示 `configOptions[model].currentValue`（如 `anthropic/claude-opus-4-8`）。
- AC-R3-2：claude-code 会话显示 settings.json 的 model（`saver/glm-5.3-flash`，去 `[1m]`）；codex 显示 config.toml 的 `model`。
- AC-R3-3：config_option_update 通知到达后模型行实时更新（单测：dispatchUpdate 派发 → store 变更）。
- AC-R3-4：以上皆缺时保持「—」（不显示编造值）。

### R4 baseUrl 显示全 harness 补齐

**目标**：baseUrl 显示优先级：① `providers/list` 会话真实值（claude-code/codex 可用）；② `harness_meta` 静态值（omp/pi 兜底）；③「—」。providers 值与静态值不一致时（如 codex 桥现象）以 providers 值显示并标注来源 tag（「会话」/「配置」）。

**验收标准**：
- AC-R4-1：omp/pi 会话 baseUrl 显示 models.yml / 静态探测值（无 providers 能力不再恒「—」）。
- AC-R4-2：claude-code 显示 providers/list 值（`https://aiapi.lejurobot.com/`）。
- AC-R4-3：UI 能区分来源（title 或 tag 标注「来自会话路由」/「来自本机配置」）。
- AC-R4-4：`harness_meta` 对四家 harness 的解析各有 Rust 纯函数单测（含文件缺失/字段缺失/损坏 JSON/TOML 降级为 None 不崩）。

### R5 点击「模型」→ 探测远端模型列表 → 选择写回

**目标**：元数据面板「模型」行在可切换的 harness 上变为可点击；点击弹出选择面板：
1. 前端触发 Rust `models_probe`：按当前 baseUrl + 协议头调 `GET {base}/v1/models`（key 在 Rust 侧注入，不回传），解析 `{data:[{id}]}` 返回 id 列表；
2. 面板内列表展示（支持输入过滤，复用现有 Command 组件模式），当前模型高亮；
3. 点选模型 → Rust `harness_settings_write(adapter_id, { model })` 写回 0.1 矩阵对应文件（写前备份 `.ainone-bak`）→ toast 成功/失败；
4. 同时调用 `session/set_config_option`（configOptions 有 model option 时，omp/pi）即时应用到当前会话；无 model option 的 harness（claude-code/codex）写回后提示「新会话生效」。

**验收标准**：
- AC-R5-1：Rust `models_probe` 纯函数单测覆盖 URL 拼接（带/不带尾斜杠、带/不带 `/v1`）、openai/anthropic 两种请求头、`{data:[{id}]}` 解析、错误结构化（超时/非 200/坏 JSON）。
- AC-R5-2：对两个真实网关手工验证探测成功（zhu 5 条内、lejurobot 列表可见）；探测中面板有 loading 态，失败展示错误原因且可重试。
- AC-R5-3：选择模型后 claude-code 的 settings.json `model` 与 `ANTHROPIC_DEFAULT_*`（存在时）同步更新、codex config.toml `model` 行更新且**其余内容（含注释）逐字节保留**（Rust 单测：注入样例 TOML/JSON → 写回 → diff 仅目标行）；写回前产生 `.ainone-bak` 备份。
- AC-R5-4：omp 选择模型后 adapters.json 该适配器 args 的 `--model` 值更新（无则追加）。
- AC-R5-5：pi 面板可用（探测 + 会话内 `set_config_option` 即时生效），但不提供持久写回项（UI 明示「仅当前会话」）。
- AC-R5-6：写回成功后元数据面板模型行立即刷新；组件测试锁定「点选 → invoke 写回 → store 更新」链路。
- AC-R5-7：整个链路 WebView 侧无任何明文 API key（组件测试 + 代码审查双确认：`models_probe` 入参只有 baseUrl/协议，key 由 Rust 从配置文件自取）。

### R6 点击「URL」→ 编辑 → 重探测模型列表

**目标**：元数据面板「baseUrl」行可点击，弹出编辑面板：输入框预填当前值 + 「探测模型列表」按钮 + 保存。保存 = `harness_settings_write(adapter_id, { baseUrl })` 写回对应配置；URL 变更后模型面板自动重新探测（列表与新 URL 对应）。

**验收标准**：
- AC-R6-1：URL 面板保存后 claude-code `env.ANTHROPIC_BASE_URL`、codex `model_providers.<active>.base_url`、omp models.yml `baseUrl:` 行分别正确更新（Rust 单测同 AC-R5-3 标准：文本锚定替换、备份、注释保留）。
- AC-R6-2：保存成功后元数据面板 baseUrl 行刷新；随后打开模型面板时按新 URL 重新探测（组件测试：写入 → 探测入参为新 URL）。
- AC-R6-3：非法 URL（非 http(s)、空值）被前端校验拦截，不发写回命令。
- AC-R6-4：pi/opencode 的 URL 行保持只读复制（无写回能力，不渲染编辑入口）。
- AC-R6-5：写回后原会话继续可用（不主动断链）；对 claude-code/codex 提示「对后续新会话生效」。

### R7 通用约束

- AC-R7-1：全量 `vitest` 通过（基线 449 条不回归）且新增逻辑有对应测试；`cargo test` 通过（基线 53 条不回归）；`tsc` 0 错。
- AC-R7-2：所有新增 Rust 文件读/写均有「文件缺失 → None/Err 不崩」路径。
- AC-R7-3：实现按 §3 分期提交，每期独立可回滚，不产生单一超级 commit。

---

## 2. 技术方案

### 2.1 Rust 新增（`src-tauri/src/`）

| 项 | 内容 |
|---|---|
| `harness_meta.rs`（新） | `harness_meta(adapter_id, home) -> Option<HarnessMeta { base_url, model, api_key_present }>`：按 0.1 矩阵读四家配置；home 注入便于测试；**key 只判存在不回传**。 |
| `harness_meta.rs::write` | `harness_settings_write(adapter_id, model?, base_url?)`：文本锚定替换（settings.json 用 serde_json 定点改写保留其余字段；config.toml/models.yml 用行级正则锚定），写前 `cp .ainone-bak`；omp 模型写 adapters.json args。 |
| `models_probe.rs`（新，或并入 harness_meta） | `models_probe(base_url, protocol) -> Result<Vec<String>, ProbeError>`：reqwest GET `{base}/v1/models`，协议分叉请求头，解析 `{data:[{id}]}`，10s 超时。 |
| `fslist.rs` | 删 `.` 前缀跳过 + 对应测试更新。 |
| `lib.rs` | 注册 3 个新命令。 |

### 2.2 前端改动

| 文件 | 改动 |
|---|---|
| `src/ipc/harnessMeta.ts`（新） | 三个命令的 invoke 封装 + 类型。 |
| `src/lib/fileTree.ts` | `shouldExclude` 扩展文件级排除（`.DS_Store`）；`filterExcluded` 同步。 |
| `src/acp/session-core.ts` | session/new 响应存档 `configOptions`；`dispatchUpdate` 增 `config_option_update` 分支。 |
| `src/store/sessionStore.ts` | RuntimeState 增 `configOptions: SessionConfigOption[] \| null` + setter。 |
| `src/acp/metadata.ts` | 增 `extractSessionModel(configOptions)` 纯函数（category==="model" → currentValue）。 |
| `src/sidebar/MetadataPanel.tsx` | sessionId 改读 store；模型/baseUrl 行可点击 → `ModelSwitchPanel`/`UrlEditPanel`。 |
| `src/sidebar/ModelSwitchPanel.tsx`（新） | Command 式列表 + 过滤 + loading/error 态 + 点选写回。 |
| `src/sidebar/UrlEditPanel.tsx`（新） | 输入 + 校验 + 探测预览 + 保存。 |
| `src/sidebar/RightRail.tsx` | 删 sessionId prop 透传。 |

### 2.3 明确不做（本期边界）

- pi/opencode 的持久化写回（无验证过的文件格式，避免破坏用户配置）。
- 模型面板外的会话模式（mode）切换 UI——`modes`/mode configOption 数据本期只存档不渲染（防 scope 膨胀）。
- `/v1/models` 之外的探测协议（如 anthropic 官方 `/v1/models` 头格式差异已在实测中覆盖，无余量方案）。

## 3. 分期提交计划

| 期 | 内容 | 提交 |
|---|---|---|
| P29a | R1 文件树隐藏文件（fslist + fileTree + 测试） | feat(p29a) |
| P29b | R2+R3+R4 元数据补全（harness_meta 读 + session/new configOptions 存档 + UI 显示） | feat(p29b) |
| P29c | R5 模型探测与写回（models_probe + settings_write + ModelSwitchPanel） | feat(p29c) |
| P29d | R6 URL 编辑与重探测联动（UrlEditPanel + 写回联动） | feat(p29d) |

每期提交前跑 `tsc + vitest (+cargo，涉 Rust 期)`，全绿才提交。

## 4. 风险与未验证项（如实登记）

| 项 | 说明 | 缓解 |
|---|---|---|
| codex 桥 baseUrl 失真 | codex-acp `providers/list` 返回官方地址而非用户 config.toml 值（0.2 实测） | UI 标注来源；文档已登记，不静默 |
| pi 写回 | `~/.pi/agent/` 无验证过的用户模型配置文件 | 本期只读 + 会话级切换 |
| opencode | 本机未装，全部结论来自文档 | 只读展示；无数据时「—」 |
| settings.json 写回并发 | 用户同时跑 Claude Code CLI 改配置 | 写前备份 + 定点字段改写（不整文件重排） |
| 网关 `/v1/models` 兼容性 | 个别网关可能不支持该端点 | 探测失败结构化报错 + 可重试，不影响主流程 |
