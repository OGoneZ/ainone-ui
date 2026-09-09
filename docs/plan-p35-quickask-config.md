# P35 需求文档：快问悬浮窗自适应 / 快速解释自定义提示词 / 五 harness 配置可用性

> 状态：已交付（2026-09-09，c279776/c9bb80d/2551333；vitest 685 全绿、cargo 151 全绿、build 零报错）
> 分支：zhubaoduo/feat/p35_quickask_config（基于 main 7ab2000）

## 背景与现状诊断

### A. 快问悬浮窗溢出

- `QuickAskPopup`（src/chat/composer/QuickAskPopup.tsx:40-44）用 `position:absolute; top:anchor.y; left:anchor.x` 定位，anchor 由 `ChatPanel.onSelectText`（src/chat/ChatPanel.tsx:883-898）按 `clientX/Y - rect.left/top` 换算。
- 缺陷：anchor 取自鼠标位置，**不感知悬浮窗自身尺寸与容器边界**。靠近右缘/下缘选中文字时，悬浮窗（max-width 480px、body 最高 40vh）直接越出可视区，用户看不到。
- CSS（src/chat/composer/composer.css:52-62）已有 `max-width: min(480px, 72vw)`，body 有 `max-height: min(40vh,360px)` 内滚，但「定位越界」没人管。

### B. 快速解释提示词硬编码

- 系统提示词写死在 `QUICK_ASK_SYSTEM_PROMPT`（src-tauri/src/quickask.rs:234），`build_chat_body` / `build_anthropic_body` 直接引用（:237-245, :265-272）。
- `QuickAskConfig`（:57-74）无提示词字段；前端 `QuickAskConfigView/Input`（src/ipc/quickask.ts）同样没有。设置页「快问模型」卡片（SettingsModal.tsx:888-935）没有对应输入项。

### C. 五 harness 配置「摆设」问题

用户在 OMP（oh My Pi）上遇到「切换模型显示当前只支持 URL 修改」。证据链：

| harness | 配置代写（设置页保存三格） | 定点写回 model（ModelSwitchPanel pick→writeHarnessSettings） | 证据 |
|---|---|---|---|
| claude-code | ✅ claude_merge_write | ✅ write_claude | harness_meta.rs:354 |
| codex | ✅ codex_merge_write | ✅ write_codex | :433 |
| opencode | ✅ opencode_merge_write | ✅ write_opencode | :495 |
| omp | ✅ omp_merge_write（能写 model） | ❌ **write_omp 只支持 base_url**（:471-472 `ok_or("omp 仅支持写回 baseUrl")`） | 不对称 |
| pi | ✅ pi_merge_write（能写 model） | ❌ **直接报错不支持定点替换**（:327-329） | 不对称 |

- `supportsWrite`（src/ipc/harnessMeta.ts:52-54）只控制 UrlEditPanel 显隐，与 model 写回能力混为一谈。
- 设置页「模型名」点击打开 ModelSwitchPanel（formContext 链路）理论上能走 `harnessConfigSave` 代写，但 omp/pi 在 `present=true` 时落入 `writable=false` 分支 → toast error「该 harness 无配置写回，无法持久化」，用户改了 URL/key 之后没有任何方式选模型并生效。
- 另发现 ModelSwitchPanel.pick 中 `onSessionModelChange` 存在**重复调用两次**的 bug（src/sidebar/ModelSwitchPanel.tsx:226-231 两段相同代码）。
- 会话级生效链路 `session/set_config_option`（session-core.ts:424-436）五家均有 model select configOption（P32f 实测），是「改完即生效」的正道。

## 目标

1. 快问悬浮窗在视口内自适应定位，任何情况下不越出页面。
2. 快速解释提示词可配置：默认用内置提示词，用户可在设置中修改。
3. 五 harness 在设置页修改 URL/key 后，都能探测并选择模型，且写回真实生效（新会话/当前会话），不再是无效按钮。

## 需求与验收标准

### R1 快问悬浮窗视口自适应

**R1.1** 选中文字弹出悬浮窗时，位置必须根据悬浮窗实测尺寸 + 容器（.chat 内容区）边界修正：右溢出左翻（或左贴边），下溢出上翻（或上贴边），四周至少留 8px 边距。

**R1.2** 流式渲染导致悬浮窗尺寸增长时（streaming→ok），已显示的位置不得越界（增长方向朝左/朝上，或 clamp 修正）。

**R1.3** 无鼠标坐标的降级场景（键盘触发/程序调用）保持现状默认位置，同样接受越界修正。

**R1.4** 实现放 ChatPanel 的 anchor 计算层（挂载后 measure + clamp），QuickAskPopup 保持纯展示；不得改 CSS 尺寸语义。

**AC1.1** vitest 单测：给定容器 800×600、悬浮窗实测 300×200，anchor 在 (700,500) → 修正后 anchor.x ≤ 800-8-300，anchor.y ≤ 600-8-200。
**AC1.2** vitest 单测：anchor 在 (10,10) 正常不翻转；anchor 恰在容器边缘 → clamp 后 ≥ 8。
**AC1.3** 现有 ChatPanel/QuickAsk 相关测试全绿；`npm run build` 零报错。

### R2 快速解释自定义提示词

**R2.1** `quickask.json` 增加 `system_prompt` 字段（Option，空/缺失 = 用内置默认）；两协议请求体（openai system / anthropic system）均使用它。

**R2.2** 设置页「快问模型」卡片新增「解释提示词」textarea：打开时回显当前生效值（自定义值或内置默认占位）；用户可编辑；清空 = 恢复默认。

**R2.3** 保存随现有「保存」按钮走 `quickask_config_save`，立即对下一次「快速解释」生效，无需重启。

**R2.4** 内置默认提示词文本保持 QUICK_ASK_SYSTEM_PROMPT 常量，作为回显占位与回退值；前端与 Rust 常量单一来源（前端占位文本可复制常量，Rust 是运行时事实源）。

**AC2.1** Rust 单测：config 含自定义 system_prompt → build_chat_body/build_anthropic_body 的 system 字段为自定义值；缺失/空 → 内置常量。
**AC2.2** Rust 单测：quickask_config_save 传空提示词 → 落盘不含/为空 → 调用回落默认。
**AC2.3** 前端 vitest：SettingsModal 渲染「解释提示词」textarea 且回显默认占位；修改后保存调用 quickAskConfigSave 携带 prompt 字段。
**AC2.4** IPC 类型同步：QuickAskConfigView 增加 `system_prompt: string`（回显实际生效值），Input 增加 `system_prompt: string`（空 = 恢复默认）。

### R3 五 harness 配置改后可选模型并生效

**R3.1（后端对齐）** `harness_settings_write`（write_omp/write_pi 补齐）：omp 定点写回支持 model（行级锚定 `id:` 于 providers 段 models 列表 + ai 顶层无 model 字段则跳过——按 omp 真实结构验证）；pi 的定点写回不改（pi 走会话级 + 设置页代写已覆盖），但错误信息改为可操作指引。

**R3.2（设置页链路）** 设置页 harness 卡片：修改 endpoint/key 后点「模型名」→ ModelSwitchPanel 用**表单当前值**探测（已实现 formContext 链路）→ 点选模型 → omp/pi 也必须能持久写回（走 harnessConfigSave 代写全量三格，而非报错）。

**R3.3（生效语义如实提示）** 写回成功后按真实生效面提示：有活跃会话且 set_config_option 成功 →「本会话即时生效」；否则「对新会话生效」。杜绝「已写入但什么都不发生」的静默。

**R3.4（顺手修 bug）** ModelSwitchPanel.pick 中 onSessionModelChange 重复调用两次的缺陷修复（P32f 合并时引入的重复块）。

**AC3.1** Rust 单测：write_omp(raw, Some(url), Some(model)) 落盘含新 baseUrl 与新 model id；key 行不动。
**AC3.2** 前端 vitest（ModelSwitchPanel）：omp + formContext.present=true 点选模型 → 调用 harnessConfigSave（program=omp，endpoint/key/model 来自表单），不出现「无法持久化」错误 toast。
**AC3.3** 前端 vitest：pick 只调用 onSessionModelChange 一次（回归 R3.4）。
**AC3.4** 设置页 vitest：修改 endpoint 后打开模型面板，probeModels 收到的 baseUrl 为表单新值（已有行为锁定，防回归）。
**AC3.5** 全量 vitest + cargo test + `npm run build` 全绿。

## 非目标

- 不改快问悬浮窗的视觉样式/动画。
- 不做提示词的「多套预设」管理（单值即可）。
- 不为 pi 增加定点替换（配置代写 + 会话级切换已覆盖需求）。
- 不改 claude-code/codex/opencode 既有写回语义。

## 实现切分（对应 commit 顺序）

1. `feat(quickask): 悬浮窗视口自适应定位`（R1）
2. `feat(quickask): 快速解释自定义提示词`（R2，Rust+前端）
3. `fix(harness): omp 模型写回补齐 + 设置页 omp/pi 选模型走代写`（R3.1/R3.2/R3.3）
4. `fix(sidebar): ModelSwitchPanel 会话级切换重复调用修复`（R3.4，可与 3 合并）
