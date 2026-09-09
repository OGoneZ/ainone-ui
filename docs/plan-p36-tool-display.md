# P36 规格需求书：Harness 工具显示重构——终端两段式展开 / kind 差异化风格 / 写操作预览入口 / 文件树两项缺陷修复

> 状态：**已确认**（用户 2026-09-09 提出五项诉求：终端展开两段式、按工具类型差异化风格、写操作旁预览文件按钮、终端 tab 文件树无工作区排查、分屏下文件树点击预览失效排查。要求规格先行、worktree 实现、分步提交）。
> 执行分支：`zhubaoduo/feat/p36_tool_display`（worktree `.claude/worktrees/p36_tool_display`，基于 main @ 80e25c2）。
> 性质：工具卡显示体验重构（P30 的延伸）+ 两项交互缺陷修复。

## 0. 背景与探索结论（代码级事实）

### 0.1 当前工具卡渲染链路（改造落点）

```
ACP session.update → session-core.ts:dispatchUpdate(584) → Outgoing(tool_call/tool_update)
  → turn.ts:applyEvent(40) → message-log.ts:appendTool/updateTool(137/145)
  → sessionStore → ChatPanel 帧级节流提交 → MessageLine/BlockView 渲染
```

- 单工具卡：`src/chat/message/BlockView.tsx:140` `ToolBlock`——头部（chevron+kind 图标+title+副标题+耗时+状态字），展开体 `ToolContentView`（text→ToolTextView / diff→DiffView / terminal→占位）。
- 副标题提炼：`src/acp/toolDisplay.ts:95` `toolSubtitle(rawInput)`——command/pattern/file_path|path/url/prompt/skill 按字段名命中；超 80 字符截断，全量在 title 属性。
- 折叠 CSS：`.tool-head`（messages.css:11）nowrap + ellipsis——长命令视觉折叠（无 JS 折叠）；展开体 `.tool-body`（messages.css:55）max-height 320px 内滚动。
- 默认展开：`disclosure.ts:20` `defaultOpen`——含 diff 展开、其余折叠；diff 边沿自动展开（BlockView.tsx:176-184 + `shouldAutoOpen`）；用户手动操作后 `userToggledRef` 永不自动干预。
- 活动组卡：`MessageLine.tsx:197` `ActivityGroupCard`——turn 结束后连续已结算 thought/tool 收组；组内另有 `FileChangeRow` 第二条 diff 渲染路径（326）。

### 0.2 协议数据面（五种 harness 差异）

- `ToolCallUpdate`（SDK types.gen.d.ts:140）字段：`toolCallId/kind/status/title/name/content/locations/rawInput/rawOutput`。**`rawOutput` 目前被 dispatchUpdate 丢弃**（session-core.ts:596-617 只透传 kind/rawInput）——终端输出只能靠 content 里的 text。
- 五 harness 共用同一前端通路、无 per-harness 分支；差异全在桥的填写程度：
  - omp：tool_call 初帧带 `kind/status/title/rawInput/locations`（样本 `omp-acp-session.jsonl:16`）；update 帧不带 kind/rawInput，**rawOutput 是 omp 私有形状** `{content:[{type:"text",text}], details:{...}}`。
  - claude-code 桥（claude-agent-acp）：tool_call 首帧 rawInput 常为 `{}`、细节在后续 tool_update 补齐；Bash→`{command}`、Read/Write/Edit→`{file_path}`；title 粗（"Terminal"/"Read File"）。
  - codex/opencode/pi：按 ACP 规范填写，opencode 原生 ACP。
  - **无任何 harness 发 `type:"diff"` / `type:"terminal"` 的真实样本**（omp bash 进程内执行，不经 ACP terminal 回调）；本仓握手声明 `terminal:false`（session-core.ts:330），terminal content 在当前五桥下不会出现。
- kind 十类：`read|edit|delete|move|search|execute|think|fetch|switch_mode|other`；status 四态：`pending|in_progress|completed|failed`（error 为本地历史值）。
- rawInput 文件路径字段双形：claude 系 `file_path`、omp 系 `path`（toolDisplay.ts:109 已双认）。

### 0.3 文件树与预览链路（缺陷面）

- 文件树：`src/sidebar/FileTree.tsx:24`；「无工作区」条件 = `!cwd`（FileTree.tsx:67）；数据源 `Tab.cwd`（`src/app/logic/tabs.ts:16`）。
- 预览链路：FileTree 点击 → RightRail.tsx:218 dispatch `CustomEvent("ainone:open-file")`（**全局事件，不带 tabKey**）→ ChatPanel.tsx:426 监听 → `setPreviewPath` → `FilePreview` 浮层（ChatPanel.tsx:1524）。
- **缺陷 R5 根因**：ChatPanel.tsx:427 `if (!(activeRef.current ?? true)) return;`——事件按「全局活跃窗格」过滤。分屏下点的是失焦窗格的文件树时，该窗格 ChatPanel 非活跃 → 预览静默丢弃。同一守卫也拦 `ref-file/jump-message/rewind-request`。与 P34 结论同理：这是「焦点」语义被误用作「归属」语义。
- **缺陷 R4 候选根因**（用户报告「打开终端后文件树显示无工作区」）：
  1. 工具栏「新建终端」用 `activeTab?.cwd`（App.tsx:1162）——**当前聚焦窗格是未选工作区的会话（cwd undefined）时，新建终端也不带 cwd**；侧栏工作区右键「新建终端」带 `g.workspace?.cwd ?? activeTab?.cwd`（App.tsx:1221-1224），workspace 有值才可靠。
  2. 快捷键 `app.new-terminal`（App.tsx:375）同 1。
  3. 从侧栏历史打开终端条目：`resolveHistoryOpen`（tabs.ts:53）cwd 空串 → undefined，**不再回落 workspace.cwd**。
  4. `Tab.cwd` 创建后不可变（无任何更新路径）——创建时缺 cwd 则永远「无工作区」。
  5. TerminalPanel 的 PTY spawn（terminal.rs:100）cwd 空 → 无 `cmd.cwd()`，shell 落在 Tauri 进程 cwd；文件树同样无目录可列。
- 文件树「M」徽标：`collectModifiedPaths`（lib/fileTree.ts:32）只看 tool 块 content 里的 diff path。

### 0.4 基线状态

- main @ 80e25c2，vitest 676 中 **1 失败**（MetadataPanel.test「setConfigOption 返回 null → toast.warning」）：1ad76ce 引入 sessionOnly 语义后拒绝路径改走 toast.error，测试未同步——**main 侧遗留回归，本仓 S0b 顺带修复**（改动面极小：断言改为 toast.error + 不写全局配置）。
- 其余 675 全绿；worktree 复用主仓 node_modules（symlink）。

### 0.5 范围外（明确不做）

- 不实现 ACP `terminal/*` 客户端回调（`terminal:false` 保持）；terminal 类 content 占位渲染不变。
- 不改各 harness 桥进程；omp rawOutput 的 `details` 私有结构不解析（只取 content text）。
- 不做「终端内 cd 后文件树跟随」（无 OSC7/shell-integration 数据源，成本高收益低，登记 ideas）。
- 不做工具块树形嵌套（subagent 内部层级，协议无数据支撑）。
- 不动权限请求、回溯、分叉等既有链路。

---

## R1 — 终端（execute 类）工具两段式展开

### 目标

点击终端类工具卡展开时，一个框内清晰两段：**上段 = LLM 原始命令全文**（当前只有头部一行省略副标题），**下段 = 实际输出**。折叠行为保持现状（默认折叠、头部省略号）。

### 方案

- **命令段**：展开体顶部新增 `CommandView`——完整命令（`toolSubtitle` 命中 command 字段的**未截断原值**，从 `rawInput.command` 直取，换行保留、不做空格折叠），等宽字体、浅底色块、可多行，右侧「复制」小钮（clipboard + toast）。命中不了 command（rawInput 缺省/旧日志）→ 整段不渲染（head 的 title 属性仍有全量 title 兜底）。
- **输出段**：现有 text content → ToolTextView 原样（JSON/ANSI/折叠逻辑不动）。
- **rawOutput 兜底透传**：`dispatchUpdate` 两个 case 增 `...("rawOutput" in u.update ? { rawOutput: u.update.rawOutput } : {})` → Outgoing → turn → updateTool patch（与 rawInput 同款「携带才覆盖」）→ BlockMsg tool 块增 `rawOutput?: unknown`（宽容解析，isBlock 不校验形状）。**消费规则**：content 里无 text 输出且 rawOutput 存在时，提取 rawOutput 的 text（omp 形状 `rawOutput.content[].text` 拼接；纯字符串直接用；JSON 对象 prettyJson）作为输出段兜底——覆盖 omp「update 帧只有 rawOutput 无 content」的实测形状。`rawOutput` 不做序列化体积限制（输出超长时 ToolTextView 已有 2000 字符折叠层）。
- **判定口径**：命令段渲染条件 = `toolKind === "execute"` 或（toolKind 缺省且 rawInput 有 command 字段）——不依赖 kind 准确性（与 toolSubtitle 同纪律）。无 content 且无 rawOutput 时展开体只显示命令段（不再是空白框）。
- **CSS**：`.tool-command`（等宽、pre-wrap、bg-1 底、圆角）；`.tool-command-copy`（hover 显现小钮）。`.tool-body` 内部改为 flex column gap 8px，命令段在上、输出段在下，各段独立滚动语义不变。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 1.1 | execute 块展开：命令段完整显示 rawInput.command 原文（含换行、不截断）；头部副标题折叠行为不变 | vitest（组件） |
| 1.2 | 命令段「复制」点击 → clipboard 写入原文；不改变折叠态 | vitest（组件，mock clipboard） |
| 1.3 | 输出段：text content 走 ToolTextView（ANSI/JSON/折叠不回归）；无 text content 但 rawOutput 带 text → 兜底显示；两者都无 → 只显示命令段 | vitest |
| 1.4 | rawOutput 透传：tool_call/tool_update 携带 → Outgoing 带同值；不携带 → 干净缺省；update 携带 → 落块，缺省保留旧值 | vitest（session-core/turn/message-log 三层） |
| 1.5 | 旧日志（无 rawOutput）解析不回归；BlockMsg 新字段可选序列化往返无损 | vitest（message-log 存量 + 新样例） |
| 1.6 | 非 execute 类（read/edit）不渲染命令段 | vitest |

## R2 — 工具卡按 kind 差异化风格

### 目标

read/edit/terminal 等各类工具卡有可辨识的差异化外观（不同配色/视觉签名），一眼区分操作类型；失败态语义不变。

### 方案

- **挂点**：`ToolBlock` 根容器 `data-toolkind={toolKind ?? "other"}`（BlockView.tsx:199 同款 data 属性模式）。ActivityGroupCard 的组卡不加 kind 色（组内混多类，保持中性——组内单卡仍各自着色）。
- **配色**（messages.css 按 data-toolkind 分支，全部基于既有设计令牌 + color-mix，深浅主题自动适配）：
  - `execute` 终端：左边框 2px `var(--primary)`、KindIcon 着 primary——执行/命令语义。
  - `edit` 编辑：左边框 2px `var(--warning)`、图标 warning——写操作警示语义。
  - `delete` 删除：左边框 2px `var(--danger)`、图标 danger。
  - `read` 读取：图标 `var(--text-secondary)`（中性，量大不喧宾）；无左边框。
  - `search` 搜索：图标 `var(--primary)`；无左边框。
  - `fetch` 获取：图标 `var(--success)`。
  - `move`/`switch_mode`：图标 warning / primary。
  - `think`/`other`/缺省：中性（现状不变）。
  - 失败态：`.tool[data-status="failed"]`/`error` 头部状态字 danger 点睛**保持现状**，kind 左边框不与失败冲突（失败额外给左边框统一置 danger——语义合并优先）。
- **左框实现**：`.tool { border-left-width: 2px }` 由 kind 分支覆盖 + `border-left-color`；body/head 底色不动（DEC-48 中性化结论不推翻——只加「边框+图标」两级点睛，不引入大面积底色）。
- icons.ts 无新增导出（色在 CSS 层）。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 2.1 | ToolBlock 根容器带 `data-toolkind`（值=协议 kind；旧日志缺省→"other"） | vitest（组件） |
| 2.2 | CSS：execute/edit/delete 左边框色 + 各 kind 图标色规则存在且取设计令牌；dark 主题令牌换值自动生效 | 代码走查 + 走查 index.css 令牌引用 |
| 2.3 | failed/error 状态字仍 danger；kind 边框在失败态不改变危险语义 | vitest + CSS 走查 |
| 2.4 | 活动组卡头不着 kind 色（中性），组内单卡有着色 | 代码走查 |

## R3 — 写操作工具卡「预览文件」按钮

### 目标

对会自动展开 diff 的写操作（edit/delete/move 及带 file_path 写语义的 other），工具头部提供「预览文件」按钮：点击 = 文件树点文件同款行为（窗格内 FilePreview 打开该文件），方便对照最新全文。

### 方案

- **按钮位置**：`.tool-head` 内、耗时/状态字之前，hover 显现（同 msg-action-btn 交互习惯）；`EyeIcon`（icons.ts 增映射）；`e.stopPropagation()`——不触发折叠/展开（与「引用」按钮同款纪律，FileTree.tsx:138）。
- **路径解析**（新纯函数 `previewTargetOf(block): string | null`，进 `src/acp/toolDisplay.ts`）：优先级 ① content 里 diff 的 path；② rawInput 的 `file_path`/`path`。返回 null 不渲染按钮。
- **渲染条件**：`previewTargetOf` 命中且该路径在 cwd 下或绝对路径均可（FilePreview 直接接受绝对路径，无需 cwd 校验）。
- **事件通道**：按钮点击 `window.dispatchEvent(new CustomEvent("ainone:open-file", { detail: { path, tabKey } }))`——detail 从 string 升级为 `{path, tabKey}`（旧 string 形状向后兼容：监听侧 typeof detail === "string" 时视作本窗格，保 FileTree 旧路径）。FileChangeRow（MessageLine.tsx:326）同步加同款按钮（第二条 diff 渲染路径不能漏）。
- **R5 修复（本 R 的依赖前置）**：ChatPanel 四个监听器（open-file/ref-file/jump-message/rewind-request，ChatPanel.tsx:411-441）守卫从「全局 active」改「归属本窗格」：`detail.tabKey === tabKey`（或旧 string 形状 + activeRef 兜底）。**这是缺陷修复：分屏下点失焦窗格文件树 → 该窗格正确响应预览，不再静默丢弃**；同时消除多窗格串扰的真因（事件本就该带归属，而非靠活跃性猜）。
- RightRail 的 FileTree onOpenFile/onRefFile dispatch 补 `{path, tabKey: props.tabKey}`（RightRail 已有 tabKey prop）。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 3.1 | 含 diff 或 rawInput 带 file_path/path 的工具卡头部有预览按钮；read/search/execute 无 | vitest（组件） |
| 3.2 | 点击预览按钮：dispatch 的 detail 为 {path, tabKey}；折叠态不变（stopPropagation 生效） | vitest（组件 + 事件 spy） |
| 3.3 | ChatPanel 收 {path, tabKey=自己} → setPreviewPath；tabKey=别人 → 忽略；旧 string detail → 按 active 守卫兼容 | vitest（ChatPanel 层） |
| 3.4 | 分屏场景：失焦窗格文件树点文件 → 该窗格打开预览（R5 根治） | vitest（双窗格模拟）+ 实机冒烟 |
| 3.5 | FileChangeRow 同步有预览按钮，行为同 3.2 | vitest |
| 3.6 | FilePreview/HistoryPanel 既有监听零回归 | vitest 存量 |

## R4 — 终端 tab「无工作区」修复

### 目标

任何入口新建的终端 tab，文件树都能显示工作目录；历史打开的终端条目也能找回目录。

### 方案

- **创建侧兜底**（App.tsx `newTerminalTab`）：cwd 缺省时按 `workspaceId → workspaces.find(w => w.id === workspaceId)?.cwd` 兜底解析；仍无 → **不静默**：toast.warning「终端未绑定工作目录，文件树不可用」（fail loud，Rule 12）。
- **三个调用点统一过 resolveTerminalCwd 纯函数**（进 `src/app/logic/tabs.ts`）：`(cwd?, workspaceId?, workspaces) => string | undefined`——cwd 非空直用；否则 workspaceId 反查；再否则 undefined。
- **恢复侧兜底**：`resolveHistoryOpen`（tabs.ts:32）terminal kind 条目 cwd 空时同样按 workspace_id 反查（函数已收 tabs 上下文吗——不收 workspaces，改为调用方 App 在 openFromHistory 处先做 resolve 再传入，tabs.ts 纯函数签名加可选 `fallbackCwd` 参数）。
- **既有 agent tab 不动**（agent 会话无 cwd 是合法态，文件树「无工作区」提示对它是正确语义）。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 4.1 | resolveTerminalCwd：cwd 优先、workspaceId 反查次之、都无 undefined | vitest（纯函数） |
| 4.2 | 工具栏/快捷键/工作区右键三个入口新建终端：activeTab.cwd 空但 workspaceId 可查 → tab.cwd 落到 workspace.cwd；完全无 → tab 可建但 toast 提示 | vitest（App 层） |
| 4.3 | 侧栏历史打开终端条目（cwd 空串 + workspace_id 有值）→ 文件树有目录 | vitest |
| 4.4 | 终端 tab 无 cwd → 文件树「无工作区」提示保留（不假装有）+ 创建时 toast 提示不吞 | vitest |

## R5 —（并入 R3 第 4 步，无独立改造）

守卫语义修正 + detail 带 tabKey，见 R3。本 R 独立验收项：

| # | 验收项 | 判定方式 |
|---|---|---|
| 5.1 | 分屏下失焦窗格文件树点文件 → 预览落在该窗格（不落活跃窗格、不丢弃） | vitest 双窗格 + 实机 |
| 5.2 | 旧 string detail（无 tabKey）路径：活跃窗格收、非活跃窗格丢（与现状一致，兼容兜底） | vitest |

---

## 执行顺序与 commit 划分

| 步 | 内容 | commit 前置全绿 |
|---|---|---|
| S0 | 规格书提交（docs/plan-p36-tool-display.md） | — |
| S0b | 基线回归修复：MetadataPanel.test 断言对齐 sessionOnly 语义（toast.error）| vitest 全绿 |
| S1 | R1：rawOutput 透传三层 + CommandView 两段式展开（tsc + vitest） | 全部 |
| S2 | R2：data-toolkind + kind 差异化 CSS（tsc + vitest） | 全部 |
| S3 | R3+R5：previewTargetOf + 预览按钮（ToolBlock/FileChangeRow）+ 事件带 tabKey + ChatPanel 守卫改归属语义（tsc + vitest） | 全部 |
| S4 | R4：resolveTerminalCwd + 三入口 + 历史恢复兜底（tsc + vitest） | 全部 |
| S5 | `pnpm build` + 实机冒烟（分屏失焦预览、终端 tab 文件树、五 kind 工具卡样式、终端两段式）+ docs/acceptance/P36-2026-09-09.md + merge 回 main（先核对 main 新提交） | 全部 |

每步一个 commit（Conventional Commit，**无 AI 署名尾行**——仓库 hook 拒绝）。S1–S4 内部若膨胀再拆，不积累超级大 commit。

## 风险与对策

- **BlockMsg 增字段撞并行分支**：main 上多 agent 并行（P35 quickask / p35 stream pacing），merge 时先核对 main 新提交；新字段全可选、isBlock 宽容，冲突面小。
- **detail 形状升级（string → object）**：三处 dispatch（RightRail ref-file/open-file、HistoryPanel jump/rewind）+ 四处监听同 commit 内原子切换；监听侧双向兼容保旧日志/旧调用方不炸。
- **kind 缺省（旧日志/粗桥）**：全部差异化特性走「命中才渲染/中性兜底」，缺 kind 不白屏不报错。
- **P31 帧级节流**：ToolBlock 新增 UI 全部为终态内容渲染（流式中不新增高频路径），不触碰节流契约。
