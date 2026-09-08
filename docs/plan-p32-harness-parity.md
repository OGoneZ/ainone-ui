# P32 需求规格书：五 harness 能力对齐（快问探测扩展 + 认证探测修正 + 配置能力收敛 + 会话层补全）

> 背景：P32 gap 探索（2026-09-08，两份矩阵：Rust 侧 + 前端侧）发现八处分叉/缺陷。本规格书修复其中六项（问题 2/3/4/5/7/8），并落实两条所有者决策：
> **豁免一（决策 1）**：快问自动探测改为**五 harness 全覆盖 fallback 链**——有哪个用哪个，全都没有则保持手动；快问设置面板增加 endpoint/key/模型探测三件套，与五个 harness 设置卡片形态对齐。
> **豁免二（决策 2）**：权限模式开关**仅 claude-code** 保持现状，不为其余四家扩展（P32 不动）。
> **验证铁律**：所有涉及 per-harness 行为的改动必须在五家（claude-code/codex/omp/pi/opencode）真机验证；本机五家全部可运行（opencode 经 `~/.opencode/bin` PATH 注入；pi/opencode 部分凭据文件缺失属合法状态，用「构造配置文件 + 探测」与「实开会话」两级验证），不允许以「本机没装」跳过。

---

## 0. 探索结论（实现依据）

### 0.1 本机五家实况（2026-09-08 盘点）

| harness | CLI | ACP 桥 | 配置文件 | 凭据文件 | 本机状态 |
|---|---|---|---|---|---|
| claude-code | ✅ | ✅ claude-agent-acp | `~/.claude/settings.json` | 同左 env + `.credentials.json` | 全齐 |
| codex | ✅ | ✅ codex-acp 1.10.0 | `~/.codex/config.toml` | `~/.codex/auth.json` | 全齐 |
| omp | ✅ | 原生 | `~/.omp/agent/models.yml`（provider `zhubaoduo`，含 key） | ⚠️ 共用 `~/.pi/agent/auth.json`（为空 `{}`） | 可验证 |
| pi | ✅ | ✅ pi-acp | `~/.pi/agent/models.json` 不存在（`models-store.json` 是模型目录缓存，非用户配置） | `~/.pi/agent/auth.json` = `{}` | 可验证（构造 models.json） |
| opencode | ✅ 1.18.29 | 原生 | `~/.config/opencode/opencode.json` 不存在（jsonc 仅有 `$schema`） | `~/.local/share/opencode/auth.json` 不存在 | 可验证（ACP 握手已实测：list/resume/close/fork 四能力全声明） |

### 0.2 根因定位（六个待修问题）

| # | 问题 | 位置 |
|---|---|---|
| 2 | 快问自动探测只覆盖 claude-code/codex；omp/pi/opencode 配好网关仍要手动填 | `harness_probe.rs:74-167` |
| 3 | omp 认证探测读 pi 的凭据文件（`~/.pi/agent/auth.json`），与 omp 实际配置（models.yml）零联动 | `adapters.rs:295-303` |
| 4 | claude key「已配置」判定三方不一致：harness_meta 只认 `AUTH_TOKEN`；harness_config 与 adapters 认 `AUTH_TOKEN`+`API_KEY` | `harness_meta.rs` / `harness_config.rs:72` / `adapters.rs:224` |
| 5 | opencode 前端功能面窄于实际能力：Rust 有完整配置代写+探测，但 `supportsWrite` 三家名单藏掉了 URL 编辑与模型持久写回 | `harnessMeta.ts:50-52` |
| 7 | capability gate 定义/消费脱节：`canLoad/canResume/canClose` 零消费点；恢复链内联重复实现 canLoad 语义；session/list / session/resume / session/close / session_info_update 全未接 | `capabilities.ts` / `session-core.ts:306,520` |
| 8 | 会话级模型切换四条分支 toast 文案各异，五家反馈不一致 | `ModelSwitchPanel.tsx:130-153` |

### 0.3 社区参照结论（DeepChat / AionUi，2026-09-08 实读）

- **能力快照模式**（DeepChat `acpCapabilities.ts:28-50`）：initialize 后立即把 `loadSession` + `sessionCapabilities.{list,resume,close,fork}` 扁平成 `supports` 五布尔，主进程与渲染层都只消费布尔，不再各自解释对象型能力。→ 本仓已存档 `AgentCapabilities`（store `capabilities` 字段），**补齐 snapshot 转换 + 五布尔消费**即可。
- **恢复链降级**（DeepChat `acpSessionManager.ts:658-838`）：resume → load → new 逐级降级，每级失败 detach + warn 后落下一级。本仓已有 load→new 二级，`session/resume` 作为不回放历史的轻量档位**不纳入本仓恢复链**（本仓恢复依赖本地日志回填 UI + load 回放上下文，resume 不回放历史对 UI 无增益），只在能力矩阵登记。
- **会话列表**（DeepChat `acpProvider.ts:752-810`）：`session/list` 带 cursor 自动翻页聚合；**双闸守门**——先查连接器方法存在，再查能力声明，不满足时结构化报错（`Agent did not advertise sessionCapabilities.list`）。opencode 1.18.29 实测声明 list 能力且返回 `{sessions:[{sessionId,cwd,updatedAt}]}`。
- **slash 分层**（AionUi `mergeSlashCommands.ts:35-50`）：`builtin > acp > skill` 三层 Map 首写合并；builtin = `kind:'builtin'` 立即本地执行，acp/skill = 插入 `/name ` 文本下发。DeepChat 仅 `/compact` 一条内置且用 `isAcpSession !== true` 反向 gate。→ 本仓内置命令**只做数据已就绪的三条**（/new /fork /sessions），不发明 harness 侧不存在的命令。
- **配置面板**（AionUi）：一套表单按 platform 分派，不做 per-harness 表单。→ 快问面板照此收敛为与 harness 卡片同构的三件套。
- **AionUi 不消费 session/list|close 原语**（列表走本地库、close 即删除本地记录）——佐证本仓「/sessions 仅在能力声明时出现」的克制范围。

---

## 1. 需求与验收标准

### R1 快问自动探测扩展为五家 fallback 链【问题 2 + 豁免一】

**目标**：快问模型自动探测覆盖五家 harness，按固定优先级逐个尝试，有哪个用哪个；全部探测不到则回落手动配置（现状语义）。快问设置面板增加 endpoint/key/模型探测能力，与 harness 设置卡片同构。

**方案要点**：
- `harness_probe.rs` 扩展：探测链从 `[claude-code, codex]` 扩为 `[claude-code, codex, omp, pi, opencode]`（claude 走轻量档位语义保持第一优先；新增三家分别读 `models.yml` / `models.json` / `opencode.json` 的 provider baseUrl + apiKey + model，复用 `harness_meta` 已有解析函数——**抽公共解析，禁止复制粘贴两份解析逻辑**）。
- pi 的 model 取 `models[].first.id`（无则该家探测失败）；opencode 的 model 剥 `ainone/` 前缀（与 `meta_opencode` 同构）。
- probe 结果 `source` 字段扩为 `auto:<adapter_id>` 五值；前端 `sourceBadge`（`SettingsModal.tsx:115-118`）同步扩展五家徽标文案。
- 快问设置面板（`SettingsModal` 快问区块）：模型行改为与 harness 卡片同构的「显示当前生效模型 → 点击弹 ModelSwitchPanel」交互；`formContext` 传快问的 endpoint/key；探测基准 URL 用快问配置的 `base_url`（表单值优先，空则回落本机快问 quickask.json 既有值）。快问无 `supportsWrite` 配置文件写回语义——**点选模型只写 quickask.json 的 model 字段，不写任何 harness 配置**。

**验收标准**：
- AC-R1-1：Rust 单测——五家探测函数各自独立覆盖（构造五份配置文本样本：正常/字段缺失/损坏 JSON/空值 → 期望值或 None）；fallback 顺序锁定（claude 配置残缺 → 落 codex → 落 omp → 落 pi → 落 opencode → None）。
- AC-R1-2：**真机验证 ×5**——对本机五家真实配置逐家做快问探测（临时禁用前序家配置或用 home 注入指向构造目录），断言返回 `source: auto:<id>` 与正确 model；五家全缺时（HOME 指向空目录）探测返回空、UI 保持手动态。
- AC-R1-3：快问面板模型行点击弹模型面板，探测基准为快问 endpoint；点选后 quickask.json `model` 更新且 `harness_config_read`/`harness_settings_write` **均未被调用**（组件测试 mock 断言）。
- AC-R1-4：快问面板 endpoint/key/模型三格保存链路不回归（既有 quickAskConfigSave 测试全过 + 新增 model 探测联动一条）。
- AC-R1-5：`sourceBadge` 五家文案齐备（组件测试断言五种 source 渲染对应徽标）。

### R2 omp 认证探测修正【问题 3】

**目标**：omp 的认证态探测基于 omp 自身凭据事实，不再误读 pi 的凭据文件。

**方案要点**：
- omp 与 pi 在 `probe_auth` 分家。omp 的认证事实源 = `~/.omp/agent/models.yml` 中 provider 的 `apiKey` 字段非空（omp 无独立 auth.json；订阅态 omp 不存在，保持 API 单态）。
- pi 保持读 `~/.pi/agent/auth.json`（非空 = Api 态）不变。
- detail 文案区分：「API 已配置（models.yml）」。

**验收标准**：
- AC-R2-1：Rust 单测——omp 在 models.yml 含 apiKey → Api 态；apiKey 缺失/空 → None；**pi 的 auth.json 非空且 omp yml 无 key 时 omp 仍为 None**（锁定不再误读）。
- AC-R2-2：真机验证——本机 omp（yml 含 key）显示「API 已配置」；pi（auth.json 为 `{}`）显示未配置；两者互不串扰。

### R3 claude key 判定统一【问题 4】

**目标**：三处「claude 已配置 key」判定收敛为同一语义：`env.ANTHROPIC_AUTH_TOKEN` 或 `env.ANTHROPIC_API_KEY` 任一非空即已配置。

**方案要点**：
- `harness_meta.rs::meta_claude` 的 key_present 判定扩为双字段（与 `harness_config.rs:72`、`adapters.rs:224` 对齐）。
- 三处共用一个判定函数（`harness_meta` 导出 `pub(crate) fn claude_key_present(v: &serde_json::Value) -> bool`，另两处调用），**单一实现防再分叉**。

**验收标准**：
- AC-R3-1：Rust 单测——`AUTH_TOKEN` 仅在、`API_KEY` 仅在、两者都在、两者都空四种样本 × 三处调用点全数一致。
- AC-R3-2：真机验证——本机 claude settings.json（AUTH_TOKEN 在）三处判定均为「已配置」（UI：设置卡片认证徽标 + 元数据面板 key 提示 + 代写回显 hasApiKey）。

### R4 opencode 前端能力对齐【问题 5】

**目标**：opencode 的 URL 编辑与模型持久写回入口开放，能力面与 Rust 侧实际对齐；pi 维持只读（真实无定点写回语义）。

**方案要点**：
- `supportsWrite`（`harnessMeta.ts:50-52`）扩为四家（+opencode）；`HarnessWriteTarget` 类型同步。
- Rust `harness_settings_write_inner` 对 opencode 走**配置代写合并写**（调 `harness_config::opencode_merge_write` 等价路径——定点替换需要既有文件含 `provider.ainone` 结构，用户手写配置不保证；合并写是 opencode 已验证的安全写法），model/baseUrl 两键落 `provider.ainone`；写前备份沿用 `BAK_SUFFIX` 机制。
- `ModelSwitchPanel`/`UrlEditPanel` 对 opencode 自动获得可编辑入口（gate 由 `supportsWrite` 驱动，无需新分支）。

**验收标准**：
- AC-R4-1：Rust 单测——opencode 定点写：既有 opencode.json（代写产物形态）→ 写 model/baseUrl → JSON 解析断言 `provider.ainone.options.baseURL` 与顶层 `model`（带 `ainone/` 前缀）更新、无关键保留；文件不存在 → 合并写新建成功。
- AC-R4-2：`supportsWrite("opencode") === true` 单测；pi 仍 false（锁定豁免语义边界外的真实差异）。
- AC-R4-3：真机验证 ×1——本机 opencode：设置页填 endpoint/key/model 代写落盘 → 元数据面板 URL 行可编辑保存 → 模型行弹面板探测（本机网关）→ 点选写回 → 重读回显一致。
- AC-R4-4：UI 层 opencode 与 claude-code/codex/omp 在「URL 编辑 / 模型持久写回」两域的行为一致（同一面板、同一 toast 语义，见 R6）。

### R5 capability snapshot 统一 + 会话层补全【问题 7】

**目标**：能力 gate 单一事实源化；`session/list`、`session_info_update` 接入；`canLoad/canResume/canClose` 获得真实消费点或删除。

**方案要点**：
- `capabilities.ts` 增加 `capabilitySnapshot(cap) -> { canFork, canLoad, canResume, canClose, canList }` 纯函数（对象型 key presence 规则、loadSession 布尔规则集中于此）；`ChatPanel.tsx:586` 存档处直接存 snapshot 五布尔；恢复链（`session-core.ts:306`）改读 snapshot（经 ipc 传入或连接器暴露 `agentCapabilities` getter——取改动最小路径）；`canResume/canClose` 作为 snapshot 字段保留（协议事实存档），**无 UI 入口不渲染**（AionUi 佐证：close/list 原语不必强行 UI 化）。
- `session/list` 接入（元数据面板新行「会话列表」或 App 会话菜单，取改动最小者）：双闸守门（连接器有方法 + `canList`），`session/list` 请求带 cursor 翻页聚合，展示 `sessionId/cwd/updatedAt` 列表；点选条目 → 以该 sessionId 走既有恢复链开 Tab。能力未声明 → 入口不渲染（capability gate 显隐语义）。
- `session_info_update` 接入：`dispatchUpdate` 增 case，title/updatedAt 落 store（`RuntimeState.sessionInfo`）；Tab 标题若为自动生成占位（未命名）则采纳 harness 下发的 title。
- `compaction_update`/`compaction_summary_chunk`/`current_mode_update`：本期只登记不渲染（DeepChat 也仅登记；渲染属新需求非对齐缺陷）。

**验收标准**：
- AC-R5-1：`capabilitySnapshot` 纯函数单测——五家 initialize 样本（真机实测缓存：opencode 四能力全声明、claude-code/codex/omp/pi 各自声明集）→ 五布尔断言；`canLoad` 语义与现行 `loadSession !== false` 一致（降级不回归）。
- AC-R5-2：恢复链改读 snapshot 后，既有降级测试（load 失败 → new）全过。
- AC-R5-3：`session/list` 单测——cursor 两页聚合；无 `canList` 时上层入口拿不到数据（结构化错误或 gate 拦截，二选一有测试锁定）。
- AC-R5-4：**真机验证 ×5**——五家逐家握手后 snapshot 五布尔与本机实测能力声明一致（opencode: list/resume/close/fork 全 true；各家按 0.2 实测表）；其中 opencode 实点会话列表 → 出现历史 session → 点选完成恢复（`session/load` 链复用，消息历史回填）。
- AC-R5-5：**真机验证 ×2**——opencode/codex 会话中产生标题的场景（若有），Tab 未命名时被 `session_info_update` 的 title 更新；其余三家无该通知时不渲染不报错。
- AC-R5-6：元数据面板/会话入口对无 list 能力的四家（若均未声明）保持无入口（组件测试：capabilities=null 或 canList=false → 不渲染）。

### R6 模型切换反馈统一【问题 8】

**目标**：五家模型切换的 toast 语义收敛为一套模板，消除四条分支各说各话。

**方案要点**：
- `ModelSwitchPanel::pick` 的结果提示收敛为二维正交：**持久落盘**（写回成功/失败/该家不支持）× **会话生效**（即时生效/新会话生效/当前会话拒绝）。
- 提示模板（一套文案函数，禁止分支内硬编码）：
  - 成功：`已切换到 {model}（{会话生效档}）`，会话生效档 ∈ {本会话即时生效 | 对新会话生效 | 当前会话不支持，仅写入配置}；
  - 持久不支持（pi 会话级切换成功但无写回）：`当前会话已切换到 {model}（该 harness 无配置写回，仅本会话生效）`；
  - 失败：`切换失败：{原因}`（不变）。
- 五家各代入二维值，行为映射表单测锁定（claude-code/codex/omp/opencode：写回+会话档各自；pi：仅会话档）。

**验收标准**：
- AC-R6-1：文案模板纯函数单测——二维组合九宫格 → 文案断言（含「当前会话不支持」与「无写回仅会话级」两个特殊档）。
- AC-R6-2：组件测试——pi 点选（无写回）与 omp 点选（写回+即时）toast 文案分别命中模板对应档，不再各是独立字符串。
- AC-R6-3：**真机验证 ×5**——五家各实切一次模型（本机网关），toast 命中预期档位：claude-code（写回+新会话生效或即时，视 allowlist）、codex（写回+会话档）、omp（写回+即时）、pi（仅会话）、opencode（写回+会话档）。

### R7 通用约束

- AC-R7-1：全量 `vitest` 通过（基线 587 条不回归）且新增逻辑有对应测试；`cargo test` 通过（基线 133 条不回归）；`tsc` 0 错。
- AC-R7-2：所有新增 Rust 文件读均有「文件缺失 → None/Err 不崩」路径（pi models.json / opencode opencode.json 本机缺失是常态，探测静默落空）。
- AC-R7-3：实现按 §3 分期提交，每期独立可回滚，不产生单一超级 commit。
- AC-R7-4：**五 harness 真机验证总表**（§4）逐项执行并留痕（输出截图/日志/断言结果），不允许「本机没装跳过」——opencode 可执行文件在 `~/.opencode/bin`（env_path 已注入）、无配置文件时用「构造配置 + 探测」与「实开会话」组合验证。

---

## 2. 技术方案

### 2.1 Rust（`src-tauri/src/`）

| 项 | 内容 |
|---|---|
| `harness_probe.rs` | 探测链扩五家；omp/pi/opencode 三个 `probe_*_text` 纯函数；解析逻辑调用 `harness_meta` 公共函数（`meta_omp`/`meta_pi`/`meta_opencode` 输出 `HarnessMeta`，probe 层补 key 明文——需为 probe 场景提供**带 key 明文**的平行读函数，key 纪律边界不变：明文只到 quickask 请求，不进 WebView） |
| `harness_meta.rs` | ①`meta_claude` key 判定双字段化 + 导出公共判定函数；②新增 `harness_settings_write_inner` 的 `OpenCode` 合并写分支（调 `harness_config::opencode_merge_write`） |
| `adapters.rs` | `probe_auth` 的 omp 分支改读 `models.yml` apiKey |
| `session-core.ts`（前端，列此处因与 Rust 会话层耦合） | snapshot 传入恢复链；`session/list` 连接器方法（cursor 聚合）；`dispatchUpdate` 增 `session_info_update` case |
| `lib.rs` | 新命令注册（如 `session_list` 经 acp 层则无需新 Tauri 命令——session/list 走既有连接器通道） |

### 2.2 前端（`src/`）

| 文件 | 改动 |
|---|---|
| `chat/logic/capabilities.ts` | `capabilitySnapshot` 纯函数（五布尔），保留旧函数为薄包装防外部引用断裂 |
| `store/sessionStore.ts` | `RuntimeState` 增 `caps: { fork, load, resume, close, list } \| null`（或复用 capabilities 字段——实现时取小改）；增 `sessionInfo: { title?: string; updatedAt?: string } \| null` |
| `chat/ChatPanel.tsx` | 存档 snapshot；恢复链读 snapshot |
| `acp/session-core.ts` | `session_list()` 连接器方法 + `session_info_update` dispatch |
| `sidebar/MetadataPanel.tsx` 或 `App.tsx` | 会话列表入口（canList gate）+ 列表弹层（轻量 Dialog，复用 msm-* 样式倾向） |
| `app/modals/SettingsModal.tsx` | 快问模型行改造（点击弹 ModelSwitchPanel，formContext=快问 endpoint/key，无 supportsWrite 分支）；`sourceBadge` 五家 |
| `sidebar/ModelSwitchPanel.tsx` | pick() 提示收敛为模板函数；快问场景（无 harness 写回）新分支「仅写快问配置」 |
| `ipc/harnessMeta.ts` | `supportsWrite` +opencode；`HarnessWriteTarget` 扩类型 |

### 2.3 明确不做（本期边界）

- 权限模式开关扩展到其余四家（所有者豁免：仅 claude-code 保持）。
- `session/resume`（不回放历史的轻量恢复）接入恢复链——本仓恢复依赖本地日志+load 回放，resume 无 UI 增益；能力快照登记即可。
- `session/close` UI 入口——AionUi 佐证不必原语化；本仓闲置回收/dispose 已覆盖资源释放。
- `compaction_*`/`current_mode_update` 的渲染（登记不渲染）。
- 快问的 anthropic 协议写回语义变更（快问写回只动 quickask.json）。

---

## 3. 分期提交计划

| 期 | 内容 | 提交 |
|---|---|---|
| P32a | R2 omp 认证探测修正 + R3 claude key 判定统一（纯 Rust 小改） | fix(p32a) |
| P32b | R4 opencode 写回分支 + supportsWrite 扩名单（Rust + 前端） | feat(p32b) |
| P32c | R1 快问五家 fallback 探测 + 快问面板三件套（Rust + 前端） | feat(p32c) |
| P32d | R5 capability snapshot + session/list + session_info_update | feat(p32d) |
| P32e | R6 模型切换反馈统一 + 全量五家真机验证收尾 | refactor(p32e) |

每期提交前跑 `tsc + vitest (+cargo 涉 Rust 期)`，全绿才提交。

---

## 4. 五 harness 真机验证总表（每期完成后逐项打勾留痕）

| 验证项 | claude-code | codex | omp | pi | opencode |
|---|---|---|---|---|---|
| 快问探测命中（R1） | AC-R1-2 | AC-R1-2 | AC-R1-2 | AC-R1-2（构造 models.json） | AC-R1-2（构造 opencode.json） |
| 认证徽标正确（R2/R3） | AC-R3-2 | —（无改动） | AC-R2-2 | AC-R2-2 | —（无改动） |
| URL 编辑+模型写回（R4） | 回归 | 回归 | 回归 | 仅会话级（不变） | AC-R4-3 |
| capability snapshot 五布尔（R5） | AC-R5-4 | AC-R5-4 | AC-R5-4 | AC-R5-4 | AC-R5-4 + 会话列表实点 |
| 模型切换 toast 档位（R6） | AC-R6-3 | AC-R6-3 | AC-R6-3 | AC-R6-3 | AC-R6-3 |

---

## 5. 风险与未验证项（如实登记）

| 项 | 说明 | 缓解 |
|---|---|---|
| opencode 配置 jsonc 形态 | 本机现存 `opencode.jsonc`（带注释 JSON）；合并写以 `serde_json` 解析，jsonc 中的注释会解析失败 | 探测/读回显失败 → None 静默落空（现状一致）；**合并写失败时报结构化错误引导用户改用 opencode.json**，不破坏 jsonc 原文件 |
| pi 模型探测质量 | pi 无单文件用户配置是常态（models-store.json 是缓存非配置），probe 常态落空 | 属预期；fallback 链语义「有哪个用哪个」天然覆盖 |
| omp 订阅态 | omp 无订阅态证据，保持 API 单态 | 探测错误时如实展示未配置 |
| session/list 各家分页语义 | 仅 opencode 实测（无 cursor 二页场景） | cursor 循环聚合实现按协议标准；未声明 list 的四家入口不渲染，无回归面 |
| 快问探测与 harness_meta 的解析双轨 | probe 需要明文 key、meta 只判存在——两层函数若各自解析会重演问题 4 | 强制 probe 层调用 meta 层解析（带 key 明文平行函数），单测锁定两侧解析结果一致 |
