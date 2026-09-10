# P41 流式传输合批与 pacer 增量切分

## 0. 背景与实证

另一台电脑上出现「大量 token 快速输出 → WebView 渲染卡死」。经基准实测（`bench/` 目录可复现，commit e0390fc），卡死主因是两项相乘：

| # | 实测结论 | 证据 |
|---|---|---|
| D | 真实 harness（claude-agent-acp）以 **2 字符/chunk** 粒度输出，read 块峰值 **≈950 条/s**，Rust `pump_events` 逐条 `Channel.send` → 每条一次 `webview.eval`，峰值近千次 eval/s | `bench/acp-stdout-probe.mjs`：87.9s prompt 共 5,795 read 块 |
| B | 长代码块流式期间 fence 未闭合 → 揭示停摆 → pending 积压，`streamPacer.tick` 每帧对**全部 pending** 跑 `Intl.Segmenter` 全量切分：254KB→14ms/帧，1MB→**61ms/帧**（超帧预算 3.7x） | `src/chat/hooks/streamPacer.bench.test.ts` |
| A | streamdown 每 commit 全文 remend + 全文 Lexer.lex，O(n²) 结构确认（3.7x 倍数），但本机量级有限（60KB→3ms/帧），单凭它不致冻结 | `bench/streamdown-parse.bench.mjs` |
| C | zustand persist 每次 set 0.003ms——**排除嫌疑，不做** | `bench/persist.bench.mjs` |

叠加因素：macOS 看门狗是 no-op（`webview_resilience.rs:184`），冻结后无自愈。

## 1. 目标

1. Rust→JS 转发从「逐条 eval」改为「合帧批量转发」：峰值 eval/s 从 ~950 压到 ≤60。
2. pacer reveal 从 O(pending)/帧 降到 O(新增)/帧：1MB 积压场景单帧 <1ms。
3. 修复 BlockView thought 分支 memo 击穿。

## 2. 方案

### 2.1 Rust 合帧转发（P0-1）

位置：`src-tauri/src/agent.rs` `pump_events`。

- `rx.recv()` 后进入合并窗口：再 drain 一批 `try_recv`（上限 64 条 / 64KB / 16ms 三者先到），多条 Stdout 合并为一条 `AgentEvent::StdoutBatch(Vec<String>)`（base64 后合批，一次 `on_event.send`）。
- Stderr 同窗口合并为 `StderrBatch`；Error/Terminated **不合批**、立即单发（保序在批次之后）。
- 窗口起手必须先阻塞 recv 一条再 drain（保证空闲零延迟，无积压时单条直发 ≤1 tick）。
- 前端 `src/acp/bridge.ts`：`AgentEvent` 类型加 `stdoutBatch`/`stderrBatch`，onmessage 循环 enqueue。
- 保序关键：合批后 batch 与后续 Terminated 等事件的相对顺序不变（同一 channel 串行 send）。

### 2.2 pacer reveal 增量切分（P0-2）

位置：`src/chat/hooks/streamPacer.ts`。

- `onChunk` 时对新追加文本即刻跑 `Intl.Segmenter`，追加进**单位数组** `pendingUnits: string[]`（不再持有 pending 字符串）。
- `reveal(n)` 只做 `splice`/游标前移 + 逐单位过 fence gate，不再对 pending 全量 `toUnits`。
- `flush`/`revealedText`/`pendingCount` 语义不变；gate 的逐字素步进语义不变（测试锁定）。
- 单测更新：`streamPacer.test.ts` 行为全量保持绿灯；基准测试 1MB 场景单 tick <1ms。

### 2.3 BlockView memo 修复（P1）

位置：`src/chat/message/BlockView.tsx:132-133`。`plugins={{ code, math }}` 与 `shikiTheme={["github-light","github-dark"]}` 提为模块级常量（照 `MarkdownView.tsx:23-25` P31 惯例）。

## 3. 验收标准

1. `pnpm test` 全绿（含 streamPacer 全部行为测试）。
2. `cd src-tauri && cargo test` 全绿。
3. 基准对比：`streamPacer.bench.test.ts` 场景 B1 pending=1022KB tick 从 61.5ms → **<1ms**。
4. `bench/acp-stdout-probe.mjs` 复测显示 harness 端不变（这是上游行为，不受影响）；合批效果由 Rust 单测 + Tauri dev 手测「长代码块输出不再冻住 UI」确认。
5. 回归红线：消息顺序不乱（NDJSON 行序保序）、空闲时首字延迟无可感知劣化（<30ms）。

## 4. 非目标

- streamdown 前缀冻结（O(n²) 温烧）→ 后续 P42 评估社区库。
- 看门狗 macOS 分支 → P43。
- persist 节流（已排除）。
