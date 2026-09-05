# ainone-ui · P15 界面体感精修 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-05
**状态**：已批准基线（用户 2026-09-05 口述需求 + 探索结论）
**上游关系**：承接 P10（flexlayout 分屏）/ P11（渲染）/ P12（编辑与灵动）/ P13（架构分层）；全部为既有能力的体验修正，无新主题期
**选型金标准**：优先成熟稳定社区方案，不重复造轮子

---

## 0. 需求总览（7 项）

| # | 需求 | 优先级 | 用户原话锚点 |
| --- | --- | --- | --- |
| F-15-1 | 输入区常驻悬浮（与消息流解耦，底部 dock） | P1 | 「输入框应该一直常驻在屏幕最下方，是悬浮出来的……滚动到上方看聊天记录时输入框就消失了」 |
| F-15-2 | 移除会话内搜索条（保留全局搜索） | P1 | 「session 最上面的搜索框，我不清楚它的作用是什么，搜索也没有效果」 |
| F-15-3 | 分屏拖拽编排（tab 可拖 + 侧栏会话拖入 + 分隔线实时渲染） | P1 | 「拖拽 session 到已有 session 页面自动实时渲染分屏排版……拖分隔线实时渲染，而不是松开鼠标才能分割」 |
| F-15-4 | 消息操作按钮精简（icon-only 小圆钮） | P1 | 「下载和复制的按钮太大了……分叉和复制像老年机……编辑和回溯不要超大按钮，悬浮消息时在下方出现小巧按钮」 |
| F-15-5 | 语音按钮图标化（lucide Mic） | P1 | 「不要再使用 emoji，也不要特别大的字，只放一个麦克风图标」 |
| F-15-6 | 元数据增强：git 分支 + 点击复制 | P2 | 「加当前分支；session ID、工作区、分支、base URL、模型点击复制，反馈已复制」 |
| F-15-7 | 左侧工作区栏可收缩 | P2 | 「左侧的工作区侧边栏也可以点击一个小图标收缩起来」 |

---

## 1. 调研结论（2026-09-05 源码/依赖实测）

| 需求 | 结论 | 依据 |
|---|---|---|
| F-15-1 | **纯 CSS 修复，零新依赖**。`.panel` 自身 `flex:1; min-height:0` 但父容器 `.flexlayout__tab`（flexlayout 内部 absolute 定位）无高度约束 → `.panel` 高度塌缩为内容高，composer 跟着消息滚走 | `flexlayout-react/style/light.css:468` `.flexlayout__tab{position:absolute;overflow:hidden}`；`src/app/app.css:271` `.panel{flex:1}`。补 `height:100%` 即修复高度链；悬浮 dock 用 absolute 定位 |
| F-15-2 | **删除式改造**。会话内搜索（F-9-2）依赖 `scrollToIndex`+双帧校跳，但虚拟列表在 absolute 定位变化后定位不稳，实测体验差；全局搜索（F-11-2，Ctrl+F）已覆盖该需求 | `useChatSearch.ts` / `SearchBar.tsx` / `ChatPanel.tsx:238-242,854-864`；`searchMessages` 若仅此一处消费则随迁删除 |
| F-15-3 | **flexlayout 原生能力，零新依赖**。① 分隔线实时渲染 = `<Layout realtimeResize>`（官方 prop）；② tab 拖拽 = 已开启 `tabEnableDrag`（拖到另一 tabset 边缘即分屏，拖拽过程 flexlayout 自绘 drop 预览矩形实时渲染）；③ 侧栏拖入 = `onExternalDrag` prop（官方外拖接入点）+ HTML5 draggable | `ILayoutProps.realtimeResize`（Layout.d.ts:48「resize tabs as splitters are dragged」）；`onExternalDrag`（Layout.d.ts:35）；探针确认 dist 内有 drop 预览矩形机制（`onRenderDragRect`/overlay） |
| F-15-4 | **修全局样式污染 + lucide 图标**。Streamdown 代码块自带的 copy/download 按钮（`p-1` icon-only）被本仓全局 `button{padding:0.6em 1em;border:1px solid}` 污染成超大盒子；消息操作改 icon-only 圆钮 | `src/index.css` 已有 `@source streamdown` 扫描（tailwind 类生效），仅全局原生 button 规则越界；lucide `Copy/GitFork/Pencil/Undo` 均在 |
| F-15-5 | **lucide `Mic`**（已在依赖内，零新增）。录音态：红色圆底 + 白 Mic + 秒数；转写态保留文字（此时无图标替代语义） | `icons.ts` 是全仓唯一图标入口，新增映射即可；VoiceInput 当前 `🎤 语音` / `🔴 {seconds}s` |
| F-15-6 | **Rust 侧新增 1 个命令** `git_current_branch`（`git rev-parse --abbrev-ref HEAD`，stderr 静默、非仓库返回 null）；前端 ipc 封装 + 点击复制（`navigator.clipboard`，沿用既有 toast 反馈） | 仓库无现成 git 命令（`grep git src/ipc` 为空）；复用 F-7-8 已有「已复制」toast 模式 |
| F-15-7 | **仿 RightRail 折叠模式**（P11 F-11-7 已有成熟先例：折叠为细栏杆 + localStorage 持久化），零新依赖 | `RightRail.tsx:70-91`（collapsed 态）+ `sidebar.css .rightrail-collapsed`； lucide `PanelLeftClose/PanelLeft` |

**架构决策**：

- **DEC-41**：输入区悬浮采用「底部 dock」形态——`.panel` 内 composer 及其上方条带（PlanBar/QuotePanel/AttachList/QueuePanel/DiffCommentsBar/AskCard/EditBanner/harness-badge）整体包进一个 `position:absolute; bottom:0; left:0; right:0` 的悬浮容器（毛玻璃 `@supports` 渐进增强），消息区 `.chat` 独占整高、底部加 `padding-bottom` 预留 dock 高度，消息从浮层下方穿过。前提修复：`.flexlayout__tab > .panel` 高度链（`.panel{height:100%}`）。权限审批 Dialog 与回溯确认 Dialog 保持全局模态不动。
- **DEC-42**：会话内搜索整体移除（SearchBar 组件、useChatSearch hook、Ctrl+Shift+F 绑定、search-bar 样式、相关测试）；`data-search-hit` 高亮随迁删除。全局搜索（Ctrl+F，GlobalSearchDialog）不动。理由：功能重叠 + 虚拟列表定位不稳 + 用户明确表示困惑。
- **DEC-43**：分屏拖拽编排三层：① `realtimeResize` 一行开启分隔线实时渲染；② tab 拖拽本就开启（`tabEnableDrag`），保留 flexlayout 自带 drop 预览；③ 侧栏会话行 HTML5 `draggable` + dragstart 暂存 session 载荷（模块级变量，非 dataTransfer——flexlayout 内部用 `text/plain --flexlayout--` 通道），`onExternalDrag` 返回 `{json, onDrop}` 完成接入；载荷组装与目标解析抽纯函数可单测。拖入语义：已有会话 → 新 tab（叠入放下位置）；放下在窗格边缘 → flexlayout 自动分屏。
- **DEC-44**：消息操作按钮统一 icon-only 小圆钮（28px 触达区，hover 出现，title 提示）：assistant = 分叉（GitFork）+ 复制（Copy）；user = 编辑（Pencil）+ 回溯（Undo2）移到**气泡下方** hover 出现（原在气泡侧边）。Streamdown 按钮污染修复：全局 button 规则加 `:not()` 排除 Streamdown data 属性按钮，恢复其 tailwind `p-1` 尺寸。
- **DEC-45**：语音按钮 = icon-only 圆钮（与发送/停止同规格 h-9 w-9），idle：bg-2 + Mic；recording：danger 底 + 白 Mic + 秒数徽标；transcribing：Loader 旋转 + 「转写中」。可访问性 aria-label 保留「语音输入/停止录音」。
- **DEC-46**：元数据复制字段 = session ID / 工作区 cwd / 当前分支 / baseUrl / 模型（5 项），点击复制值，成功 toast「已复制 {label}」；分支取自新命令 `git_current_branch(cwd)`，会话建立后与 listProviders 同时机拉取，store 增 `branch` 字段；失败/非仓库显示「—」不可复制。
- **DEC-47**：左侧栏收缩 = RightRail 同款交互：收成 28px 细栏杆（PanelLeft 图标 + 竖排「工作区」），点击展开；状态持久化 localStorage（`ainone-sidebar-open`）。新建会话等入口在折叠态仍可达（栏杆上的 + 按钮）。

---

## 2. 统一测试与日志要求

承接 TESTING.md 分层：纯函数 vitest（node）/ 组件 vitest+jsdom / e2e 探针。
铁律：凡「输入确定 → 输出确定」的逻辑必须抽纯函数并配单测。

日志：F-15-3 拖入 `logger.info("layout","external-drop",{sessionId})`；F-15-6 复制 `logger.debug("meta","copy",{label})`；F-15-6 分支拉取失败 `logger.debug("meta","branch-fail",{cwd})`。

---

## 3. 各 F 项规格与验收

### F-15-1 输入区常驻悬浮（M）

**功能**：
- 修复 `.panel` 在 flexlayout tab 内的高度塌缩：`.panel { height: 100% }`
- composer + 条带群包进 `.composer-dock`（absolute 底部悬浮，DEC-41）
- `.chat` 独占整高，`padding-bottom` 预留 dock 空间；消息滚动到底时最后一贴不被遮挡
- 滚动到任意位置，输入框始终可见可输入

**测试**：
- 组件：渲染含多条消息的 ChatPanel → `.composer-dock` 存在且在 `.chat` 之外（testing-library）
- 样式断言：`.panel` computed `height:100%`（css 断言或 jsdom style 检查）

**验收**：
- **AC-P15-1**：消息超过一屏，滚动到最顶部 → 输入框与全部条带仍悬浮在底部可见 → 通过
- **AC-P15-2**：在悬浮输入框打字发送 → 消息正常追加，滚动自动跟底 → 通过
- **AC-P15-3**：分屏两个窗格，各自输入区独立悬浮不串扰 → 通过

### F-15-2 移除会话内搜索（S）

**功能**：删除 SearchBar / useChatSearch / Ctrl+Shift+F 监听 / `.search-bar` 系样式 / `data-search-hit` 高亮 / 相关测试用例；`searchMessages` 纯函数若仅此消费一并删除（DEC-42）

**验收**：
- **AC-P15-4**：Ctrl+Shift+F 无会话内搜索条弹出；Ctrl+F 全局搜索正常 → 通过
- **AC-P15-5**：全仓 `grep searchMessages|useChatSearch|SearchBar` 无生产代码引用；vitest 全绿 → 通过

### F-15-3 分屏拖拽编排（M）

**功能**：
- `<Layout realtimeResize>`：分隔线拖动时窗格内容实时重排（非松手才生效）
- tab 拖拽（已开启）：拖 tab 到目标窗格边缘 → flexlayout 实时渲染 drop 预览 → 松手分屏
- 侧栏会话行可拖（DEC-43）：`draggable` + dragstart 暂存 `{sessionId, adapterId, title, cwd, workspaceId}`；拖入布局区 → `onExternalDrag` 生成新 tab json；drop → 新 tab 落点（叠入/边缘分屏由 flexlayout 判定）
- 纯函数：`resolveExternalDrop(payload) → {json: IJsonTabNode, tab: Tab}` + 载荷暂存模块 `externalDragPayload`

**测试**：
- 纯函数（vitest node）：载荷暂存 set/take（取后清空）/ json 组装字段完整性
- 组件：侧栏会话行有 `draggable` 属性；`onExternalDrag` 回调返回含 config 的 json

**验收**：
- **AC-P15-6**：拖动窗格分隔线 → 两窗格内容随拖动实时重排（无松手才刷新）→ 通过
- **AC-P15-7**：拖 tab A 到 tab B 窗格左/右/上/下边缘 → 实时显示半透明预览块 → 松手分屏 → 通过
- **AC-P15-8**：从侧栏拖会话进布局区 → 出现拖拽预览 → 放下 → 该会话在落点新开 tab（叠入窗格或边缘分屏）→ 通过
- **AC-P15-9**：拖 tab 叠回同一窗格 → 顺序可换，仍单窗格多 tab → 通过

### F-15-4 消息操作按钮精简（M）

**功能**：
- 修复 Streamdown copy/download 按钮被全局 button 样式污染（DEC-44）：全局规则排除 `[data-streamdown]` 内按钮
- assistant hover 操作行：分叉/复制改 icon-only 圆钮（aria-label + title 保留）
- user 消息：编辑/回溯移到气泡**下方** hover 出现的 icon-only 小钮行（原侧边文字钮删除）
- lucide：GitFork 入 icons.ts（Copy/EditIcon 已有）

**测试**：
- 既有测试 aria-label 不变（「复制回复」「从这里分叉」「编辑并重发」「回溯到这里」）→ 自动回归
- 组件：user 气泡下方存在编辑/回溯按钮（role+name 断言）

**验收**：
- **AC-P15-10**：代码块右上 copy/download 恢复为小图标钮（无大盒子边框）→ 通过
- **AC-P15-11**：assistant 消息 hover → 仅两枚小圆钮（分叉/复制），无文字大按钮 → 通过
- **AC-P15-12**：user 消息 hover → 气泡下方出现编辑/回溯小钮，点击行为不变（回填/确认框）→ 通过

### F-15-5 语音按钮图标化（S）

**功能**（DEC-45）：icons.ts 增 `MicIcon = Mic`；VoiceInput 改 icon-only 圆钮；状态三态：idle（bg-2+Mic）/ recording（danger 底+白 Mic+秒数徽标）/ transcribing（Loader 旋转+sr-only 文本）

**测试**：VoiceInput.test 既有 aria-label 断言保留；`🎤 语音` 文本断言改为图标断言

**验收**：
- **AC-P15-13**：输入区语音钮 = 麦克风图标（无 emoji 无「语音」大字）→ 通过
- **AC-P15-14**：录音中钮变红 + 秒数，aria-label「停止录音」；转写中显示加载态 → 通过

### F-15-6 元数据增强：分支 + 点击复制（M）

**功能**（DEC-46）：
- Rust：`git_current_branch(cwd)` 命令（`Command::new("git").args(["rev-parse","--abbrev-ref","HEAD"])`，current_dir(cwd)，输出 trim；失败/非仓库 → Err，前端映射 null）
- ipc：`gitCurrentBranch(cwd): Promise<string | null>`
- store：`RuntimeState.branch: string | null`；ensureSession 后与 providers 同时机拉取
- MetadataPanel：新增「分支」行；5 字段（session ID/工作区/分支/baseUrl/模型）点击复制 + toast「已复制」+ 值旁复制小图标（hover 提示可点）

**测试**：
- Rust：`cargo test`（命令存在性/错误路径）
- 组件：mock branch → 显示；点击 → clipboard.writeText 被调 + toast

**验收**：
- **AC-P15-15**：元数据面板出现「分支」行，显示当前会话 cwd 的 git 分支名 → 通过
- **AC-P15-16**：点击 session ID/工作区/分支/baseUrl/模型任意值 → 复制成功 toast「已复制」→ 通过
- **AC-P15-17**：非 git 目录 → 分支行显示「—」且不可复制 → 通过

### F-15-7 左侧栏可收缩（S）

**功能**（DEC-47）：sidebar 头部加收缩钮（PanelLeftClose）；折叠态渲染 28px 细栏杆（PanelLeft 展开 + Plus 新建）；localStorage `ainone-sidebar-open` 持久化；键盘可达（aria-label）

**测试**：组件：点收缩钮 → 栏杆态出现 → 点展开恢复；localStorage 写入断言

**验收**：
- **AC-P15-18**：点收缩钮 → 侧栏收为细栏杆，主区变宽；点栏杆 → 展开还原 → 通过
- **AC-P15-19**：刷新/重启 → 收缩状态保持 → 通过

---

## 4. 排期图谱

```text
P15.1 布局修正：F-15-1 输入区悬浮 → F-15-2 删会话内搜索（同域）
P15.2 拖拽编排：F-15-3 realtimeResize + onExternalDrag
P15.3 按钮精修：F-15-4 icon-only + Streamdown 污染修复 → F-15-5 语音图标化
P15.4 元数据/侧栏：F-15-6 分支+复制（跨 Rust）→ F-15-7 左侧栏收缩
```

## 5. 风险与备忘

- F-15-1 的 absolute dock 会改变 `.chat` 为唯一滚动宿主的布局前提——虚拟列表 measureElement 依赖滚动容器，改造后需回归长会话滚动与「回到底部」判定（atBottom 距底阈值 64px）
- F-15-3 侧栏拖入依赖 HTML5 dragstart 与 flexlayout 内部 DragDropManager 的兼容：flexlayout 以 `dataTransfer text/plain --flexlayout--` 识别内部拖拽，外部载荷走模块级变量规避通道冲突；dragover 必须 `preventDefault` 否则 drop 不触发
- F-15-6 `git rev-parse` 在大仓库耗时 <10ms，但仍按需拉取（会话建立后一次），不轮询
