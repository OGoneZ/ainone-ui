# P37 规格书：会话内实时输出速率（tok/s）

> 日期：2026-09-09
> 位置：聊天气泡末条下方「总时钟」（TurnElapsed 用时）**右侧**，同一行
> 前置调研：2026-09-09 会话（本仓 usage 链路 / claude-agent-acp + codex-acp 桥源码 / 社区方案）

## 0. 需求与裁决

用户需求：每个会话实时显示当前每分钟输出多少 token（TPM）。

**裁决 1 — 口径用 tok/s，不用 TPM。** 社区（crush / assistant-ui / pi-token-speed / Open WebUI）无一例外用 tok/s：口径一致、数字可读（TPM 12000 vs 200 tok/s）。本规格跟随社区。

**裁决 2 — 速率是估算值，终值回算兜底。** ACP 协议不存在逐 token 计量流：
- `usage_update.used` = 上下文占用（非输出速率），claude-acp 每条 assistant 消息完成才发（分钟级粒度）；codex-acp `thread/tokenUsage/updated` 也只是秒级批量
- `PromptResponse.usage.outputTokens`（UNSTABLE experimental）是 turn 终态权威输出数——但只在 turn 结束

社区通行做法 = 流中「字符增量/时间 → 估算 tok/s」+ 完成后「终值 token ÷ 总时长」回算精确均值。本仓采纳同一形状。

**裁决 3 — 数据源复用 agent_text 事件流（P35 pacer 输入侧）。** 零新 IPC、零协议改动、零 Rust 改动。速率测「到达侧」（pacer.onChunk 的输入）而非「揭示侧」（30fps 匀速假象）——揭示节奏是 P35 人为制造的，测它得到的是 pacing 参数不是模型速率。

## 1. 社区调研结论

| 方案 | 做法 | 采纳点 |
|---|---|---|
| [crush #3167](https://github.com/charmbracelet/crush/issues/3167) | 流中 delta 字符数+时间戳估算 tok/s；完成后 EventComplete 终值回算 | 估算+回算双口径 |
| [assistant-ui Message Timing](https://www.assistant-ui.com/docs/guides/message-timing) | `tokensPerSecond` = output tokens ÷ stream 时长（流结束后显示） | 终值公式 |
| [pi-token-speed](https://pi.dev/packages/pi-token-speed) | TPS 分档着色（0-15 红/15-30 黄/30-45 绿/45+ 青）；`average`/`last` 两种终态口径 | 分档着色阈值 |
| [Open WebUI #5455](https://github.com/open-webui/open-webui/discussions/5455) | 流中逐 delta 更新，或统计面板 | 实时更新节奏 |
| agenttower RateBar | 缓存命中率条（非速率） | —（确认同代客户端无现成 TPM） |

## 2. 改造项

### R1 速率计算器 `src/chat/hooks/streamRate.ts`（纯逻辑，可单测）

```typescript
export interface StreamRate {
  onChunk(text: string, now: number): void; // 到达侧字符增量
  rate(now: number): number | null;         // 估算 tok/s（滑动窗口）；窗口空 → null
  finalize(totalOutputTokens: number | null, endedAt: number): void; // 终值回算
  display(): number | null;                  // 显示值：流中=rate()；结束后=finalize 均值
  reset(): void;
}
createStreamRate(opts?: { now?: () => number }, )
```

- 滑动窗口 10s：`(text, ts)` 样本数组，`rate(now)` = 窗口内字符增量 ÷ 窗口时长 ÷ charsPerToken
- `charsPerToken`：中英文混合自适应——按当前窗口文本 CJK 占比在 1.5（纯中文）~4（纯英文）间线性插值（实测校准点：中文 ≈1.5-1.8 字/token，英文 ≈4 字符/token）
- 稳态去抖：窗口内 < 20 字符 → rate 返回 null（首字前/长静默不显示跳动数字）
- EMA 平滑（α=0.35）：`ema = ema + 0.35×(rate − ema)`，防单次突发抖动
- `finalize`：有 `outputTokens` → 显示 `tokens ÷ (endedAt − startedAt)` 精确均值；无 → 保留最后估算 EMA
- 样本上限 200 条，超限丢最旧（长 turn 内存有界）

### R2 turn 接线 `src/chat/ChatPanel.tsx` runPrompt

- `const rate = createStreamRate();`（pacer 旁创建）
- 事件循环 `e.type === "agent_text"` 分支：`rate.onChunk(e.text, Date.now())`（pacer.onChunk 同点位，输入侧）
- `turn_stop` 已有 stopReason 捕获；turn 正常收口（`patch turnEndedAt` 处）：`rate.finalize(null, Date.now())`——本仓两个 harness 均不填 `PromptResponse.usage`（源码实证），终值回算暂无权威源，接口预留
- finally 不 reset：`display()` 保持冻结值到下轮 runPrompt 新建 rate

### R3 显示组件 `src/chat/message/MessageLine.tsx` TurnElapsed 右侧

- TurnElapsed 行内（`.turn-elapsed` flex 容器）总时钟右侧追加 `<StreamRateBadge rate={...} />`
- 数据流：**不进 store**（P32 R2 教训——每秒变的值进 sessionSignals 编码投影会击穿 App 级浅比较全树重渲染）。rate 状态放 MessageLine 末条实例局部 state
- 更新节奏：1s interval（与 useElapsedTicker 同频）只在 `busy && isLast` 时跑；显示格式 `⚡ 42 tok/s`；非末条/busy=false 显示 `rate.display()` 冻结值（turn 结束后常驻，与总耗时常驻语义对齐）
- 分档着色（pi-token-speed 阈值）：<15 `--danger`、15-30 `--warning`、≥30 `--success`
- 纯 tool 轮（无 agent_text）rate 为 null → 不渲染 badge，布局不空占
- MessageLine 是 memo 组件：rate 更新走末条实例 setState，非末条 props 不变跳过——与 P32 R1 lastEventAt 同款纪律

### R4 PromptResponse.usage 消费（预留，最小实现）

`session-core.ts` prompt resp 处（`:540`）：`resp.usage?.outputTokens` 存在时随 `turn_stop` 事件带出 `outputTokens` 字段 → R2 finalize 改传真值。claude-acp/codex-acp 当前均不填，属协议前向兼容，测试锁类型语义即可。

## 3. 验收标准

| # | 标准 |
|---|---|
| AC-1 | 流式 text turn：总时钟右侧出现 `⚡ N tok/s`，1s 节奏更新，CJK/英文混合文本速率数值落在合理区间（中文 ~30-80、英文 ~20-100 视模型） |
| AC-2 | 纯 tool turn（无文本输出）不显示速率 badge |
| AC-3 | turn 结束 badge 冻结为本 turn 平均速率常驻（不消失、不归零），下轮 runPrompt 归零重走 |
| AC-4 | 滑动窗口空/首字未到不显示（无 0 tok/s 跳动） |
| AC-5 | App 级渲染纪律：速率变化不触发侧栏/flexlayout 重渲染（sessionSignals 编码串不变的既有测试全绿） |
| AC-6 | 长流式 turn（396 条回放）内存有界（样本数组 ≤ 200）且速率收敛 |

## 4. 测试用例

| 文件 | 用例 |
|---|---|
| `streamRate.test.ts` | 匀速流估算收敛；CJK/英文 charsPerToken 插值；窗口滑出旧样本；<20 字符 null；EMA 抖动抑制；finalize 有/无终值两分支；样本上限丢弃；reset |
| `ChatPanel.p37.test.tsx` | 50 条 text 事件流式 → badge 出现且 busy 结束后冻结常驻；纯 tool 事件 → 无 badge；下轮 turn 重走 |
| 既有防回归 | P31 节流 / P32 R1/R2 / P34 可见性 / P35 pacer 全部测试通过（接入点零冲突验证） |

## 5. 不做

- TPM 口径（社区无一使用，数字不可读）
- 真 TPM 账单口径（协议无流式真值；`PromptResponse.usage` 预留接口即可）
- 侧栏/输入框区域显示（用户指定总时钟右侧，一处就够）
- TTFT 显示（assistant-ui 有但超本需求范围）
