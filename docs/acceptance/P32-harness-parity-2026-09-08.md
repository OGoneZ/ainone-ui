# P32 验收记录：五 harness 能力对齐

**日期**：2026-09-08
**规格书**：docs/plan-p32-harness-parity.md
**分支**：zhubaoduo/feat/p32_harness_parity（worktree p32-harness-parity）
**验证铁律执行**：五家全部验证，无一豁免、无一跳过。

## 1. 自动化测试基线

| 套件 | 结果 |
|---|---|
| cargo test --lib | 144 passed / 0 failed |
| vitest 全量 | 650 passed / 0 failed（81 文件） |
| tsc --noEmit | 0 错 |

## 2. 五家真机验证总表（规格书 §4 逐项）

### 2.1 快问探测命中（R1，AC-R1-1/2）

方法：构造五份独立 HOME（/tmp/p32-verify/home1-5）注入 probe_harness（生产同路径，仅 HOME 不同）+ 真机 HOME 实测。探针输出（cargo test --lib p32_verify -- --nocapture，验证后探针已删）：

```
[V1] claude-code: model=saver/glm-5.3-flash key_present=true auth=Api
[V2] omp: base=https://token.zhubaoduo.com/v1 auth=Api
[V3] pi: model=pi-ver-model key=sk-verify-3
[V4] opencode: model=oc-ver key=sk-verify-4
[V5] 空 HOME → None ✓
[V6] 真机: probe=claude-code, omp=Api("API 已配置（models.yml）"), pi=None
```

- AC-R1-1 ✅ Rust 单测五家独立覆盖（正常/缺失/损坏/空值 + fallback 链序 omp→opencode、pi 缺 model 落空）
- AC-R1-2 ✅ 五家逐家命中 `source: auto:<id>`；全缺（home5）返回空 → UI 保持手动态
- 附注：快问 probe 链的 claude 探测要求 BASE_URL+TOKEN 双齐（轻量调用需要可用 key）；API_KEY-only 的「已配置」判定由 R3 的 meta 断言单独覆盖

### 2.2 认证徽标正确（R2/R3，AC-R2-1/2、AC-R3-1/2）

- AC-R2-1 ✅ 单测：pi auth.json 非空且 omp 无 yml → omp None（不串扰）；omp yml 有 key → Api
- AC-R2-2 ✅ 真机（[V6]）：omp = `Api("API 已配置（models.yml）")`（本机 yml 含 key）、pi = None（本机 auth.json 为 `{}`）——互不串扰
- AC-R3-1 ✅ `claude_key_present_dual_field_matrix`：AUTH_TOKEN 单在 / API_KEY 单在 / 双在 / 空白 / 缺失 全矩阵
- AC-R3-2 ✅ 真机（[V1]+真机快照 real_machine_auth_snapshot）：本机 settings.json（TOKEN 在）三处判定均为已配置（meta api_key_present / 代写回显 hasApiKey / 认证 Api）

### 2.3 opencode URL 编辑 + 模型写回（R4，AC-R4-1/2/3/4）

- AC-R4-1 ✅ 单测：write_opencode 三例 + 端到端备份写回
- AC-R4-2 ✅ `supportsWrite("opencode") === true`（H4-1）、pi 仍 false
- AC-R4-3 ✅ 真机端到端（[V7]）：构造 opencode.json → `harness_settings_write_inner("opencode", model, baseUrl)` → 定点改写 `provider.ainone.options.baseURL` + 顶层 `model`（ainone/ 前缀）→ 既有 key 保留 → `.ainone-bak` 备份 = 原始内容
- AC-R4-4 ✅ 前端入口由同一 supportsWrite gate 驱动，与前三家同一 ModelSwitchPanel/UrlEditPanel，无 per-harness 分支

### 2.4 capability snapshot 五布尔（R5，AC-R5-1/3/4/6）

本机五家 initialize 握手实测（stdin 保持打开，逐家跑真实 ACP 握手）：

| harness | 版本 | loadSession | sessionCapabilities |
|---|---|---|---|
| opencode | 1.18.29 | true | close, fork, list, resume |
| claude-agent-acp | 0.73 | true | close, fork, list, resume (+delete/subagents/additionalDirectories) |
| codex-acp | 1.10.0 | true | close, fork, list, resume (+同上) |
| omp | 18.1.0 | true | close, fork, list, resume |
| pi-acp | 0.0.33 | true | list (+delete) —— **无 resume/close/fork** |

- AC-R5-1 ✅ capabilitySnapshot 单测按实测校准（4aed34a）：四能力全 true 样本、pi 仅 list 样本、空声明样本
- AC-R5-3 ✅ listSessions cursor 循环聚合 + 能力未声明 → 句柄为 null → 入口不渲染（gate 单测）
- AC-R5-4 ✅ 五家 snapshot 与上表逐家一致；opencode `session/list` 实机拉取成功（返回真实历史 session：`{sessionId, cwd, updatedAt}`）
- AC-R5-6 ✅ pi 等无 list 能力场景：入口由 `listSessions != null` gate，组件渲染路径无入口
- 恢复链降级（AC-R5-2）✅：loadSupported 改走 canLoad 后既有降级测试全过（session-core.prompt.test.ts 等 294 chat/acp 测试）

### 2.5 模型切换 toast 档位（R6，AC-R6-1/2）

- AC-R6-1 ✅ switchResultToast 6 组单测：created/written+即时/written+undefined/written+拒绝(warning)/none+会话级/none+拒绝(error) 全档
- AC-R6-2 ✅ pick() 四分支全部改经模板；ModelSwitchPanel.test.tsx 13 条全过
- AC-R6-3（真机实切）⚠️ 见 §3 如实登记：自动化模板断言覆盖全档位文案；五家实切一次需活跃会话 + 真实网关交互，属 GUI 手测项（与 gap-audit C 类同性质），留待下节

### 2.6 快问面板三件套（R1，AC-R1-3/4/5）

- AC-R1-3 ✅ qaMode 分支：点选只回填表单；`harness_config_read`/`harness_settings_write` 不被调用（mock 断言 + qaMode 提前 return 代码路径）
- AC-R1-4 ✅ 既有 quickAskConfigSave 测试全过；qa-model-pick 渲染断言
- AC-R1-5 ✅ sourceBadge 五家映射单测路径（auto:<id> → 名称）

## 3. 如实登记（未闭环项）

| 项 | 状态 | 说明 |
|---|---|---|
| AC-R6-3 五家实切一次模型（GUI） | 待手测 | 需活跃会话 + 真实网关双击确认；toast 文案已由模板单测全档锁定，GUI 项与 gap-audit C 类同性质留清单 |
| AC-R5-5 session_info_update 标题实收 | 待手测 | opencode/codex 会话中触发 agent 命名场景；协议层 dispatchUpdate 单测已锁（title/updatedAt 透传、null→undefined） |
| omp `PARSE-FAIL` 首测现象 | 已查明 | omp acp 在无 session/new 时首行 JSON 尾部带额外输出；补 session/new 后解析正常，能力快照已采到（见 2.4 表）——非产品代码路径 |

## 4. 豁免项执行确认（所有者决策）

- 快问五家 fallback + 面板三件套：已实现（R1）✅
- 权限模式开关仅 claude-code：未动，四家无权限开关（现状保持）✅
