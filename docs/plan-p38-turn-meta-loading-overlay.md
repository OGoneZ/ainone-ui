# P38 规格书：turn 总耗时/速率持久化 + 建链加载悬浮层 + fork 按钮常显

> 日期：2026-09-09
> 位置：①聊天气泡下方耗时/速率行（消息级持久化）；②窗格中央加载遮罩；③消息 hover 操作行 fork 钮
> 前置实测：2026-09-09 本会话（spawn/init/load 真机三测 + claude-agent-acp 桥源码 + omp 桥握手）

## 0. 需求与裁决

用户需求三条：

1. **总时长与速率持久化**：会话结束后冻结的总耗时、tok/s 速率徽标，在打开历史会话后依然可见（现状：runtime 不持久化 + 速率在模块级 Map，JSONL 只存 `{role, blocks}`——恢复后全部消失）。
2. **fork 按钮常显**：不做预握手预热。按钮一直显示，点击时若子进程未建则先建链（1~2 秒），期间给用户悬浮动画反馈。
3. **建链加载悬浮层**：首条消息（新会话/恢复会话）与 fork 点击共享同一反馈——**窗口中间悬浮 + 遮罩**，分屏不影响其他窗格。文案有趣一点。

**裁决 1 — 耗时/速率落消息级字段，不落 runtime。** `ChatMsg` assistant 分支扩两个字段 `turnMs?: number; rateTokPerS?: number`，随 JSONL 落盘。恢复即随消息回填，无需读 runtime。旧日志缺省 → 不显示（toolKind/rawInput 同款宽容校验先例）。

**裁决 2 — runtime turnEndedAt 渲染分支退役，统一消息级。** turn 收口时 `turnEndedAt` patch 在 `persistNew()` 之前（ChatPanel.tsx:1168 → :1245），把 turnMs/rateTokPerS 写进末条 assistant 消息即自然落盘。busy 走秒仍用 runtime `turnStartedAt`（实时性），结束后一律读消息字段——「结束后常驻」从「末条 + runtime 条件」改为「每条 assistant 自带」，历史轮与本轮统一。

**裁决 3 — fork 按钮常显，能力判定后移到点击时。** 现状 gate `forkEnabled = canFork(rt?.capabilities)`（ChatPanel.tsx:1372）在懒建链下永远是 null → 按钮消失。改为按钮恒显（有 onFork 回调即渲染）；`doFork()` 内 `await ensureSession()` 建链后按 `session.capabilities` 判定——不支持 fork 的 harness 走 toast.error 明确提示。历史会话必可 fork（claude-agent-acp 0.73 / omp 实测 initialize 即声明 `sessionCapabilities.fork: {}`），此提示是兜底。

**裁决 4 — 加载遮罩挂窗格内，非全局。** ChatPanel 根容器 `.panel` 已是 `position: relative`（app.css:369），遮罩 `position: absolute; inset: 0` 挂其下——与 FilePreview 浮层同模式（P16 DEC-48 先例），分屏时只覆盖本窗格，其他窗格零感知。拒绝全局 fixed：会遮住其他会话的输入区。

**裁决 5 — 触发条件统一 `starting` 状态，不新增状态机。** `ensureSession()` 开头 `setStarting(true)`、finally `setStarting(false)` 已覆盖全部建链路径（首条消息 / fork 点击 / 空闲回收重建 / 回溯重建）。现状 UI 只有底部 hint（:1651），升级为中央遮罩。遮罩阻断交互 = 天然防重复提交。

**裁决 6 — ensureSession 并发去重（顺手修的缺陷）。** 现状 starting 期间重复触发（双击 fork、提交+fork 交错）会各自 spawn 一个子进程（sessionRef 尚为 null，无兜底）。ensureSession 进行中复用同一 in-flight promise。

## 1. 实测数据（2026-09-09，本机，3 次取值）

| 阶段 | claude-agent-acp 0.73 | omp |
|---|---|---|
| spawn 桥进程 + initialize（fork 能力声明返回点） | ~170ms | ~507ms |
| session/new（桥内同步 `q.initializationResult()` 启动 claude CLI 子进程） | ~1.5s | ~385ms |
| session/load（11KB JSONL 历史回放） | ~1.4-1.9s | — |
| **已建链后 prompt → 首个 update 事件** | **~1ms** | — |

结论：用户感知的「发消息后没反应」= 首条消息触发的 `ensureSession()` 全链路（恢复会话 ~2s，新会话 ~1.7s）；建链完成后首事件几乎即时。悬浮层文案据此写「正在唤醒」而非「正在连接」——耗时主体是 harness 侧初始化/历史回放，不是网络。

## 0.1 已确认的裁决（用户拍板）

- **取消的 turn 落 turnMs**：显示真实耗时（含被用户 Esc 中断的轮次）。
- **遮罩阻断交互**：建链期间遮罩挡住输入区，不接受输入。
- **文案定稿**（两段，按场景）：恢复历史会话「正在唤醒这段对话的记忆」；新会话「正在唤醒 {adapter.name}」（见 R4）。
- **fork 不做预握手**：点击时建链，1~2 秒等待可接受。

## 2. 改造项

### R1 消息级 turn 元数据（`src/acp/message-log.ts`）

```typescript
export type ChatMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; blocks: BlockMsg[]; turnMs?: number; rateTokPerS?: number };
```

- `turnMs`：turn 起点→终点的墙钟毫秒（`turnEndedAt - turnStartedAt`），正常收口与用户取消（cancelled）都写；异常路径（进程死亡/出错）不写（无 turnEndedAt，与现状「异常不显示」语义一致）
- `rateTokPerS`：`rate.finalize()` 后的 `display()` 冻结值（tok/s，浮点）；纯 tool turn（无文本输出，finalize 保持 null）不写
- `isChatMsg` 校验：两字段可选 number，坏值（非 number）拒绝整条（与 ms/startTs 同策略）
- 旧日志：无字段 → 解析通过 → 渲染层不显示（不炸旧数据）

### R2 turn 收口写入（`src/chat/ChatPanel.tsx`）

- 收口点：`rate.finalize(...)`（:1171）之后、`persistNew()`（:1245）之前，新 store action `setLastAssistantTurnMeta(tabKey, { turnMs, rateTokPerS? })` 写末条 assistant 消息级字段
- `turnMs = Date.now() - turnStartedAt`（turnStartedAt 从 runtime 读，:1031 已落定）
- 取消路径同写（同一收口代码段，stopReason=cancelled 不分支）
- catch 异常路径不写（收口代码不经过）
- store 新 action 与 `updateLastAssistant` 同款切片写法（sessionStore.ts:231 模式）
- 队列续跑/steering：每轮 runPrompt 独立收口独立写入，多轮各自落各自 assistant 消息，无串扰

### R3 渲染：消息级冻结值 + runtime 走秒分工（`src/chat/message/MessageLine.tsx`）

- **busy && isLast**：现有 `TurnElapsed` 实时走秒 + 流中速率徽标，**不动**
- **!busy 且 `msg.turnMs` 存在**：消息下方显示冻结行 `🕐 用时 X（⚡ N tok/s 有 rateTokPerS 时）`——每条 assistant 消息独立判断，历史轮天然支持。复用现有 `TurnElapsedTurnEnded` 组件改造为接收 `msg`（或拆 `TurnElapsedFrozen({ turnMs, rateTokPerS })`）
- **runtime `turnEndedAt` 渲染分支（:192-193）删除**：末条收口时消息字段已写入（R2 时序早于下一次渲染提交），显示无缝衔接；ChatPanel 传参处的 turnEndedAt 透传（:1703）随之清理
- `runtime.turnEndedAt` 字段保留（收口 patch 仍有写入面，作为 turnStartedAt 配对的语义完整性；无消费点则注明）——或一并清理，实现时按最小 diff 取舍
- `rateRef` 徽标（流中）只在末条，消息级 rateTokPerS 冻结徽标每条独立——互不影响 memo

### R4 悬浮加载遮罩（`src/chat/components/BuildLoadingOverlay.tsx` + chat.css）

- 触发：`starting === true` 时渲染（ChatPanel 根 `.panel` 直下，:1631 FilePreview 同位）
- 结构：`position: absolute; inset: 0; z-index: var(--z-float)` 遮罩（`rgba` 半透明 + `backdrop-filter: blur(2px)`）+ 居中卡片（图标动画 + 主文案 + 副文案）
- **分屏隔离**：窗格内 absolute，其他窗格零感知（裁决 4）
- 动画：三点跳动（staggered bounce）或现有 `--ease-out-soft` 系动画自研；`prefers-reduced-motion: reduce` → 静态 spinner 文字（P35 pacer 同款尊重）
- 文案两段，按场景切换（**已定稿**，数据源 `resumeId = resumeSessionId ?? storeSessionId ?? undefined`，ChatPanel.tsx:550）：
  - **恢复历史会话**（resumeId 存在）：主文案「正在唤醒这段对话的记忆」，副文案「回放历史消息 · 约 1~2 秒」
  - **新会话**（resumeId 不存在）：主文案「正在唤醒 {adapter.name}」，副文案「启动 agent · 首次需要一点时间」
- 完成即卸载（starting=false），无退场动画要求（0.22s `perm-card-in` 同款淡入即可）
- 底部 hint（:1651「正在启动 …」）删除——被中央遮罩取代；`startError` 横幅保留（遮罩卸载后显示）

### R5 fork 按钮常显 + 点击时建链（`src/chat/ChatPanel.tsx`）

- 渲染 gate：`onFork={onFork ? doFork : undefined}`（摘掉 `forkEnabled &&`，:1708）——MessageLine 零改动（onFork 传即渲染）
- `doFork()` 流程改造：
  1. busy 中 → 现有 toast 提示（保留）
  2. `fromSessionId` 缺失（纯新会话未发消息）→ 现有 toast「会话尚未建立」（保留）
  3. `await ensureSession()`（未建链则建，恢复会话 ~2s；期间 starting 遮罩自动显示——R4 免费覆盖此场景）
  4. 建链后 `canFork(session.capabilities)` 判定：false → toast.error「{adapter.name} 不支持会话分叉」并 return
  5. 其余 fork 流程不变（session.fork → logCopy → onFork/onForkNavigate）
- 删除渲染期 `forkEnabled` 变量（能力 gate 单一化到点击时）

### R6 ensureSession 并发去重（`src/chat/ChatPanel.tsx`）

- `const ensurePromiseRef = useRef<Promise<AcpSession> | null>(null)`
- 进行中重复调用返回同一 promise；finally 清 ref
- 覆盖场景：双击 fork、遮罩期内键盘 Enter 提交（遮罩阻断为主，此为第二道保险）

## 3. 验收标准

| # | 标准 |
|---|---|
| AC-1 | turn 正常结束：末条 assistant 消息带 `turnMs`（±渲染帧误差），JSONL 对应行含该字段；重开该历史会话，此消息下方显示「用时 X」 |
| AC-2 | turn 正常结束且本轮有文本输出：消息带 `rateTokPerS`，历史会话重开后显示冻结 `⚡ N tok/s`；纯 tool turn 不带该字段不显示徽标 |
| AC-3 | 用户取消（Esc）的 turn：`turnMs` 落盘并显示（真实耗时）；进程死亡/出错 turn：不落不显示 |
| AC-4 | 多轮会话：每条 assistant 消息各自的 turnMs/rateTokPerS 独立正确，不串轮 |
| AC-5 | 恢复历史会话：fork 按钮立即可见（无需发消息）；点击后出现窗格中央遮罩动画，约 1-2s 后遮罩消失并完成分叉跳转 |
| AC-6 | 新会话发首条消息：立即出现中央遮罩（主文案含 adapter 名），恢复会话遮罩主文案为「正在唤醒这段对话的记忆」；建链完成后自动消失，随后正常流式输出；第二条消息起不再出现（已建链） |
| AC-7 | 分屏两窗格：A 窗格建链中遮罩只覆盖 A，B 窗格可正常交互（absolute 窗格内作用域） |
| AC-8 | 旧日志（无新字段）解析与渲染零回归；`isChatMsg` 拒收坏类型字段（字符串 turnMs → 整条按损坏行跳过） |
| AC-9 | starting 期间重复触发 fork/提交：只 spawn 一个子进程（in-flight promise 复用） |
| AC-10 | `prefers-reduced-motion` 下遮罩无跳动动画（静态呈现）；App 级渲染纪律不回退（遮罩为组件局部状态，不进 sessionSignals） |

## 4. 测试用例

| 文件 | 用例 |
|---|---|
| `message-log.test.ts` | serialize/parse 含 turnMs/rateTokPerS 往返；旧日志缺字段兼容；坏类型拒收 |
| `sessionStore.p38.test.ts`（或并入既有 store 测试） | setLastAssistantTurnMeta 写末条；无 assistant 时安全 no-op |
| `ChatPanel.p38.test.tsx` | 收口写消息级字段（mock now）；取消路径写、异常路径不写；多轮独立 |
| `MessageLine.p38.test.tsx` | 有 turnMs 消息显示冻结行 + 徽标；无字段不显示；busy 末条仍走实时分支 |
| `ChatPanel.p38.overlay.test.tsx` | starting=true 渲染遮罩（恢复/新会话两段文案场景区分）；false 卸载；startError 时 hint 逻辑不回归 |
| `ChatPanel.p38.fork.test.tsx` | 无 capabilities 恢复会话按钮可见；点击触发 ensureSession→fork 链；不支持 fork 的 harness toast |
| 既有防回归 | P30/P31/P32/P34/P35/P37 全部测试通过（turnEndedAt 分支删除处 P37 测试同步修订） |

## 5. 不做

- fork 预握手/预热（用户明确裁决：不做，点击时建链 1~2s 可接受）
- 历史轮逐条耗时回填旧数据（旧日志本来没有，无从回填）
- 全局 fixed 遮罩（分屏会误伤其他窗格，裁决 4）
- 思考/工具级耗时持久化（块级 ms/startTs 已持久化，无需重复）
- 遮罩进度条（无法测量真实进度，假进度有害无益；副文案给时长预期即可）

## 6. 实现顺序建议

R1 → R2 → R3（数据链，可独立验证）→ R4 → R5 → R6（UI 链）。R1-R3 一组提交，R4-R6 一组。
