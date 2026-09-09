# P35 规格需求书：流式输出平滑揭示（pacing）——从「隔一会蹦几个字」到匀速流动

> 状态：**已确认**（用户 2026-09-09 反馈：流式输出卡卡的，隔一会突然蹦出几个字；要求先调研社区方案）。
> 执行分支：`zhubaoduo/perf/p35_stream_pacing`（基于 main @ 7bc9f07）。

## 0. 问题定义（现象与量化）

**现象**：LLM 流式输出时文字「隔一会儿突然蹦出几个字」，不连贯。

**根因**（本仓链路量化）：harness SSE chunk 平均 ~121ms/条（P31 事故实测 396 条/48s），每条几十字。P31 的 rAF 节流只解决「同一帧内多条合并」，**到达节奏被原样透传到 UI**——TCP/SSE 突发下 300ms 无消息后 3 条一起到，人眼感知为跳变而非流动。提交粒度 = chunk 粒度，这是 pacing 缺失，不是渲染性能问题（P31/P32 已把渲染成本打下来）。

## 1. 社区调研结论（2026-09-09）

| 方案 | 机制 | 结论 |
|---|---|---|
| Vercel AI SDK smoothStream | 服务端 TransformStream，buffer 重新切片每段 await delay(10ms)，word/line 切分；**无 catch-up**（落后线性积压）；CJK 需 Intl.Segmenter | 服务端粗调，不适用（我们是 ACP 客户端）；无追赶机制 |
| ChatGPT/Claude.ai | 无官方算法公开；Anthropic 官方推文证实核心是「只更新仍在变化的部分」（增量渲染非 pacing）；社区分析主流 = buffer+drain（30-50ms 批量） | 方向佐证：客户端独立揭示时钟是共识 |
| Convex useSmoothText | **时间基 catch-up**：20fps setInterval，目标速率 = 实测到达率 + (rateError+lagRate)/2，EMA 平滑 (2 新+旧)/3，增幅钳制 ≤2x | 最简可移植（~80 行） |
| **markstream-core**（DeepChat 在用） | **比例控制器**：targetCps = clamp(pendingChars/目标延迟, minCps, maxCps)；pending > catchUpThreshold 切短延迟（350ms）→ 落后越多揭示越快；EMA 0.2 平滑；charBudget += cps×dt；每帧揭示 min(floor(budget), maxCharsPerCommit) 个 grapheme（Intl.Segmenter）；**未闭合 code fence 阻塞揭示**；startDelayMs 缓冲开屏突发；maxCommitFps 跳帧 | 最完整开源实现，直接对齐本仓需求 |
| 性能预算共识 | 逐字符 60fps setState 浪费；主流提交帧率 20-30fps；真正瓶颈是 markdown 重解析（O(n²) 全文 slice 反模式）；揭示粒度按 cps×dt + maxCharsPerCommit 上限；reduced-motion 直通 | 参数与护栏取此 |

**采纳**：markstream-core 形状的比例控制器（带 catch-up），提交帧率 30fps，grapheme 切分 + fence 阻塞。

## 2. 改造项

### R1 — streamPacer 纯逻辑（时间基比例控制器）
- **内容**：`src/chat/hooks/streamPacer.ts`，零 React 依赖，`now()`/帧调度注入可单测：
  - `onChunk(text)`：事件到达即累积（turnRef 之后、store 之前的揭示层）
  - `tick(now)`：每帧计算 `targetCps = clamp(pending/latency, minCps, maxCps)`（pending > catchUpThreshold 时 latency 从 900ms 切 350ms）；EMA 平滑（0.2）；`charBudget += cps×dt`；揭示 `min(floor(budget), maxCharsPerCommit)` 个 grapheme
  - 安全切分：`Intl.Segmenter` grapheme（CJK/emoji 不切半）；未闭合 code fence 内**阻塞揭示**（整段等闭合，避免半个代码块抖出）
  - `flush()`：揭示全量（turn 结束收口，对齐 P31 flush 语义）
  - `dispose()`：清理
  - 默认参数：`minCps 40 / maxCps 2000 / targetLatencyMs 900 / catchUpLatencyMs 350 / catchUpThreshold 600 / commitFps 30 / maxCharsPerCommit 120`
  - `prefers-reduced-motion` → 直通（不启动揭示时钟，onChunk 直接全量揭示）
- **目标**：到达节奏（8/s 突发）与显示节奏（30fps 匀速 ≤120 字/次）解耦；落后自动加速清积压；延迟有上限（≤~1s）不无限积压。
- **验收标准**：
  - 模拟 396 条突发（P31 回放）：揭示次数 ≤ 30fps×时长；终态 flush 后全文完整无丢字；
  - 突发积压 600+ 字时揭示速率自动升档（catch-up 生效）；
  - 揭示切片永不落在 grapheme 中间/未闭合 fence 内；
  - reduced-motion 下零 pacing 开销（直通）。
- **测试**：`streamPacer.test.ts`——匀速推进、catch-up 升档、fence 阻塞、grapheme 完整、flush/dispose、reduced-motion 直通、396 条回放（提交次数上限 + 全文完整性）。

### R2 — ChatPanel 接线（pacer 接入 commit 链）
- **内容**：
  - `runPrompt` 的 commit 回调改为「pacer 揭示快照 → updateLastAssistant」：turnRef 仍逐条累积（不丢事件），pacer `onChunk` 喂**末尾 text 块**的增量；tool/thought 块直通（不 pacing，保持即时状态语义——权限卡/工具状态不能延迟）
  - pacer tick 挂在同一 rAF 调度上（与 throttle 合并帧）；turn 结束 `pacer.flush()` → throttle.flush() 落终态
  - 多块 text 场景（text→tool→text 交替）：pacer 只作用于**当前增长中的尾 text 块**；块切换时旧块 flush 全量
- **目标**：UI 上文字以 ≤33ms/次、≤120 字/次的节奏匀速出现；工具/思考块状态即时；turn 结束内容完整。
- **验收标准**：50 条突发 agent_text 终态内容完整（既有防回归测试保持通过）；流式期间 store 提交次数 ≤ 30×时长/1000；tool_call 事件到达后 ≤1 帧内可见（直通验证）。
- **测试**：ChatPanel 集成——突发 agent_text + tool_call 混合回放：tool 状态即时可见、text 匀速揭示、turn 结束全文完整。

## 3. 提交切分

| 序 | 内容 | commit 前缀 |
|---|---|---|
| 1 | R1 streamPacer + 单测 | `perf(chat): ...` |
| 2 | R2 ChatPanel 接线 + 集成测试 | `perf(chat): ...` |
| 3 | 验收纪要 docs/acceptance/P35-2026-09-09.md | `docs(p35): ...` |

## 4. 总验收

1. `pnpm test` 全绿；`pnpm build` 通过。
2. 实机冒烟（webdriver）：流式会话文字匀速出现（不再「隔一会蹦几个字」）；失焦窗格同样平滑（可见性语义 P34 已保证 rAF 照跑）。
3. 红线：不丢事件（turnRef 累积不变）、终态完整（flush 收口）、tool/thought 即时性不回退、P31/P32/P34 的性能收益不回退（30fps 提交仍远低于事件率场景的旧成本）。
