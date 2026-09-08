# P32 规格需求书：渲染性能与资源占用优化——流式链路收口 + 多会话减负

> 状态：**已确认**（用户 2026-09-08 要求：先复核探索结论 → 对照 DeepChat/AionUi 与社区实践 → 规格化 → worktree 内分项提交 + 测试 + 验收）。
> 执行分支：`zhubaoduo/perf/p32_rendering_perf`（基于 main @ b9f0607）。
> 背景：P31 已把「流式 update → store」压到帧级，但复核发现仍有 **store 级高频写、App 级全量订阅、后台 Tab 常驻计时器、IPC 字节膨胀** 四类结构性开销。本规格逐项收口。

## 0. 复核结论（探索准确性验证，2026-09-08）

原探索提出 10 项，复核后 **8 项成立、1 项部分成立、1 项取消**：

| # | 原发现 | 复核结论 | 证据 |
|---|---|---|---|
| 1 | App 订阅整个 runtime，流式期间全量重渲染 | ✅ 成立 | App.tsx:1010 `useSessionStore((s) => s.runtime)`；updateLastAssistant/patch 每次换 runtime 引用 → App 全树 reconcile + statusBySession 重算 + activeMessages 新引用 → RightRail `collectModifiedPaths` / HistoryPanel `extractUserAnchors` 每次全量扫描 |
| 2 | lastEventAt 每事件 patch、传所有 MessageLine | ✅ 成立 | ChatPanel.tsx:998 每内容事件 `patch(lastEventAt)`（事件率而非帧率）；ChatPanel.tsx:1455 传给**所有**行 → MessageLine memo 击穿（MessageLine.tsx:137 仅 `busy && isLast` 消费） |
| 3 | useTypewriter 后台/非空输入仍 80ms interval | ✅ 成立 | useTypewriter.ts:17 无暂停条件；N 个 tab = N×12.5 渲染/s |
| 4 | 虚拟列表隐藏 tab rect=0 → 切回重挂载重测 | ✅ 成立（补充机制） | virtual-core 3.17.8 源码：calculateRange outerSize=0 → range=null → getVirtualItems 空（全部卸载）；ResizeObserver fire 时 `isIndexInRange` 只查 count 不查尺寸，**隐藏期 measure 不会写 0 进缓存**（条目已卸载无 observer），但切回时全量重挂载+重测+Streamdown 重解析成立 |
| 5 | 进程输出走 JSON number[]，膨胀 6~8 倍 | ✅ 成立 | agent.rs:107 `AgentEvent::Stdout(Vec<u8>)` + Tauri v2 Channel 走 JSON（官方 issue #13405 证实 Rust→FE 事件系统无 ArrayBuffer 通道）；terminal.rs:132 同款 |
| 6 | harness stderr 逐块 console.warn → IPC 风暴 | ✅ 成立 | session-core.ts:264 逐 chunk warn；logger.ts:38 installConsoleForward 每次 console.* 走 plugin-log IPC+落盘 |
| 7 | BlockView/MarkdownView 未 memo；块 key=index | ✅ 成立 | BlockView.tsx:263 / MarkdownView.tsx:34 均为普通函数组件；MessageLine.tsx:120/283 key={i} |
| 8 | mermaid 流式期仍激活 | ⚠️ 部分成立，**取消** | MarkdownView.tsx:23 流式插件组确含 mermaid，但 mermaid 渲染仅在围栏闭合后触发（streamdown 内部按块切分），未闭合围栏零开销；与 code 的高频重高亮不同质。不动 |
| 9 | quickAsk 每 delta setState | ✅ 成立（低优先） | ChatPanel.tsx:876-882 每 delta 一次 setState；悬浮窗小，收益有限 |
| 10 | useElapsedTicker 每秒强制重渲染 | ❌ 不构成问题 | interval 在 TurnElapsed/ThoughtView 等叶子组件内部，只重渲染自身，不打穿 memo。不改 |

## 0b. 参照实现（DeepChat / AionUi / 社区，2026-09-08 调研）

| 主题 | DeepChat（Vue3+Pinia） | AionUi（React+自研 Context） | 社区共识 | 本仓采纳 |
|---|---|---|---|---|
| 流式频率控制 | **主进程 120ms 节流**整包快照（echo.ts），renderer 零定时器 | setTimeout 微批（同 tick 合并一次 setState）+ thought 50ms 节流 | rAF 合帧 + 永不逐 token setState（Chrome/Streamdown 文档同款） | 已有 rAF 节流（P31），本仓 R1 把残余的逐事件 patch 也折进节流 |
| 订阅粒度 | shallowRef + 修订计数器，组件 watch 具体字段 | 消息列表整列表 Context（靠 MessageItem memo 拦截），运行时状态用 useSyncExternalStore 稳定快照 | zustand 官方：原子 selector / useShallow，禁订阅整对象 | R2：App 改细粒度标量订阅，O(n) 派生计算下沉到消费组件 |
| Markdown | markstream-vue 静态前缀+live 尾巴拆分，shiki 进 Worker | react-markdown 整段重解析（无增量），模块级稳定插件引用 | plugins/components 引用稳定是 memo 生效前提 | 已做（P31），R5 补 Block 层 memo |
| 虚拟化 | 自研窗口化（阈值 160 条才开） | 无虚拟滚动（声明 virtuoso 未用），50 条/页分页 | tanstack/react-virtual | 已有 react-virtual，R7 处理隐藏 tab 冻结 |
| 进程输出 IPC | JSON 结构（Electron 结构化克隆，无二进制压力） | WS JSON 帧，base64 图片 >64KB 直接剥离 | Tauri 官方证实事件通道无二进制支持；大 payload 需自编码 | R8：Rust 侧 base64 字符串过 channel，前端 atob 还原 |
| 打字机/动画 | — | — | rAF + visibility 感知，后台停 | R3 |

## 1. 改造项（R1–R8）

> 通用约束：每项独立 commit；纯逻辑进 `src/**/logic|hooks/` 可单测；行为不变性以现有测试回归兜底；不动 UI 语义。

### R1 — lastEventAt 折进流式节流 + 只传末条 ⭐ 性价比最高
- **内容**：
  1. `runPrompt` 内容事件分支删除逐事件 `patch(tabKey, { lastEventAt })`；lastEventAt 改在 `createStreamCommitThrottle` 的 commit 回调里与 `updateLastAssistant` 一并提交（同一帧一次 store 写）。
  2. `lastEventAt` prop 只传给 `isLast` 的 MessageLine（消费点 MessageLine.tsx:137 仅 `busy && isLast`）。
  3. `flush()` 收口时同样带 lastEventAt（终态静默计时基准不丢）；`turn_started` / finally 的 `patch` 保留（低频）。
- **目标**：流式期间 store 写频率 = 帧率（≤60/s）而非事件率；非末条 MessageLine 的 props 引用稳定，memo 在流式全程生效。
- **验收标准**：事件率 8/s 连发 396 条（P31 事故同款回放）时，store `lastEventAt` 写次数 ≤ 帧数；非末条 MessageLine 在流式期间零重渲染（React Profiler 可证）。
- **测试**：
  - `streamCommitThrottle` 扩展：commit 时携带 lastEventAt 时间戳（注入 now），帧内合并断言只取最后一次；
  - ChatPanel 集成：50 条突发 agent_text，断言非末条行的 props（lastEventAt）为 undefined 且终态 lastEventAt 有值。

### R2 — App 级订阅粒度拆分
- **内容**：
  1. `App.tsx` 删除 `useSessionStore((s) => s.runtime)` 整订阅，改为：
     - `statusBySession` 的输入改用 `useSessionStore(useShallow(细粒度))`——订阅 `busy/perm` 标量映射（`collectSignals` 只消费 busy/perm/messages.length，改签名后 messages 用 length）；
     - `activeMessages` 不再提升到 App：RightRail 内部自订阅 `useSessionStore((s) => s.runtime[tabKey]?.messages)`（tabKey 已是 prop），App 不传递。
  2. `collectSignals`（sessionStatus.ts）签名从 `messages: unknown[]` 改 `hasMessages: boolean` 侧信息——由调用方（或 store 选择器）给 length；`collectModifiedPaths`/`extractUserAnchors` 保留在 RightRail/HistoryPanel 内（由 messages 引用稳定性天然缓存：流式只动末条 turn 的 blocks 数组引用，messages 数组引用每帧都换 → 这两个 useMemo 在流式期仍每帧重算，故在 RightRail 侧对 messages 加「末条 blocks 引用不变则跳过」的浅判等，或直接容忍——见测试项确定）。
  3. 收益主体是 App/flexlayout/侧栏行不再参与流式重渲染。
- **目标**：流式期间 App 组件零重渲染（仅 ChatPanel 局部）；侧栏 M 徽标与历史锚点行为不变。
- **验收标准**：React Profiler 下，后台 tab 流式 60s，App/RightRail 渲染次数为 0（除 turn 起止两次）；`statusBySession` 只在 busy/perm 实际变化时重算。
- **测试**：sessionStatus 单测适配新签名；App 集成测试（现有 384 行）全绿；新增「流式期间 statusOf 稳定」断言。

### R3 — useTypewriter 暂停条件
- **内容**：`useTypewriter(full, opts?)` 增加暂停语义：`enabled=false` 时清 interval 冻结输出。ChatPanel 以 `active && input.length === 0` 作为 enabled 传入（非激活窗格 / 用户已输入时不打字）。
- **目标**：N 个非激活 tab 的打字机渲染归零；激活 tab 输入中不跑无意义循环。
- **验收标准**：jsdom 计时器测试——enabled=false 时不启 interval；enabled 翻转正确启停；placeholder 文案在重新激活后继续。
- **测试**：useTypewriter 单测扩展（fake timers）；ChatPanel 传参防回归。

### R4 — harness stderr 批量转发
- **内容**：`session-core.ts` stderr 读循环改为 500ms 批量合并（TextDecoder stream 模式累积 + flush 定时器 + done 时清尾），`console.warn` 降为 `console.debug`（plugin-log 里 debug 级，避免 warn 级噪音）；`stderrTail` 环形缓冲不变。
- **目标**：啰嗦 harness（debug 输出）的 IPC 调用从每 chunk 一次降到 ≤2/s；日志仍可诊断。
- **验收标准**：模拟 1000 个 stderr chunk 到达，console 调用次数 ≤ 500ms 窗口数 + 1；拼接文本内容与逐块顺序解码一致（多字节跨 chunk 不断裂）。
- **测试**：session-core 单测注入 fake stderr 流（ReadableStream），断言批次数与解码正确性。

### R5 — Block 层 memo + 稳定 key
- **内容**：
  1. `MarkdownView`、`BlockView` 用 `React.memo` 包裹（props：text/live/onSelect 等全部为稳定引用——onSelect 已 useCallback）。
  2. MessageLine 块渲染 key 从 `i` 改稳定键：tool 块 `tool:toolCallId`、thought/text 块 `t:<kind>:<首块序号>`（分组项 `group:<firstStartTs>:<i>`）。确保流式新增块不引起后续块 key 漂移。
- **目标**：diffComments/activityOverride 等变更或父级重渲染时，未变块零 reconcile；Streamdown 对已渲染块不再走 reconcile diff。
- **验收标准**：同 turn 插入新 tool 块时既有块 DOM 节点不重建（测试断言同 key）；memo 生效（相同 props 引用下渲染次数不变）。
- **测试**：MessageLine 渲染快照 + key 稳定性单测（构造 blocks 数组 push 新块，断言旧块 key 集合不变）。

### R6 — quickAsk delta 节流
- **内容**：`runQuickAsk` 复用 `createStreamCommitThrottle`：delta 累积到 ref，按帧提交 `setQuickPop`；完成/异常时 flush。
- **目标**：快问流式 setState 频率与帧率对齐。
- **验收标准**：N 条 delta 回放，setState 次数 ≤ 帧数，终态文本完整。
- **测试**：ChatPanel 集成或独立 hook 测试（注入 scheduleFrame）。

### R7 — 虚拟列表隐藏期冻结
- **内容**：`useVirtualizer` 传 `enabled: active`（tanstack v3 原生选项，源码已核实：enabled=false 时 scrollRect/scrollOffset 置 null、Range 计算短路、不挂 ResizeObserver）。切回 enabled=true 自动重挂 rect 观察，保持原 scrollOffset 语义需实测（scrollRect=null → 恢复时按 initialRect 重算，配合现有 measureElement 重测，无 0 值污染）。
- **目标**：隐藏 tab 不做虚拟计算、不卸载/挂载节点差异；切回时正确恢复渲染（现有 jumpToIndex 双 rAF 校跳不受影响）。
- **验收标准**：jsdom 下 enabled=false 时 getVirtualItems 为空但 messages 数据不丢；切回 enabled=true 后渲染恢复；现有 ChatPanel 测试全绿。
- **测试**：ChatPanel 集成测试（active 翻转 → 虚拟区状态断言）。

### R8 — 子进程输出 IPC 编码优化（agent + terminal 两条链路）
- **内容**：
  1. Rust：`AgentEvent::Stdout/Stderr` 与 `TerminalEvent::Data` 的 payload 从 `Vec<u8>` 改 `String`，发送侧 `STANDARD_NO_PAD`（或 STANDARD）base64 编码；
  2. TS：`bridge.ts` 的 `bytes()` 增加 base64 分支（`atob` → Uint8Array）；`pty.ts` 直接对 base64 解码成 bytes 后走 TextDecoder stream（保持多字节跨 chunk 不断裂语义）；
  3. 保持事件形状兼容：tag 名与现有前端 switch 分支一致（payload 类型从 number[] 变 string，前端对应分支同步改，无跨版本兼容负担——同仓同发布）。
  4. `pump_events`（agent.rs）不做小包 coalesce——harness stdout 本身是 NDJSON 行为单位，行级粒度已够，合并会引入延迟；终端链路 4KB chunk 保持。
- **目标**：同字节量下 JSON 序列化体积从 ~4 字节/字节 降到 ~1.33 字节/字节（base64），主线程 `Uint8Array.from(number[])` 的 O(n) 构造消失（`atob` + 循环写入或 `Uint8Array.fromBase64` 可用时直取）。
- **验收标准**：单测——Rust 侧编码函数往返正确（空串/多字节 UTF-8/4KB 边界）；TS 解码函数对多字节跨 chunk 不断裂（现有 pty.ts 语义不变）；e2e（webdriver 可选）冒烟终端可交互。
- **测试**：Rust `cargo test`（base64 编码单测）；TS 侧 `decodeBase64ToBytes` + 流式 decode 单测。

## 2. 实施顺序与提交切分

| 序 | 项 | commit 前缀 |
|---|---|---|
| 1 | R1 lastEventAt 节流 | `perf(chat): ...` |
| 2 | R2 App 订阅拆分 | `perf(app): ...` |
| 3 | R3 typewriter 暂停 | `perf(chat): ...` |
| 4 | R4 stderr 批量 | `perf(acp): ...` |
| 5 | R5 memo+key | `perf(chat): ...` |
| 6 | R6 quickAsk 节流 | `perf(chat): ...` |
| 7 | R7 虚拟列表 enabled | `perf(chat): ...` |
| 8 | R8 IPC base64 | `perf(ipc): ...` |

每项：实现 + 单测 + 该项测试通过即 commit，不攒大提交。

## 3. 总验收

1. `pnpm test` 全绿（含新增用例）；`cd src-tauri && cargo test` 全绿。
2. `pnpm build`（tsc + vite build）通过。
3. 验收纪要落 `docs/acceptance/P32-2026-09-08.md`（沿用现有验收文档惯例）。
4. 行为不变性红线：消息内容/顺序零丢失（P31 的 50 条突发回放测试保持通过）；权限/提问卡/队列/回溯/分叉语义不变。
