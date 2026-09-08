# P32 规格需求书：流式渲染体验——思考展开节奏 + 工具折叠纪律 + 滚动跟随

> 状态：**已确认**（用户 2026-09-08 拍板：思考完成收进活动组卡；历史消息 diff 与流式行为一致默认展开；要「回到底部」悬浮按钮）。
> 执行分支：`zhubaoduo/feat/p32_stream_ux`（worktree `.claude/worktrees/acp-stability-p1`，基于 `zhubaoduo/feat/p30_tool_visibility` @ 04eba6a，即已合入 main 的 P30 代码）。
> 背景：P30「写操作默认展开」实机体验与设计意图背离——画面反复开合抖动、滚动不跟随、流式过程噪声大。用户原话要点：
> ①思考出字时应默认展开，思考阶段完成后折叠；②工具调用默认全部折叠，只有 edit/write 产生 diff 的才默认展开，且不要一会儿展开一会儿收起；③流式输出应始终跟随在视口最下方。

## 0. 现象与根因（探索结论）

### 现象 A：写操作块「一会儿展开一会儿收起」

三层原因叠加：

1. **组重收 churn（主因）**：`buildStreamingItems`（`src/chat/logic/activity.ts:64-77`）从尾部向前找「最后一个不可组块」为界。尾部一旦出现新的 pending tool，`boundary === blocks.length`，界前全量跑 `buildActivityGroups`——上一帧还独立展开的工具块瞬间被收进默认折叠的组卡（`MessageLine.tsx:174` `useState(false)`）；工具 settled 后 boundary 回退，块又变独立。视觉即「开了又收、收了又开」。
2. **React 卸载重挂，state 全丢**：渲染项在 block↔activity_group 间迁移时 JSX 树结构变化 + `key={i}` 位置键（`MessageLine.tsx:108,116`），ToolBlock 卸载重挂 → `useState(hasDiff)` 重初始化、`userToggledRef` 归零，P30 AC-3.2「用户手动收起后不强开」的保证只在单次挂载内有效。组卡 `{open && ...}` 条件渲染（`MessageLine.tsx:215`）在组收起时同样卸载内部块。
3. **turn 结束切分组函数**：`MessageLine.tsx:100` busy=false 时全量 `buildActivityGroups`，流式期间展开的 diff 块在 turn 结束瞬间被收进折叠卡——P30 只保护了「流式中」（`buildStreamingItems` 注释自认）。

放大因素：thought 块的 `live` 判定只在最后一个渲染项为 true（`MessageLine.tsx:110`），流式 thought 后跟 tool 时 live 变 false → `ThoughtView` 自动折叠（`BlockView.tsx:34-37`），也是「闪收」观感来源。

### 现象 B：滚动条不跟随流式输出

**根因：ChatPanel 根本没有「跟随到底部」的滚动逻辑，不是时机竞态。** 全仓唯一的滚动监听（`ChatPanel.tsx:1132-1153`）只算 `atBottom`（阈值 64px）用于回跳气泡显隐。流式 chunk 撑高 `virtualizer.getTotalSize()`（`:1250`），但 scrollTop 从不被赋值，新内容全部长在视口下方。

次要放大因素：流式期间每条 ACP update 同步提交 store（main 上 P31 已加 rAF 节流 `streamCommitThrottle`，本 worktree 基线还没有——见 0.2 的整合说明）；高度在 `measureElement` 实测前后跳变，跟随逻辑必须处理「diff 块展开导致高度突增」的时序。

### 现象 C：流式过程噪声大

- 工具块（Read/Bash/Grep 等无 diff 的）流式期间全部独立渲染展开头部行，一屏全是工具行；turn 结束才收组，前后视觉突变。
- 思考块流式展开后，一旦接了 tool 就闪收（live 判定问题，见现象 A 放大因素）。

## 0.1 前置事实（已探明）

- 协议与块模型：`BlockMsg = {kind:"text"|"thought"|"tool", …}`（`message-log.ts:17-35`）；tool 块已有 `toolKind/rawInput/status/content/startTs/ms`（P30 产物）。
- 分组纯函数：`activity.ts` 的 `buildActivityGroups` / `buildStreamingItems`，零 React 依赖可单测。**`buildStreamingItems` 当前零测试**。
- 折叠状态全在组件本地 state，无持久化（`ThoughtView` `BlockView.tsx:32`、`ToolBlock` `:132`、`ActivityGroupCard` `MessageLine.tsx:174`）。
- 虚拟列表：`@tanstack/react-virtual` v3，`estimateSize: 120`，`measureElement` 动态测量（`ChatPanel.tsx:1120-1125,1261`），overscan 8。
- 图标入口纪律：lucide 语义映射只在 `src/components/ui/icons.ts`（AC-P7-9-1）。
- 本仓 React 生态已用 Streamdown、tanstack-virtual；引入 stick-to-bottom 类库需评估与 virtualizer 的兼容性（见任务三方案讨论）。

### 0.2 与 main 并行工作的整合说明

本规格探索期间，main 已合入 P31 系列（`13b5a94` 流式提交 rAF 节流 `streamCommitThrottle`、`bf26027` Streamdown props 引用稳定 + live 块高亮降级）。本 worktree 基线（04eba6a）不含这些改动。**执行时先 rebase/merge main 再动手**，规格中的行号以合并后代码为准；任务三的跟随逻辑与 `streamCommitThrottle` 天然互补（节流降低渲染频率 → ResizeObserver 触发次数同步下降），无冲突。

## 0.3 参照实现（DeepChat / AionUi / opcode / 社区）

| 关注点 | DeepChat（Vue） | AionUi（React） | 对本仓的启示 |
|---|---|---|---|
| 思考块 | 流式默认展开，完成后**不自动折叠**（`MessageBlockThink.vue` collapse=ref(false)），头部文案/计时切换 | 流式默认展开，**done 时自动折叠**（`MessageThinking.tsx:41,50-54` `useState(!isDone)` + effect） | 用户要求 = AionUi 模式：live 展开、sealed 折叠。我们已有同型实现（`ThoughtView`），问题只在 live 判定时机 |
| 工具块 | 默认折叠 pill；仅 process/长任务 loading 时自动展开，完成后 'auto' 来源回收，'manual' 永不回收（`expansionSource`/`autoExpandDismissed` 三态） | 单条默认折叠；diff 面板 `defaultExpanded={true}`；工具组卡「运行中自动撑开、结束后不强制收」 | **来源三分（auto/manual/dismissed）** 是防抖核心：系统只做单向一次性动作，绝不覆盖 manual |
| 流式归组 | 流式行不归组，历史行归组（`MessageItemAssistant.vue:480-485`） | 流式中运行工具撑开组卡 | 流式/结束两套渲染策略是共性做法，但**边界要稳定**：我们现状是「以尾部不可组块为界」导致边界抖动 |
| 自动滚动 | 自实现五态状态机（restoring/following/reading/navigating/history-preserving），wheel/touch/pointer/keyboard 手势 + 80px 阈值 + 程序滚动守卫 + 测量变化时贴底补滚 | 自实现：ResizeObserver(content+scroller) + rAF + 双阈值（100px 按钮显隐 / 4px 钉底判定）+ 150ms 程序滚动守卫 + `overflow-anchor:none` | 都不用第三方库；共同骨架 = **近底判定 + 用户手势接管 + 内容增高事件驱动 + 回底按钮**。本仓可平移（React 同栈 AionUi 最贴） |
| 流式性能 | 三层节流（主进程 120ms 快照/shallowRef 整替/静态前缀+流式尾部分段） | pending 队列 + rAF 合帧 + O(1) 索引原地合并 | 本仓已有 MessageLine memo + main 的 rAF 提交节流，够用，不追三段式 |
| opcode（同 Tauri 2 栈） | `MessageList.tsx:37-58`：极简版——距底 <50px 即跟随，上翻即停，翻回底部即恢复 | | 阈值判定 + 翻回自动恢复的最小可行形态 |

社区库评估：`use-stick-to-bottom`（stackblitz-labs，零依赖，v1.1.6，周下载 366 万）主打 AI chat 贴底 + 速度弹簧平滑滚动。**但它是自管滚动容器（StickToBottom 组件包裹 Content），与本仓 tanstack-virtual 的 `getScrollElement` 模式不兼容**（virtualizer 需要持有 scroll element 引用与测量回调）。结论：跟随逻辑自实现（参照 AionUi 骨架），规模小、可测性好，与虚拟列表天然兼容；符合「成熟社区方案优先」但以不与既有架构打架为前提。

## 0.4 范围外（明确不做）

- 不改 claude-agent-acp 桥；不做 subagent 进度透传。
- 不做 Pin-to-top 锚定策略（ChatGPT 式「用户消息钉顶」）——现有单滚动容器 + 虚拟列表下改动面大，登记 ideas。
- 不持久化折叠状态到 localStorage（折叠是会话内交互状态，恢复会话后按默认策略展开/折叠）。
- 不动 P24 权限/恢复链行为；不做 Markdown 分段渲染优化（P31 已覆盖主要性能点）。

---

## 任务一：思考块展开节奏——live 展开、sealed 折叠且落组

### 目标

思考出字时默认展开；该思考段结束（seal，拿到 ms）时自动折叠成「已思考 N 秒」一行并进入活动组卡，全程无闪收、无反复开合。

### 方案

- `BlockView.tsx` `ThoughtView`：
  - live 判定从「最后一个渲染项且无 ms」改为**块自身状态驱动**：`live = block.ms === undefined && 在流式 turn 中`。`MessageLine.tsx:110` 现在只在「最后一个渲染项」给 live——thought 后跟 tool 时 thought 被误判非 live 而闪收。改为把 `streaming`（busy && isLast）作为 prop 传入，ThoughtView 内部 `live = streaming && ms === undefined`。
  - 折叠效果保留：live true→false（即 ms 落定）时 `setOpen(false)`。该 effect 天然幂等，不会反复触发。
  - 用户流式中手动收起：尊重，之后即使仍在流式也不再自动展开（`userToggledRef`，复用 P30 ToolBlock 同型逻辑）。
- 思考块收进组卡：任务三重做分组边界后，sealed thought 属于 groupable 段，turn 结束或边界推进时自然收组（与用户确认「收进活动组卡」一致）。组卡内 ThoughtView 以 `live={false}` 渲染，折叠行「已思考 N 秒」。
- 关键不变量：**live 的判定与「块在渲染树中的位置」解耦**——只看数据（ms 是否落定 + 是否仍在流式 turn），不看「是不是最后一个渲染项」。这是消除闪收的根。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 1.1 | streaming turn 中、ms 未落的 thought 块 → 展开渲染正文 | vitest（组件级） |
| 1.2 | ms 落定（seal）→ 自动折叠为「已思考 N 秒」行 | vitest |
| 1.3 | thought 块后紧跟 tool 块（thought 已非最后一个渲染项）→ 只要 ms 未落仍保持展开（不闪收） | vitest（对照现状回归） |
| 1.4 | 流式中用户手动收起 → 同一思考段内不再自动展开 | vitest |
| 1.5 | sealed thought 进入组卡后以折叠行渲染（展开组卡可见） | vitest |
| 1.6 | 历史/静态消息（非流式 turn）thought 恒折叠行 | vitest |

## 任务二：工具块折叠纪律——diff 默认展开且永不回折，其余默认折叠

### 目标

工具调用默认全部折叠；edit/write（content 含 diff）默认展开且**一旦展开不再自动收起**；流式全程、turn 结束收组、历史回看三种场景行为一致。用户手动操作永远优先于自动行为。

### 方案

- **统一折叠策略为纯函数**（新文件 `src/chat/logic/disclosure.ts`，零 React 依赖）：
  - `defaultOpen(block: BlockMsg): boolean` —— tool 块 = `content.some(c => c.kind === "diff")`；thought 块 = `ms === undefined`（未 seal，即流式中）；text 恒 false。
  - `shouldAutoOpen(prev, next)`：无 diff → 有 diff 的边沿才返回 true。
  - 把 P30 散在 ToolBlock 里的边沿逻辑收进来，可单测。
- `BlockView.tsx` `ToolBlock`：
  - 保留 `open` state + `userToggledRef`，**删除「completed 边沿自动收起」的可能**（现状实现本来就没有收起逻辑，但要防任务三重组时被重挂重置——见下）。
  - `hasDiff` 边沿 effect 保留（tool_update 带 diff 到达时展开）。
- **消除重挂丢 state（本任务核心）**：
  - `MessageLine.tsx` 渲染项 `key` 从位置索引 `key={i}` 改为稳定键：block 项 = `toolCallId` / `text-${段序}` / `thought-${段序}`（thought/text 相邻合并块用段序即可，它们在同 turn 内结构稳定）；activity_group 项 = 首个成员块的稳定键前缀。保证分组结构变化时**已展开的 ToolBlock 实例不被卸载**。
  - 组卡内容体 `{open && ...}` 改为常挂载 + CSS 隐藏（或 `hidden` 属性），组收起不卸载内部块——ToolBlock 的展开 state 与 userToggledRef 得以跨「收组/展开组」存活。为控开销，组卡 body 常挂载仅保留布局占位（`display:none`），组内块本来就是轻量折叠行，成本可接受。
  - turn 结束切 `buildActivityGroups` 时，若组卡默认折叠会隐藏 diff 块——**含 diff 的组卡默认展开**：`ActivityGroupCard` 初始 `open = 组内任一 tool 块 hasDiff`（与块级策略一致），用户可手动收起，收起后不因流式重渲染被强开（open 的初始值只在挂载时计算，之后纯手动）。
- 流式不收组边界（`buildStreamingItems`）在任务三重写，本任务不动其行为，但验收要求组迁移全程 diff 块不回折。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 2.1 | 无 diff 的 tool 块（execute/read/search…）默认折叠，流式中始终折叠 | vitest |
| 2.2 | content 含 diff 的 tool 块首次渲染即展开 | vitest |
| 2.3 | tool_update 无 diff→有 diff 边沿 → 自动展开 | vitest |
| 2.4 | diff 块从「独立渲染」迁移进组卡（模拟新 pending tool 到达导致 boundary 移动）→ 展开态保持，不回折 | vitest（组件级，稳定键回归） |
| 2.5 | 用户手动收起 diff 块 → 后续任何流式更新/组迁移不重新展开 | vitest |
| 2.6 | turn 结束全量收组 → 含 diff 的组卡默认展开，组内 diff 块保持展开；无 diff 组卡默认折叠 | vitest |
| 2.7 | 历史回看（非流式）与流式行为一致：diff 块展开、其余折叠 | vitest |
| 2.8 | disclosure.ts 纯函数单测：defaultOpen 三类块 / 边沿判定 | vitest |

## 任务三：自动滚动跟随 + 回到底部

### 目标

流式输出始终跟随视口底部；用户上翻即接管（跟随暂停），翻回底部或点「回到底部」恢复；折叠/展开引起的高度突变不破坏跟随。

### 方案

- **自实现跟随（平移 AionUi 骨架）**，新 hook `src/chat/hooks/useFollowBottom.ts`（纯逻辑 + 注入 DOM 操作，可单测）：
  - 状态：`following: boolean`（是否处于跟随模式）。初始 true。
  - **近底判定**：`gap = scrollHeight - scrollTop - clientHeight <= NEAR_BOTTOM_PX (64，与现有 atBottom 同阈值)`。
  - **接管条件**（置 following=false）：wheel 事件（`deltaY !== 0` 方向向上时）或容器 pointerdown/mousedown——注意 WKWebView 原生点击无 pointerdown（记忆 P23），滚动容器用 `mousedown` + `touchstart` + `wheel` 三通道；scroll 事件本身不作为接管信号（程序滚动也触发 scroll，需守卫区分）。
  - **恢复条件**（置 following=true）：用户手动滚回近底（scroll 事件时 gap ≤ 阈值且非程序滚动窗口内）；或点击「回到底部」按钮；或发送新消息（submit 强制回底，DeepChat/AionUi 同语义）。
  - **跟随动作**：监听内容增高——ResizeObserver 观察 `.chat` 内的虚拟容器（`getTotalSize()` 变化即内容增高），rAF 合帧后若 following 则 `scrollTop = scrollHeight`。不用平滑滚动（流式连续增高时平滑滚动追赶不上，AionUi 用 `'auto'` 同理）。
  - **程序滚动守卫**：置位时间戳，程序滚动后 ~150ms 内的 scroll 事件不改变 following（防误判接管）。
  - 虚拟列表适配：跟随 scrollTop 赋值放在 `measureElement` 测量修正之后一帧（双 rAF），避免按 estimateSize 滚到半途被实测高度推翻；远端跳转既有 `jumpToIndex` 双 rAF 先例。
  - 容器 CSS 补 `overflow-anchor: none`，禁用浏览器 scroll anchoring 与自研跟随打架。
  - 「回到底部」按钮：`gap > 阈值` 时显示（复用现有 atBottom 计算），点击 `scrollToBottom` 并恢复 following。位置贴消息区底部居中（样式从 AionUi 简化）。
- `ChatPanel.tsx` 接线：hook 挂 `.chat` 容器；现有 `atBottom` 状态与 hook 的 gap 判定合一（一个来源，避免两套阈值）。
- **不引入 use-stick-to-bottom**：其自管容器模式与 tanstack-virtual 的 `getScrollElement` 不兼容（0.3 已论证），自实现规模 ~120 行纯逻辑 + 注入，可单测。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 3.1 | following=true 时内容增高（模拟流式 append）→ scrollTop 被推到底部 | vitest（注入 fake DOM/timing） |
| 3.2 | wheel 向上 → following=false，此后内容增高不再推底 | vitest |
| 3.3 | 用户滚回近底（gap ≤ 64px）→ following=true 恢复跟随 | vitest |
| 3.4 | 点「回到底部」→ 滚到底 + following=true；按钮显隐随 gap 翻转 | vitest |
| 3.5 | 程序滚动（跟随动作自身）后 150ms 内的 scroll 事件不触发接管 | vitest |
| 3.6 | submit 新消息 → 强制回底并恢复 following（即使此前被接管） | vitest |
| 3.7 | diff 块展开/收起导致高度突变时，following 下视口仍贴底 | vitest（ResizeObserver 触发路径） |
| 3.8 | hook 纯逻辑与 DOM 解耦：注入 scroller stub 即可全路径测试 | vitest（结构性验收） |

---

## 执行顺序与 commit 划分

| 步 | 内容 | commit 前置全绿 |
|---|---|---|
| S0 | merge main（并入 P31 节流系列），核对 `streamCommitThrottle` 与本规格接线点 | tsc + vitest |
| S1 | 任务一：ThoughtView live 判定解耦 + userToggled（tsc + vitest） | 全部 |
| S2 | 任务二：disclosure.ts + ToolBlock/组卡稳定键 + 常挂载组体 + 含 diff 组卡默认展开（tsc + vitest） | 全部 |
| S3 | 任务三：useFollowBottom + ChatPanel 接线 + 回底按钮 + overflow-anchor（tsc + vitest） | 全部 |
| S4 | `pnpm build` + 实机冒烟（claude-code 桥跑一个「思考+写文件+多个工具」turn：核对思考节奏/工具纪律/滚动跟随三处）+ 规格回填验收记录 | 全部 |

每步一个 commit（Conventional Commit，无 AI 署名尾行），不积累超级大 commit。

## 风险与开放问题

- **组卡 body 常挂载的内存开销**：长 turn 组内块多时 DOM 节点增多。缓解：折叠行本身轻量；若实测有压力，可只对「含 diff 的组」常挂载（任务二 S2 内决定，规格允许该裁剪）。
- **WKWebView 滚动手势**：`wheel` 在 WebKitGTK 上与触控板合成事件行为有差异，S4 实机必测触控板两指上滑接管。
- thought 相邻合并块在重组时的段序键稳定性：turn 内 thought/text 段只会追加不会重排，段序键稳定（turn.ts 追加语义保证）。
