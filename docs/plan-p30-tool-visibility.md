# P30 规格需求书：工具可见性——写操作默认展开 + 工具细化显示 + 静默感知

> 状态：**已确认**（用户 2026-09-07 拍板：P1+P2 全做，规格先行，worktree 分步提交）。
> 执行分支：`zhubaoduo/feat/p30_tool_visibility`（worktree `.claude/worktrees/acp-stability-p1`，基于 `zhubaoduo/fix/p24_acp_stability` @ 80cbc84）。
> 背景：用户实机反馈三个体感问题——①Claude Code 派 subagent（Task 工具）期间 GUI 数分钟无任何动静，像卡死，时间跳变；②Edit/Write 等写文件操作默认折叠在活动组里，改了什么完全不可见；③所有工具一律显示「Terminal」，分不清干了什么。

## 0. 背景与根因（探索结论）

### ① subagent 派出期间「卡住」

**结论：协议表达边界 + 客户端静默感知缺失，非本仓 bug。**

- 实证：会话 `411828aa` 日志 20:15:39→20:19:00 之间无任何事件；JSONL 里两个 `Task` 工具块 status=failed（桥的 Agent 调用因模型暂不可用失败）。
- 协议层：ACP v1 `SessionUpdate` 16 种变体无任何 subagent 进度类型；`claude-agent-acp` 桥对 Task 只发首尾两帧，中间过程不透传。
- 客户端可做：静默时长显式化（任务三简版）；治本需改桥（范围外，登记 ideas）。

### ② 写操作静默折叠

- `BlockView.tsx` `ToolBlock`：`useState(false)` 无差别折叠，diff 也藏在里面。
- `MessageLine.tsx` `ActivityGroupCard`：折叠态摘要只有「思考 N 次 · 工具 M 个 · 用时 X 秒」；`fileChanges` 聚合数据算了但只在展开后渲染——「改了哪些文件」在折叠态不可见。

### ③ 工具全显示「Terminal」

- `session-core.ts` `dispatchUpdate`/`toToolContent` 丢弃协议字段 `kind`（read/edit/delete/move/search/execute/think/fetch/switch_mode/other 十类）、`rawInput`、`locations`、`name`——没有 kind 没法配图标，没有 rawInput 没法显示关键参数。
- 桥的 title 本身粗（Bash→"Terminal"、Read→"Read File"、Agent→"Task"），协议 `rawInput` 里有 `command`/`file_path`/`pattern` 等细节未消费。
- AionUi 同问题的解法参照：`normalizeToolCall.ts` `buildParamSummary`——按 kind 从 rawInput 提关键参数做副标题。

## 0.1 前置事实（已探明）

- 协议类型：`ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other"`（SDK types.gen.d.ts）；`ToolCallStatus = pending | in_progress | completed | failed`。
- **既存不一致（任务一顺带修正）**：`message-log.ts:151` 与 `messages.css:41` 认终态 `error`，协议实际发 `failed`——今日日志实测 Task/Terminal 失败态为 `failed`，导致计时 ms 不封口、状态点睛不着色。修正以协议为准（`failed`），本地历史 `error` 值保持兼容（视为终态即可，不迁移数据）。
- `rawInput` 真实形状（桥透传，P0 报文与今日 JSONL 双源验证）：Bash→`{command}`；Read/Write/Edit→`{file_path}`（omp 桥是 `{path}`）；Glob/Grep→`{pattern, path?}`；Agent/Task→`{prompt, subagent_type?}`；WebFetch→`{url, prompt?}`。
- 旧 JSONL 日志无新字段 → 全部新字段可选，解析器向后兼容（`isBlock` 放宽）。
- 图标入口纪律：lucide 语义映射只在 `src/components/ui/icons.ts`（AC-P7-9-1）。
- `fileChanges.ts` 已有 `aggregateFileChanges`（diff 按路径去重 + 增删行数），活动组卡已在用——数据现成，只差折叠态渲染位置。
- 基线：vitest 380 全绿（60 文件）。

## 0.2 范围外（明确不做）

- 不改 `claude-agent-acp` 桥（subagent 进度透传属另一仓库，登记 ideas）。
- 不实现 ACP `terminal/*` 回调（`terminal: false` 保持；terminal 类 content 仍渲染占位）。
- 不做工具块树形嵌套（subagent 内部调用层级化展示——协议无数据支撑）。
- 不动 P24 分支已有行为（权限 60s 超时、滞留 update 丢弃等）。

---

## 任务一：协议字段透传（kind / rawInput / locations / name）

### 目标

工具调用从「一个 title 字符串」升级为结构化块：kind 决定图标与文案，rawInput 提炼关键参数副标题，failed 终态修正。

### 方案

- `session-core.ts`：
  - `Outgoing` 的 `tool_call`/`tool_update` 增 `kind?: string | null`、`rawInput?: unknown`（locations 本期无 UI 消费点，**不透传**，避免无消费者的死数据——需要时再加）。
  - `dispatchUpdate` 两个 case 透传上述字段。
- `message-log.ts` `BlockMsg` tool 分支增可选字段 `kind?: string`、`rawInput?: unknown`；`isBlock` 校验放宽（缺省/类型不符→undefined，不拒收整块——旧日志兼容）；`updateTool` 增参合并 kind/rawInput（update 未带时保留旧值）。
- `turn.ts` `applyEvent` tool_call 分支透传字段入块。
- 终态修正：`message-log.ts` `updateTool` 的 finished 判定 `completed || failed || error`（error 兼容本地历史）；`activity.ts` `isSettled` 同步；`messages.css` 补 `data-status="failed"` 与 error 同色规则。
- JSONL 兼容：新字段可选序列化，旧日志行照常解析。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 1.1 | `tool_call` 带 kind/rawInput → Outgoing 含同值字段；不带 → 字段缺省（非 null 垃圾） | vitest（session-core.test） |
| 1.2 | `tool_update` 携带 kind/rawInput → 已有块字段被更新；不携带 → 保留旧值 | vitest（turn.test / message-log.test） |
| 1.3 | 协议 `failed` → ms 封口生效（startTs 存在时）；`error`（历史值）同样封口 | vitest（message-log.test） |
| 1.4 | 旧日志（无新字段）解析不回归 | vitest（message-log.test 存量 + 新增旧行样例） |
| 1.5 | CSS `failed` 状态着色规则存在且与 error 同色 | 代码走查 + 既有样式约定 |

## 任务二：工具显示细化（图标 + 参数副标题）

### 目标

「Terminal」→「Terminal · git status」级别的可读性：kind 驱动图标，rawInput 提关键参数。

### 方案

- **新纯函数 `src/acp/toolDisplay.ts`**（零 React 依赖，可单测）：
  - `kindIcon(kind): LucideIcon`——read=FileText、edit=Pencil、delete=Trash2、move=FolderSymlink（备选 FolderInput，以 lucide-react@1.39 实有导出为准）、search=Search、execute=Terminal、think=Brain、fetch=Globe、switch_mode=Repeat、other/缺省=Wrench（沿用 ToolIcon）。
  - `kindLabel(kind)`：read→读取、edit→编辑、delete→删除、move→移动、search→搜索、execute→执行、think→思考、fetch→获取、switch_mode→切换模式、other→工具。
  - `toolSubtitle(kind, rawInput): string | null`——按 rawInput 形状提取（参照 AionUi buildParamSummary，但**不依赖 kind 准确性**，直接认字段名）：
    - `command`（execute 常见）→ 原样，超长截断（>80 字符加 …）
    - `file_path` / `path` → 文件名（末段），title 属性保留全路径
    - `pattern` → `"pattern"` + `in path/glob`（有则拼）
    - `url` → 原样截断
    - `prompt` → 截断（Agent/Task 类）
    - 都不命中 → null（不显示副标题）
  - 未知 rawInput 形状（数组/标量/null）一律安全返回 null。
- **icons.ts**：新增上述 lucide 语义映射导出（Trash2Icon、SearchIcon、GlobeIcon、RepeatIcon 等，命名从既有惯例）。
- **BlockView.tsx `ToolBlock`**：
  - 头部图标改用 `kindIcon(block.kind)`；
  - title 后追加副标题 `<span class="tool-subtitle">{toolSubtitle(...)}</span>`，CSS 截断省略；
  - status 文案中文化：pending→等待、in_progress→运行中、completed→完成、failed→失败、error→失败（历史值）；
  - 终态 failed/error 的头部显示失败态（CSS 已有着色）。
- **活动组卡**（MessageLine.tsx）：折叠态摘要行保持，但组内 blocks 有 diff 时追加「改动 N 个文件（+a −r）」徽标行（数据用现成 aggregateFileChanges，提升到组件顶层计算一次）。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 2.1 | kindIcon 十种 kind 全命中且缺省回 Wrench | vitest（toolDisplay.test） |
| 2.2 | toolSubtitle：command/file_path/pattern+path/url/prompt 五类形状各命中；缺 rawInput → null；超长截断 | vitest |
| 2.3 | ToolBlock 头部渲染 kind 图标 + 副标题 + 中文 status | vitest（组件测试，jsdom） |
| 2.4 | 活动组折叠态含「改动 N 个文件（+a −r）」当组内存在 diff | vitest |
| 2.5 | 图标全部经 icons.ts 入口（无组件直 import lucide） | 代码走查 |

## 任务三：写操作默认展开 + 静默感知

### 目标

- 有 diff 的工具块默认展开（写操作不再静默藏匿）。
- turn 静默超过阈值给出显式状态（缓解「像卡死」体感）。

### 方案

- **ToolBlock 默认展开**：初始 open 判定 `content.some(c => c.kind === "diff")`。注意 update 时序：tool_call（pending，常无 content）先到、tool_call_update（completed，带 diff）后到——**open 初始值不能一锤定音**，用 effect：块从「无 diff」变「有 diff」且用户未手动操作过（userToggledRef）且块刚进入终态时置 open=true。用户手动收起后不再自动展开。
  - 判定「刚进入终态」：running→非 running 的边沿，避免每次流式重渲染反复强开。
- **静默感知**：`useElapsedTicker` 复用——ChatPanel 已有 `turnStartedAt`，另存 store 字段 `lastEventAt`（每次 onOutgoing 事件刷新）。`TurnElapsed` 行扩展：当 `now - lastEventAt > SILENT_THRESHOLD_MS (30s)` 时追加「· 静默 {n} 秒（可能在运行长任务或子代理）」。纯展示，无交互。
  - store：`RuntimeState` 增 `lastEventAt?: number`；`runPrompt` 的 onOutgoing 里 patch（节流不必——事件频率低，patch 已是浅合并）。
  - turn 结束清 turnStartedAt 时一并清 lastEventAt。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 3.1 | content 含 diff 的工具块首次渲染即展开；无 diff 默认折叠 | vitest（组件测试） |
| 3.2 | tool_update 带 diff 到达（无 diff→有 diff 边沿）→ 自动展开；用户手动收起后不再被强开 | vitest |
| 3.3 | running→completed 边沿不重复触发展开（已有 diff 的块不折腾） | vitest |
| 3.4 | 事件间隔 >30s → TurnElapsed 显示静默提示；<30s → 不显示；turn 结束后整个行为消失 | vitest（hook 级/组件级） |
| 3.5 | lastEventAt 不落 localStorage（runtime 本就不持久化，partialize 只存 commands——走查确认） | 代码走查 |

---

## 执行顺序与 commit 划分

| 步 | 内容 | commit 前置全绿 |
|---|---|---|
| S1 | 任务一：协议字段透传 + failed 终态修正（tsc + vitest） | 全部 |
| S2 | 任务二：toolDisplay 纯函数 + icons + ToolBlock/活动组卡细化（tsc + vitest） | 全部 |
| S3 | 任务三：写操作默认展开 + 静默感知（tsc + vitest） | 全部 |
| S4 | `pnpm build` + 实机冒烟（claude-code 桥跑一个写文件 turn，肉眼核对三处）+ 规格回填验收记录 | 全部 |

每步一个 commit（Conventional Commit，无 AI 署名尾行），S2/S3 内部若膨胀再拆，不积累超级大 commit。
