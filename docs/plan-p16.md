# ainone-ui · P16 侧栏预览 / 消息锚点 / 队列悬浮重构 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-05
**状态**：已批准基线（用户 2026-09-05 口述需求 + 双路探索 + 社区调研）
**上游关系**：承接 P13（架构分层，`a56a46f` 已合入）/ P15（体感精修，`d3b6fd5` 已合入）；队列逻辑复用 P9 F-9-3 已验证的消费时机
**选型金标准**：优先成熟稳定社区方案，不重复造轮子；AIONUI（`~/dev/AionUi`，Electron+React 同域产品）作参考实现

---

## 0. 现状诊断（2026-09-05，基线 main `c786227`）

| # | 症状 | 证据 |
|---|---|---|
| D1 | 文件树只能「引用」，无任何文件预览能力——想看 agent 刚改的文件必须切到外部编辑器 | `FileTree.tsx:134-146` 仅 hover「引用」按钮；全仓无 preview 组件；`fd_read`（fs.rs:13-20）只能读文本 |
| D2 | 长会话里找回自己发过的消息只能狂滚；回溯必须先滚到那条消息 hover 出按钮 | `MessageLine.tsx:51-84` user 气泡无锚点；RightRail 只有 meta/files 两 tab（RightRail.tsx:17）；IDEA-008 anchor rail 未实现 |
| D3 | 队列 UI 是输入框上方的静态条带，不是用户要的「悬浮在消息框上方右下角」；拖拽为 HTML5 原生手搓（`dataTransfer`），无挤位动画、无合并能力 | `CommandQueuePanel.tsx:28-52` 原生 drag 事件；`chat.css:193-198` `.queue-panel` 是文档流内条带；依赖树零 dnd 库 |
| D4 | busy 时回车 = steering（打断当前 turn 立即发新消息），与用户「运行期间不能覆盖前一条消息，后来的进队列」的预期相反 | `ChatPanel.tsx:456-464` submit busy 分支：先 `pendingTextRef.current = full` 再 `await stop()` |

**已验证不必动的部分**：队列消费时机链路（P9 F-9-3 + M1）——`turn_stop` 且 stopReason 非 `cancelled/user` → `dequeue` → `appendUser` → `runPrompt`（ChatPanel.tsx:754-772）；协议样例（docs/protocol-samples/omp-acp-session.jsonl）确认「一 prompt 一轮串行」，**没有任何 turn 中插入第二条 prompt 的样例**，各 harness 行为未知——故维持「turn 自然结束才发送」的保守时机，不冒险 turn 中插入。

## 1. 需求总览（3 项）

| # | 需求 | 用户原话锚点 |
|---|---|---|
| F-16-1 | 文件树点击文件 → 软件内预览（代码/文本/markdown/图片） | 「点开一个文件之后打开，直接在软件内完成预览……参考 AIONUI……有成熟依赖就引入」 |
| F-16-2 | 右侧栏新增「历史」条目：用户历史消息树，点击跳转，每条带回溯小按钮 | 「显示一条消息树，用户点击可快速跳转到自己发送的历史消息。此外，该区域提供一个小按钮，用于实现回溯功能」 |
| F-16-3 | 队列悬浮化（消息框上方右下角浮层）+ dnd-kit 拖拽挤位动画 + 拖拽合并；busy 发送默认入队不打断 | 「悬浮在整个 session 页面的右下角，在消息框的上面……拖拽影响顺序……放到另一条消息里有吸入合并动画……像手机桌面图标挤走其他软件」 |

## 2. 调研结论

### 2.1 AIONUI 参考实现（源码实测 `~/dev/AionUi`）

| 借鉴点 | AIONUI 做法 | 本仓采纳 |
|---|---|---|
| 预览面板形态 | 聊天区右侧常驻多 tab 面板（PreviewPanel.tsx 1299 行），可拖宽/最大化/分屏 | **轻量化**：窗格内右侧预览浮层（overlay），单文件 + 关闭钮；不做常驻多 tab（RightRail 260px 空间装不下，flexlayout 加 tab 会搅动分屏语义） |
| 格式判定 | 扩展名 → 内容类型单点映射（fileUtils.ts FILE_EXTENSION_MAP），code 兜底 | 采纳同款单点纯函数映射 |
| 大文件防护 | 文本 1MB 上限（可配），超限不读、只提供系统应用打开；阈值打开时快照 | 采纳：1MB 上限 + 超限走 `plugin-opener` 系统打开（本仓已有该插件） |
| 图片预览 | data URL 渲染 | 本仓用 Tauri asset protocol（`convertFileSrc`），零拷贝 |
| Office/PDF | 外部 officecli 子进程渲染 / Electron webview | **本期不做**：Office 依赖子进程服务超出本仓轻量目标；PDF 后续期可评估 EmbedPDF。超纲格式统一「系统应用打开」 |
| 消息跳转 | MessageAnchorRail 锚点导航条 + CustomEvent 跳转 + 高亮 2.4s | 采纳 CustomEvent 模式（本仓已有 `ainone:ref-file` 同款解耦先例）+ scrollToIndex 复用 |
| 队列 | @dnd-kit/core+sortable 队列面板（restrictToVerticalAxis），turnCompleted 自动 drain，条目编辑/立即发送/删除 | 采纳 dnd-kit 选型 + 「立即发送」条目操作；drain 时机本仓已有且更细（stopReason 区分） |
| 动画库 | 无 framer-motion，全 CSS transition | 采纳：合并吸入动画用 CSS transition + DragOverlay，不引动画库 |

### 2.2 社区依赖选型

| 候选 | 采纳 | 理由 |
|---|---|---|
| **@dnd-kit/core + @dnd-kit/sortable + @dnd-kit/utilities** | ✅ 引入 | React dnd 社区标准；sortable 自带挤位过渡（transform/transition，即手机桌面效果）；collision detection 内建；AIONUI 同款。**同时删除 CommandQueuePanel 的原生 HTML5 拖拽手搓实现**——应用内列表拖拽统一走 dnd-kit，不留两套标准（flexlayout 的窗口级拖拽属其库内部实现，不在此列） |
| **shiki**（`shiki` bundle 或 core+按需） | ✅ 显式引入 | 已是 streamdown 传递依赖（3.23.0），但 pnpm 严格隔离下不可直接 import，须显式 `pnpm add`。按需动态 import 语言（`createHighlighterCore` + js 引擎）控制体积；主题 github-light/dark 与现有 Streamdown 配置一致 |
| framer-motion / motion | ❌ | 合并动画 CSS transition 足够；AIONUI 也不用 |
| react-file-preview / react-doc-viewer 等 | ❌ | 前者偏重（含 3D/CAD），后者已停止维护；本仓格式面窄（文本/代码/md/图片），复用已有 shiki/Streamdown/react-photo-view 更省 |
| EmbedPDF | ❌ 本期不引 | PDF 本期不支持；待真实需求再评估 |
| Tauri asset protocol（`convertFileSrc`） | ✅ 启用 | 图片预览零 Rust 新代码；需 tauri.conf.json 开 `assetProtocol.enable` + scope 限 cwd |

## 3. 架构决策

### DEC-48 · 文件预览 = 窗格内右侧浮层（F-16-1）

- **触发**：FileTree 文件行**单击行本体**打开预览；hover「引用」按钮维持原引用行为（两者天然分区，互不干扰）。目录行行为不变（展开/收起）。
- **形态**：ChatPanel 窗格内 overlay（`position:absolute; right:0; top:0; bottom:0; width:min(50%,720px)`，与 `.composer-dock` 同款 absolute 模式），毛玻璃背景，顶部文件名 + 类型徽标 + 关闭钮（Esc 可关）。非模态：左侧消息区仍可滚动。
- **状态归属**：`previewStore`（zustand，Record<tabKey, PreviewState>），`PreviewState = { path, title } | null`。多窗格独立。**不做多 tab**——再点其他文件直接替换当前预览（轻量优先，AIONUI 的多 tab 是重需求场景）。
- **渲染器映射**（纯函数 `resolvePreviewKind(path): "markdown"|"code"|"image"|"text"|"binary"`，测试覆盖）：
  - `.md/.markdown` → Streamdown（`mode="static"`，复用 MarkdownView 的样式基座）
  - 图片（png/jpg/jpeg/gif/webp/svg/bmp/ico）→ `<img src={convertFileSrc(path)}>`
  - 代码/文本（按扩展名映射 shiki 语言，未知扩展名按文本兜底；大小写不敏感）→ shiki 高亮 `<pre>`，双主题
  - 二进制/超纲（pdf/docx/xlsx/zip/…）→ 不读内容：占位提示 + 「用系统应用打开」按钮（`open` from `@tauri-apps/plugin-opener`）
- **读取链路**：文本类走 `fd_read`（已有，UTF-8）；**1MB 上限**：`workspace_list_dir` 不返回 size，新增轻量 Rust 命令 `fs_file_meta(path) -> {size, is_dir}`？——**否**，最小方案：读取超限由 Rust 端 `fd_read` 保持原样，前端新增 `fd_read_limited(path, maxBytes)`？——**裁决：不改 Rust**。1MB 判定放读取后（`content.length`，UTF-8 下近似字节数）；超限仍只发生在已读入内存后，Tauri IPC 单次 1MB~几十 MB 传输无压力，牺牲「超限不读」的优雅换零 Rust 改动；1MB~10MB 正常展示，>10MB 提示过大改用系统打开。图片走 asset protocol 不经 IPC，无上限问题（scope 限 cwd + $HOME 子路径防越权）。
- **落位**：`src/sidebar/FilePreview.tsx`（组件）+ `src/sidebar/previewKind.ts`（纯函数）+ `src/store/previewStore.ts`；样式进 `sidebar.css`。FileTree 加 `onOpenFile` prop，RightRail 用 CustomEvent `ainone:open-file` 转发给 ChatPanel（同 `ref-file` 模式，ChatPanel 监听处带 M5 active 守卫），ChatPanel 渲染 `<FilePreview>`。
- shiki highlighter 单例（`createHighlighterCore` + 常用语言动态 import：ts/js/tsx/py/rust/go/json/yaml/css/html/bash/md 等 ~15 种），全 app 共享一个实例。

### DEC-49 · 「历史」tab = 用户消息锚点树（F-16-2）

- **RightRail 三 tab**：`meta | files | history`（RailTab 扩展；折叠栏杆同步加第三钮）。持久化 key 不变（tab 值域扩一个）。
- **数据**：纯函数 `extractUserAnchors(messages): { index, text, preview }[]`（index = 在 messages 数组中的位置，供 scrollToIndex/回溯用；preview = 首行截断 ~48 字）。消息模型是线性的（ChatMsg 无 id/parent），**树语义 = 当前分支上用户消息的祖先链**：回溯即剪枝（rewind 截断日志后 anchors 自动变短），分叉走整段复制新会话（logCopy）天然形成「树的新枝」——UI 层以扁平锚点列表呈现当前枝，不做伪树形缩进（没有真实 parent 数据，硬造树是骗人的）。
- **条目 UI**：`#序号 + preview`，hover 高亮 + 两个小按钮：**跳转**（默认点击条目即跳）+ **回溯**（小圆钮）。点击条目 → CustomEvent `ainone:jump-message {index}` → ChatPanel `virtualizer.scrollToIndex(index, {align:"start"})`（复用双 rAF 校跳，抽 `jumpToIndex` 公共函数；搜索跳转已删（P15 DEC-42），双 rAF 逻辑随抽随迁）+ 目标行高亮 1.2s（复用 data-flash 机制）。
- **回溯**：小钮 → CustomEvent `ainone:rewind-request {index}` → ChatPanel `askRewind(index)`（复用现有确认 Dialog + busy 保护链路，不新造回溯逻辑）。busy 时按钮 disabled（active tab 的 busy 状态经 CustomEvent 无法反查——**裁决**：回溯请求发出后 ChatPanel 若 busy 则 toast 提示「运行中不可回溯」并忽略（doRewind 已有 busy 保护，直接依赖它））。
- **空态/短会话**：<2 条用户消息显示 hint「历史消息会在对话后出现在这里」。
- **落位**：`src/sidebar/HistoryPanel.tsx` + `src/sidebar/historyAnchors.ts`（纯函数）+ 样式进 sidebar.css；ChatPanel 新增两个 CustomEvent 监听（useEffect 内、active 守卫同款）。

### DEC-50 · 队列悬浮 Dock + dnd-kit（F-16-3）

- **UI 形态**：替换 CommandQueuePanel 在文档流中的位置——新组件 `QueueDock` 渲染为 **absolute 浮层**（`position:absolute; right:12px; bottom: calc(dock 高度 + 8px)`；dock 高度用 CSS 变量承载或直接 `bottom` 由 dock 之上定位：放进 `.composer-dock` 兄弟层、z-index 高于 dock）。两态：
  - **收起**：圆角徽标「队列 N」（N=条数，0 不渲染）；busy 且队列非空时徽标带呼吸动画（提示消费会自动发生）。
  - **展开**：卡片浮层（宽 ~300px，最大高 40vh 内滚），条目 = 拖拽手柄 + 文本预览（点击进入内联编辑，复用现有 edit）+ 「立即发」小钮 + 删除 ×。点击徽标开合；Esc 关闭；开合状态组件内 useState（不持久化）。
- **拖拽（dnd-kit sortable）**：
  - `DndContext` + `SortableContext(verticalListSortingStrategy)` + `restrictToVerticalAxisModifier`；条目 `useSortable`。
  - **挤位动画**：sortable 自带——拖动中其他条目以 transform transition 让位（手机桌面效果）。DragOverlay 渲染拖起条目的影子（原位条目降透明度）。
  - **合并**：拖动条目悬停到另一条目**上方 50% 中心区**（collision 判定用 pointerWithin + 自定义「over 即合并候选」）持续 **600ms** → 目标条目进入「合并候选」高亮态（脉冲边框）→ 松手执行合并：DragOverlay 播放**吸入动画**（transform 到目标中心 + scale(0.4) + opacity 0，CSS transition 320ms）后落账。**合并语义**：两文本按**原队列顺序**以空行拼接（`a + "\n\n" + b`），位置取两者较前者；纯函数 `mergeQueueItems(queue, dragId, overId)` 进 `lib/queue.ts`（可单测）。**普通重排**（悬停 <600ms 或落在条目间空隙）走原有 reorder 语义（拖到谁头上落到谁的位置）。悬停计时用 dnd-kit `onDragOver` + 时间戳 ref，600ms 触发即时高亮反馈。
  - 键盘可达性：dnd-kit 自带 KeyboardSensor（空格拾起、方向键移动、合并候选用 Enter 触发降级为直接重排——合并仅指针路径，键盘路径保 reorder）。
- **busy 发送语义变更（D4）**：submit 在 busy 时**不再 steering**，改为 `enqueueCommand(text)` 入队 + toast「已加入队列（第 N 位）」+ 自动展开 QueueDock 浮层 1.5s。steering 能力不删除：队列条目「立即发」小钮 = 打断当前 turn 并把该条作为 steering 立即发出（复用 pendingTextRef 先赋值再 stop 的 M2 链路）；输入框「停止」按钮照旧（cancel 后队列保留，M1 逻辑不变）。空闲时发送行为不变（直接 runPrompt）。
- **消费时机不变**：`turn_stop` 非 cancelled/user → dequeue → appendUser → runPrompt（ChatPanel.tsx:754-772 逐字保留）；容量 10 不变，满则 toast（不变）。
- **持久化语义不变**：会话内持久（切 tab 不丢）、跨重启不恢复（skipHydration，H4 注释理由依旧成立）。queueStore 新增 `merge(key, dragId, overId)` action（调 lib 纯函数）；`move`（↑↓按钮）随旧 UI 删除而移除。
- **落位**：`src/chat/components/QueueDock.tsx`（含 dnd-kit 接线）；`CommandQueuePanel.tsx` + 其测试**删除**（功能被整体替换，不做兼容并存）；样式进 chat.css（`.queue-dock*`），删除 `.queue-panel` 系。

### DEC-51 · 拖拽标准统一条款

应用内一切**列表/卡片级拖拽**统一 dnd-kit；flexlayout 仅负责窗口布局级拖拽（其内部实现不动）。今后新增拖拽需求先查本条款，禁止再手搓 HTML5 DnD 列表逻辑。

## 4. 实施阶段（worktree `feat/p16-rail-queue`，自定提交节奏）

| 阶段 | 内容 | 提交 |
|---|---|---|
| S1 | 本规格书落库（main） | docs |
| S2 | 依赖引入：`pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities shiki`；tauri.conf.json 开 assetProtocol | chore |
| S3 | F-16-1：previewKind 纯函数 + FilePreview 组件 + FileTree 单击预览 + CustomEvent 链 + shiki 单例 | feat |
| S4 | F-16-2：historyAnchors 纯函数 + HistoryPanel + RightRail 三 tab + jump/rewind 事件接线 | feat |
| S5 | F-16-3：queue merge 纯函数 + QueueDock（dnd-kit + 挤位/合并动画）+ busy 入队语义 + 删 CommandQueuePanel | feat |
| S6 | 全量回归（vitest/cargo/e2e/build）+ 验收记录 + 合回 main | chore/docs |

每阶段提交前：`pnpm test` 全绿 + `pnpm build` 通过；涉及 Rust 的 S2 另跑 `cargo test`。

## 5. 测试与日志要求

- **纯函数单测**（新增）：`previewKind.test.ts`（扩展名→类型映射/大小写/未知兜底）、`historyAnchors.test.ts`（提取/截断/回溯后重算）、`queue.test.ts` 增 `mergeQueueItems`（拼接顺序/位置/边界：自身合并、相邻、跨位、空队列）。
- **组件测试**：`QueueDock.test.tsx`（渲染徽标/展开/编辑/删除/立即发调用/合并后 store 状态——dnd-kit 拖拽在 jsdom 无法真实模拟，合并逻辑以直接调 store.merge 断言，拖拽动画不做 jsdom 断言）；`FilePreview.test.tsx`（类型分流渲染/关闭/超纲占位）；`HistoryPanel.test.tsx`（锚点提取渲染/点击发事件/回溯钮发事件/空态）；`RightRail.test.tsx` 新增三 tab 断言。
- **既有测试不放宽**：queue.test.ts 既有断言全保留；ChatPanel.test / p12.test 全绿。
- **日志**：沿用 `logger` 分域——`preview`（open/close/fallback-open-system）、`history`（jump/rewind-request）、`queue`（merge/enqueue-via-busy/immediate-send）。关键分支可从日志重建时序。

## 6. 验收标准（AC-P16）

| 编号 | 验收 | 门禁 |
|---|---|---|
| AC-P16-1 | 文件树单击文件 → 窗格右侧浮层预览：代码文件 shiki 双主题高亮、md 渲染、图片显示、二进制给系统打开按钮；Esc/× 关闭 | GUI 手测 + FilePreview.test |
| AC-P16-2 | 预览浮层不影响消息滚动与输入；多窗格各自独立（A 窗格开着预览，B 窗格无）；非 active 窗格不响应 open-file 事件 | GUI 手测（分屏） |
| AC-P16-3 | >10MB 文本提示过大并提供系统打开；目录行点击仍为展开，不触发预览 | previewKind/文件测试 + 手测 |
| AC-P16-4 | RightRail 三 tab；历史 tab 列出全部用户消息（首行摘要）；点击条目消息区滚动定位 + 高亮；长会话定位不漂移（双 rAF 校跳） | HistoryPanel.test + GUI 手测 |
| AC-P16-5 | 历史条目回溯小钮 → 确认 Dialog → 截断生效、日志截断、历史列表同步变短 | 复用 doRewind 链路 + 手测 |
| AC-P16-6 | 队列为空右下角无浮层；入队后徽标「队列 N」；展开后可编辑/删除/立即发 | QueueDock.test + 手测 |
| AC-P16-7 | 拖拽：按住条目上移 → 其余条目实时挤位过渡（无跳变）；松手落位正确（reorder 语义不变） | GUI 手测 + queue.test |
| AC-P16-8 | 拖 A 悬停 B 600ms → B 脉冲高亮；松手 → A 吸入 B 动画（scale+fade）→ 变一条（文本按原顺序空行拼接，位置取较前者）；Ctrl+Z 无（无撤销要求，误合并可编辑文本弥补） | GUI 手测 + mergeQueueItems 单测 |
| AC-P16-9 | busy 时输入回车 → 入队不打断（当前 turn 正常完成，结束后自动消费下一条）；「立即发」→ 打断当前 turn 并立即发出该条；停止按钮 → 队列保留不消费 | ChatPanel 链路手测 + 日志断言 |
| AC-P16-10 | CommandQueuePanel 与 .queue-panel 样式、`move` action 全部移除；全仓无第二套手搓列表拖拽（grep `dataTransfer` 仅 flexlayout/文件外部拖入相关残留） | grep 断言 |
| AC-P16-11 | 行为零回归：vitest 全绿（含新增）/ cargo 20 绿 / e2e 全过 / build 通过 | CI 门禁 |
| AC-P16-12 | 依赖仅增 @dnd-kit/* 三件 + shiki；queueStore 持久化语义（skipHydration）注释仍在 | package.json diff + 代码断言 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| busy 入队语义变更影响依赖 steering 的既有流程（快问/引用/批注发送路径 busy 时也走 submit） | sendSuggestion/sendQuotes/sendDiffComments 三处 busy 分支**同步改入队**（同一条路径才不会两套行为）；测试覆盖 busy 发送入队 |
| dnd-kit 与 jsdom 测试兼容性 | 拖拽手势不做 jsdom 断言；合并/重排以 store action 直接断言；键盘传感器逻辑纯 dnd-kit 不测 |
| shiki 体积/首载 | core + js 引擎 + 常用语言动态 import；预览浮层 lazy（React.lazy 或条件渲染即满足）；单例 highlighter |
| asset protocol 安全面 | scope 限 `**`（cwd 与 $HOME 由用户会话路径决定）——收窄为启用协议 + `assetProtocol.scope: ["**"]` 但仅预览场景使用 convertFileSrc，不在任意 UI 渲染外部传入路径 |
| 队列浮层与 composer-dock 层级冲突 | QueueDock z-index 高于 dock（z 阶梯 chat.css:119-121 既有约定，追加一档并注释） |
| 合并动画与 DragOverlay 收尾竞态 | 合并落账延迟到动画结束（320ms）后执行 store.merge；期间禁再次拖拽（isDragging 守卫） |
