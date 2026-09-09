# P39 规格书：Ctrl+P 呼出模型切换 + 面板键盘导航 + 新会话焦点锁定

> 日期：2026-09-09
> 前置调研：本会话（keymap 键位注册中心 / ModelSwitchPanel 三处复用点 / ChatPanel 建链时序）

## 0. 需求与裁决

用户需求：
1. 窗口聚焦时 Ctrl+P 呼出「切换模型」面板（等效点击右栏元数据里的模型行）。
2. 该快捷键登记进快捷键面板（可改绑）；面板内其他键（输入过滤、↑↓ 选择、Enter 确认）是自然操作，不登记。
3. 模型切换面板支持键盘操作：打开即聚焦过滤框，直接输入即过滤，↑↓ 选择，Enter 确认，Esc 关闭。
4. **三处入口统一**：设置页（表单链路 / 快问链路）的 ModelSwitchPanel 与右侧栏是同一个组件（已核实：`SettingsModal.tsx:1019/1037` 复用 `ModelSwitchPanel`），键盘导航实现一处三处全生效，无需另改。
5. 新建会话（新建窗口/session）后焦点自动锁定在输入框，可直接开聊。

**裁决 1 — Ctrl+P 只对会话 tab 生效。** 模型面板数据源（configOptions / probeBaseUrl / 会话句柄）全部挂在活跃会话上；欢迎页（无 tab）与终端 tab（无 harness）没有模型语义 → 快捷键不动作。这与右栏模型行只在该场景渲染的边界一致。

**裁决 2 — 复用 ModelSwitchPanel，不新写面板。** 已核实设置页两处、右栏一处全部复用同一组件（金标准：不重复造轮子）。键盘导航与 aria 语义加在该组件内部，`qaMode`/`sessionOnly`/`formContext` 三种模式的点选路径原样复用 `pick()`，不另开确认通道。

**裁决 3 — 新会话焦点走既有 activateTabsetAndComposer 链路。** `newTab()` 建链后已有一套重试式聚焦器（`App.tsx activateTabsetAndComposer`，textarea 就绪即聚焦，最多 ~0.5s）；侧栏点击/搜索打开会话已走该链路，唯独 `newTab()`（新建会话确认后）没接焦点移交。补上同款调用即可，不新发明聚焦机制。

## 1. 改造项

### R1 键位注册 `src/app/logic/keymap.ts`

- `ShortcutId` 新增 `"app.switch-model"`。
- `DEFAULT_DEFS` 新增：`{ id: "app.switch-model", scope: "global", label: "切换模型（当前会话）", defaults: [{ code: "KeyP", ctrl: true }] }`。
- 持久化/冲突检测/改绑录制零改动（parseOverrides 用 validIds 集合自动接纳新 id）。

### R2 快捷键接线 `src/app/App.tsx` 全局 keydown

- 在既有 P25 全局四键块追加：命中 `app.switch-model` 时：
  - 守卫：`activeTab` 存在且 `kind !== "terminal"`（终端/空布局不动作，不 preventDefault）；
  - 动作：`setModelPanelOpen(true)`（App 级新 state，见 R4）。
- 模态浮层开着时让位：同 `pane.temp-maximize` 先例，target 命中 `[role='dialog'], [cmdk-root]` 直接返回。

### R3 App 级模型面板 `src/app/App.tsx`

- 新增 state `modelPanelOpen`；`activeTab` 为会话时在布局区挂载 `ModelSwitchPanel`，props 从既有活跃会话数据合成：
  - `adapterId/adapterName` ← `activeAdapter`
  - `baseUrl` ← `probeBaseUrl` 同款口径（静态配置优先）。App 级新增一次性 `fetchHarnessMeta(activeAdapter.id)` 兜底（右栏 MetadataPanel 已有会话级数据，但 App 级不可达——`sessionOnly` 语义只依赖 configOptions 与会话句柄，静态配置仅探测基准用）
  - `currentModel` ← 读 `useSessionStore` 的 `runtime[activeKey].configOptions`（extractSessionModel）→ 静态 meta → adapter.args 链（同 MetadataPanel 口径，抽 `sessionModelOf` 纯函数复用）
  - `configOptions` ← store 同上
  - `onSessionModelChange` ← 包装 `activeSession.setConfigOption`（与 MetadataPanel.sessionModelChange 同构：找到 category=model 的 option → 调用 → 写回 store → 返回 boolean）
  - `sessionOnly` ← true（侧栏语义：仅当前会话，不写全局配置）
- 仅 `modelPanelOpen && activeTab && activeTab.kind !== "terminal"` 时渲染；`activeTab` 切换/关闭时面板自动关闭（open 条件含 tab 存在性）。

### R4 ModelSwitchPanel 键盘导航 `src/sidebar/ModelSwitchPanel.tsx`

- **自动聚焦**：面板 open 时 filter input `autoFocus`（radix Dialog 内容挂载即聚焦，无闪烁）。
- **↑↓ 移动高亮**：filter input 的 onKeyDown 捕获 `ArrowUp/ArrowDown`：`e.preventDefault()` + 高亮 index 在 `filtered` 范围内循环移动；filtered 变化（输入过滤）时高亮重置为 0。
- **Enter 确认**：高亮行存在时 `preventDefault()` + 调用该行的 `pick(model)`；无高亮/列表空不动作（表单默认提交被拦截）。
- **Esc 关闭**：radix Dialog 自带（onOpenChange），无需新增。
- **高亮渲染**：`msm-row` 增加 `data-kb-active` 行（与「当前模型」的 `.active` 类正交——当前模型标记是持久状态，键盘高亮是瞬态选择）；高亮行 `scrollIntoView({ block: "nearest" })`（P26c slash 菜单同款）。
- **aria**：listbox 行 `aria-selected` 语义保持「当前模型」不变；键盘高亮用 `aria-activedescendant` 表达在 filter input 上（可访问性正交，不影响既有测试断言）。
- 三处入口（右栏 / 设置页表单链路 / 设置页快问链路）自动获得同一行为。

### R5 新会话焦点锁定 `src/app/App.tsx` newTab

- `newTab()` 的 `addTabToModel(...)` 之后追加 `activateTabsetAndComposer(所在 tabset id)`——addTabToModel 内部 `syncFromModel()` 已让 activeKey 指向新 tab；聚焦器重试式等待 textarea 就绪（新建会话无建链阻塞，textarea 立即可用；历史会话打开链路已验证该模式可靠）。
- 覆盖入口：Ctrl+N 新建会话弹窗确认（confirmNewSession→newTab）、侧栏「+」、EmptyState 按钮——全部经 newTab 单点收口。分屏/拖拽开 tab 不在范围（用户语义是「新建一个 session 开聊」）。

## 2. 验收标准

| # | 标准 |
|---|---|
| AC-1 | 会话 tab 聚焦时按 Ctrl+P（或用户改绑键），弹出模型切换面板；面板内容与右栏模型行点击打开的完全一致（同组件、sessionOnly 语义） |
| AC-2 | 欢迎页（无 tab）/ 终端 tab / 任意模态浮层开着时按 Ctrl+P 无动作 |
| AC-3 | 快捷键面板「全局」组出现「切换模型（当前会话）」行，默认键 Ctrl+P，可录制改绑、冲突拒绝、恢复默认（与既有键位行为一致） |
| AC-4 | 欢迎页快捷键提示区**不**新增 Ctrl+P 行（用户明确：只有快捷键面板登记，其他自然操作不登记） |
| AC-5 | 模型面板打开后过滤框自动聚焦，直接打字即过滤模型列表 |
| AC-6 | ↑↓ 在过滤结果间循环移动高亮，高亮行滚入可视区；继续输入过滤后高亮重置为第一项 |
| AC-7 | Enter 确认高亮项：走与鼠标点选完全相同的 pick 链路（sessionOnly 即时生效 toast；qaMode 回填；formContext 写回），面板关闭 |
| AC-8 | 设置页「配置模型」与「快问模型」面板同样支持自动聚焦/↑↓/Enter（同一组件自动获得） |
| AC-9 | Ctrl+N 新建会话确认后，新 tab 激活且输入框自动聚焦，可直接打字开聊；侧栏「+」新建同效 |
| AC-10 | 既有测试全绿；新增测试覆盖：keymap 默认表含 app.switch-model、面板键盘导航（过滤/↑↓/Enter）、newTab 焦点 |

## 3. 非目标

- 不做全局模型快切（不经会话直接改配置文件）——Ctrl+P 语义 = 右栏模型行的键盘等效。
- 不改 ModelSwitchPanel 的探测/写回/快问逻辑。
- 不给过滤/↑↓/Enter 单独登记进快捷键面板（用户明确要求）。
