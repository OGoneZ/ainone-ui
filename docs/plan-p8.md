# ainone-ui · P8 会话进阶能力（需求池 6 条 IDEA）· 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.1
**日期**：2026-09-03
**状态**：已批准基线（调研 + 排期 + 测试/日志要求齐备）
**上游关系**：6 条 IDEA 来自 `docs/ideas.md`（IDEA-001…006）；承接 `docs/plan-v2.md`（P4–P6 已 Latch）与 `docs/plan-p7-ui.md`（P7 UI 基建）

---

## 0. 调研结论（2026-09-02 实测，决定性）

用 bun 探针 `tools/spike/e2e-p8-capabilities-probe.ts` 对 `claude-agent-acp` 实测（复用生产 session-core），结论：

| 探测 | 结果 | 影响 |
|---|---|---|
| `usage_update` 通知 | ✅ 发，`{used, size, cost}` | IDEA-002 上下文占用/token/成本数据源坐实 |
| `session/fork` | ✅ 真实现，返回新 sessionId | IDEA-005 分叉协议可行（「从历史点」仍需客户端重放） |
| `providers/list` | ✅ 返回 `providerId/apiType/baseUrl`，无模型名 | IDEA-002「当前模型」只能 apiType+baseUrl |
| `current_mode_update` | ❌ 不发（样本空） | 「当前 mode」此 harness 无数据源，降级 |
| `file 回滚能力` | ❌ 协议无此方法 | IDEA-006「回滚文件修改」必须外置（git 快照） |

**架构决策**：

- **DEC-13**：IDEA-002「当前模型」字段来源 = adapter 启动配置（`args` 里 `--model`），ACP 只补 apiType/baseUrl。协议不提供模型名，不硬造。
- **DEC-14**：IDEA-005 分叉 = `session/fork`（`sessionId + cwd`，从当前状态 fork）；「从历史点 fork」留待客户端本地重放，不在首期。
- **DEC-15**：IDEA-006 的「回滚文件修改」（情况二）= 外置 git 快照；「只回滚上下文」（情况一）走客户端重放 + 截断本地日志。
- **DEC-20（2026-09-03 新增，所有者裁决）**：IDEA-001 用法 2/3（单句轻量问答 + 悬浮窗解释）需要「独立 endpoint 直调模型」，**打破 v1 的「不实现 LLM 调用」边界**。新增一条**仅供快问**的轻量模型调用路径：不进 agent 主链路、不写会话日志、不走 harness。调用方式走 **Rust 新增 command `quick_ask`**（理由：密钥不暴露给 WebView、天然落日志、可 cargo test、规避前端 CSP/http-scope 限制）。此路径与「驱动 harness」完全隔离，不改变现有 ACP 架构。

---

## 1. 总方向与排期

6 条 IDEA 全为 UI 密集需求，统一前置 = P7 UI 基建（消息 hover 操作行、右侧栏骨架、输入区改造、消息操作入口）。排期：

```text
P7 UI 基建（已完成）
   │
   ├─ 第一批【协议已通、独立、立竿见影】——P8.1
   │    · IDEA-004 会话↔harness 绑定收尾 + 空闲超时回收
   │    · IDEA-001 批注引用（用法1：多段批注）＋ 用法2/3（轻量快问+悬浮解释）
   │
   ├─ 第二批【协议已通、需接新采集】——P8.2
   │    · IDEA-003 文件引用（传路径语义）
   │    · IDEA-002 元数据侧栏（usage_update/providers 采集）
   │
   └─ 第三批【协议可行但重、需专门方案】——P8.3
        · IDEA-005 会话分叉（session/fork）
        · IDEA-006 消息回溯（上下文重放 + git 文件快照）
```

**判据**：IDEA-004 大半已交付（`adapter_id` 已入索引、切 Tab 子进程已常驻），差的只是视觉与回收策略，成本极低价值最高。IDEA-001 纯前端不碰主协议，是「引用能力」地基。

---

## 2. 统一测试与日志要求（每 F 项强制）

承接 `TESTING.md` 分层。**每个 F 项的「完成」定义 = 功能 + 测试 + 日志三件齐全**，缺一不可通过验收。

### 2.1 测试矩阵（防回归）

| 层 | 手段 | 覆盖 | 命令 |
|---|---|---|---|
| 纯函数 | vitest（node） | 抽出的纯函数穷举边界 | `pnpm test` |
| 组件交互 | vitest + jsdom + testing-library，`mockIpc` + `vi.mock(openSession)` | UI 行为、状态流转 | `pnpm test` |
| Rust 逻辑 | cargo test | 新增 command 边界 | `cd src-tauri && cargo test` |
| 协议 e2e | bun 探针（复用生产 session-core） | 真实 harness 互通 | `pnpm test:e2e` |

**铁律**：凡「输入确定 → 输出确定」的逻辑必须抽纯函数并配单测；e2e 探针直接 import 生产代码，不写第二份副本。

### 2.2 日志埋点

- 前端走 `logger`（`src/lib/logger.ts`，scope 前缀），Rust 走 `log::`。
- **每个 F 项必须新增关键链路埋点**：入口 → 中间状态 → 结果/失败，各一条。定位套路见 TESTING.md §1.1（`[session]`/`[acp]`/`[agent]` 前缀按时间轴串链）。

---

## 3. P8.1 · 第一批

### F-8-1 IDEA-004 会话↔harness 绑定收尾 + 空闲回收（M）

**功能**：
- 会话行 leading 槽位显示该会话的 harness logo（复用 P7 F-7-3 头像体系，按 `adapter_id` 解析）
- hover/聚焦会话行时，`title` 显示 harness 名称
- 点击历史会话 → 用会话自己绑定的 `adapter_id` 驱动（当前已如此，本条验收锁定）
- **进程模型（对齐 ideas.md IDEA-004）**：采用**模型 A（1 session = 1 进程，现状）**；新增**空闲超时回收（M，默认开）**：某 session 持续 N 分钟（默认 5 分钟）无交互且无运行中 turn → 回收其子进程；再点开时重新 spawn + `session/load` 恢复（配合已实现消息日志回填，不丢历史）。模型 B（进程复用）仅作后续升级路径，不在本期。

**测试**：
- 纯函数：回收判定 `shouldRecycleSession(lastActivityMs, nowMs, thresholdMs, isBusy) → bool`（vitest 覆盖：空闲/忙/阈值边界）
- 组件：会话行 logo 随 adapter_id 渲染、hover title（testing-library）

**日志**：
- Rust `[agent]` 回收：`log::info!("[agent:{id}] 空闲超时回收")` + 回收前最后活动时间
- 前端 `[session]` reopen：`logger.info("session", "reopen after recycle", {sessionId})`

**验收**：
- **AC-P8-1**：同一工作区下 3 个不同 harness 会话 → 各自 logo 显示、hover 显示对应 harness 名 → 通过
- **AC-P8-2**：点击某会话 → 打开的 ChatPanel 用该会话 `adapter_id` 对应 harness → 通过
- **AC-P8-3**：3 个会话并行切换 Tab，各自 status 不丢、logo 不串 → 通过
- **AC-P8-4**：会话空闲超阈值 → 子进程被回收（`pgrep` 无该 harness 进程）；点回该会话 → 历史回填完整可续聊（回归暗号 AC-P2-4）→ 通过
- **AC-P8-5**：`shouldRecycleSession` vitest 全绿（含 running 中不回收的边界）→ 通过

### F-8-2 IDEA-001 批注引用 · 用法 1（多段批注，M）

**功能**：
- 选中 assistant 消息一段文字 → 该文本旁生成批注卡，卡内填疑问/评论；一次回复可连续框选多处，各生成独立批注卡
- 全部完成后「发送」一次 → 组装 `被引用原文 + 各条疑问` 为一条请求
- 引用拼装为纯文本，格式（确定性，可单测）：
  ```
  [引用 1] <原文片段>
  疑问：<批注内容>
  ---
  ```
- 与 steering 兼容：运行中发送批注 → 打断当前 turn 后新发起（复用打断队列）

**测试**：
- 纯函数 `composeQuotedPrompt(quotes: {text, question}[]) → string`（vitest 覆盖：多段/单段/空疑问/空原文边界）
- 组件：选中文本 → 批注卡出现 → 填疑问 → 发送 → user 气泡含组装文本（JS 模拟选区 + testing-library）

**日志**：
- `logger.info("chat", "annotate-send", {quoteCount})` 发送前记录批注段数；失败走既有 `[chat] prompt 失败`

**验收**：
- **AC-P8-6**：选中一段 assistant 文字 → 出现批注输入，填疑问发送 → user 气泡可见「[引用 N] + 原文 + 疑问」组装文本 → 通过
- **AC-P8-7**：同一回复框选 2 处 → 各自批注，发送后组装 2 段引用 → 通过
- **AC-P8-8**：运行中发送批注 → 打断当前 turn 并发起新 turn（回归 steering）→ 通过
- **AC-P8-9**：`composeQuotedPrompt` vitest 全绿 → 通过

### F-8-7 IDEA-001 批注引用 · 用法 2/3（轻量快问 + 悬浮解释，M，DEC-20）

**功能**：
- 选中 agent 消息一段文字 → 操作菜单提供「快速解释」（区别于「批注」）
- 点击后走**独立轻量模型路径**（DEC-20）：只把选中文本 + 一句内置的「请解释」prompt 发到**快问 endpoint**，不走当前会话、不改动 harness 上下文、不写会话消息日志
- 结果以**悬浮窗**呈现（浮在选中点附近），可关闭、可复制
- 「快问模型」在设置页独立配置：baseUrl / apiKey / model / 超时（OpenAI 兼容 chat/completions 格式）
- 未配置 endpoint → 快问入口禁用或点击提示「未配置快问模型」

**测试**：
- Rust `quick_ask` 单测（cargo test）：成功 / 非 2xx / 超时 / 空响应四级
- 组件：选中 → 菜单含「快速解释」→ mock 返回 → 悬浮窗显示；未配置时入口禁用

**日志**：
- Rust `log::info!("[quickask] 请求 {url} 模型 {model}")` + `log::warn!("[quickask] 失败 {status}/{err}")` + 耗时
- 前端 `logger.info("chat", "quick-ask", {textLen})`

**验收**：
- **AC-P8-10**：选中一段文本 → 点「快速解释」→ 悬浮窗显示解释内容，可关闭、可复制 → 通过
- **AC-P8-11**：快问结果**不进入**会话消息列表、**不写入**会话日志文件（对比发送前后日志文件行数）→ 通过
- **AC-P8-12**：未配置快问模型 → 入口禁用或明确提示，不误发 → 通过
- **AC-P8-13**：断网/超时 → 悬浮窗错误提示，应用不崩溃，主会话不受影响 → 通过
- **AC-P8-14**：`quick_ask` Rust 单测全绿（四级返回态）→ 通过

> **实现待定**（不阻塞）：快问 endpoint 的请求库（reqwest / tauri-plugin-http）、apiKey 存储位置（Rust 配置，前端不可读）；内置「请解释」prompt 文案。

---

## 4. P8.2 · 第二批

### F-8-3 IDEA-003 文件引用（M）

**功能**：
- 输入栏上方「添加文件」按钮 + 拖拽到对话框，二者同路径：文件加入「待发送附件」集
- 附件胶囊列表（文件名 + × 移除）
- **传路径语义**：文件作为绝对路径传给 harness，由 harness 自行读取（不注入内容、不占客户端上下文）。格式 `@file:/abs/path`
- 「注入内容」开关（S，默认关）：开启时 fs 读内容拼入 prompt（烧 token，用户权衡）

**测试**：
- 纯函数 `composeFileReference(files: {path}[]) → string`（vitest 覆盖：多文件/绝对路径校验/空集）
- 组件：按钮选文件 + 拖拽 + 移除胶囊（testing-library，mock 文件选择）

**日志**：
- `logger.info("chat", "attach-file", {path, count})`；`logger.info("chat", "send-with-files", {count})`

**验收**：
- **AC-P8-15**：点「添加文件」选 1 个 → 附件胶囊出现 → 发送 → user 气泡含绝对路径引用 → 通过
- **AC-P8-16**：拖拽文件到对话框 → 高亮反馈 + 释放即附上（与按钮同路径）→ 通过
- **AC-P8-17**：附件 × 移除 → 发送不含该文件 → 通过
- **AC-P8-18**：`composeFileReference` vitest 全绿 → 通过

### F-8-4 IDEA-002 元数据侧栏（M）

**功能**：
- 右侧新增可折叠第二侧栏，展示当前会话元数据：
  - **上下文占用**：`used / size` + 百分比进度条（来源 `usage_update`，已实测）
  - **token 用量**：`used`（含 cost，有则显示）
  - **session ID**、**工作区 cwd**（本地）
  - **harness/apiType**（adapter + `providers/list` 的 apiType/baseUrl）
  - **模型**（adapter `args` 里 `--model`，若配置；DEC-13）
- 数据流：`session-core` 扩展 `dispatchUpdate` 捕获 `usage_update` → 外发 `Outgoing` → 存 zustand（按 tabKey）→ 侧栏订阅
- 默认折叠，展开开关持久化
- **粒度边界**：本期只到 used/size/cost 总量。DeepChat 式「工具 schema 预留 / 未归属输入」分项依赖 harness 额外上报，留作后续（ideas IDEA-002 待定 2）。

**测试**：
- 纯函数 `extractUsage(u) → {used, size, cost}`（vitest 覆盖：正常/空值/缺 cost）
- 组件：向 onOutgoing 注入 usage 事件 → 侧栏进度条更新（testing-library）

**日志**：
- `logger.debug("session", "usage", {used, size, cost})`（流水，级别 debug 防刷屏）

**验收**：
- **AC-P8-19**：会话运行中 → 右侧栏上下文占用进度条随 `usage_update` 实时更新 → 通过
- **AC-P8-20**：显示 sessionId / cwd / apiType / 模型 四项，值与实际一致 → 通过
- **AC-P8-21**：侧栏可折叠，折叠状态重启后保持 → 通过
- **AC-P8-22**：`extractUsage` vitest 全绿 → 通过

---

## 5. P8.3 · 第三批

### F-8-5 IDEA-005 会话分叉（M）

**功能**：
- 某条 assistant 消息 hover 操作行提供「从这里分叉」入口
- 分叉实现 = `session/fork`（`sessionId + cwd`，从当前状态 fork，DEC-14）
- 分叉出的会话作为新条目出现在侧栏，标注「从 XX 分叉」；独立 session_id + 独立消息日志
- 首期不做「从任意历史点 fork」（需客户端重放，列为后续）

**测试**：
- 纯函数 `forkSession(session-core 内)` 封装；e2e 探针真实 harness fork 返回新 sessionId
- 组件：点「分叉」→ 侧栏出现新条目（mock openSession + tab store）

**日志**：
- `logger.info("session", "fork", {fromSessionId, toSessionId})`；Rust 侧无需（纯 ACP 请求）

**验收**：
- **AC-P8-23**：运行中会话点「分叉」→ 侧栏出现新会话（标注来源），新 sessionId 非空且可继续对话 → 通过
- **AC-P8-24**：新分支继续对话 → 原会话不受影响 → 通过
- **AC-P8-25**：fork 封装纯函数 + e2e 探针（真实 harness fork 返回新 sessionId）→ 通过

### F-8-6 IDEA-006 消息回溯（M，情况一；情况二为 S+外置）

**功能**：
- 用户消息 hover 操作行提供「回溯到这里」入口
- **情况一（M）只回上下文**：以该消息之前历史为基底，`session/load` 恢复 + 本地日志截断到该点，之后消息丢弃
- **情况二（S）回上下文+文件**：情况一之上，对上轮文件修改做 git 快照回滚（DEC-15）；破坏性操作二次确认
- 回溯前显著提示；情况二额外危险确认

**测试**：
- 纯函数 `truncateToMessageIndex(messages, index) → messages`（vitest 覆盖：N=0 / 中间 / 越界 / 负数）
- 组件：点回溯 → 确认弹窗 → 消息列表截断（testing-library）

**日志**：
- `logger.warn("chat", "rewind", {toIndex, withFiles})`（回溯是破坏性操作，warn 级留痕）

**验收**：
- **AC-P8-26**：回溯到第 N 条 → 上下文与消息列表截断到 N 之前，之后对话消失 → 通过
- **AC-P8-27**：`truncateToMessageIndex` vitest 全绿（N=0 / 越界）→ 通过
- **AC-P8-28**（S）：文件回滚走 git 快照，回滚前二次确认 → 通过

> **待定**（ideas IDEA-006）：文件快照粒度、回滚可逆性。最简起步「每 turn 结束 git commit（若在 git 仓库内）」。

---

## 6. MoSCoW 汇总

| 级 | 项 |
|---|---|
| M | F-8-1 绑定+回收、F-8-2 批注用法 1、F-8-7 快问用法 2/3、F-8-3 文件引用、F-8-4 元数据侧栏、F-8-5 分叉、F-8-6 回溯情况一 |
| S | 文件内容注入开关、文件快照回滚（情况二）、从任意历史点 fork |
| C | 上下文块统一数据结构 API、插件式元数据字段注册、快问请求库选型细化 |
| W | 文件二进制内容注入、移动端适配、`plan/usage` 明细分项（依赖 harness 上报） |

---

## 7. 实施顺序与依赖

```text
P7 完成（前置）
  → P8.1：F-8-1 绑定+回收（0.5 天）→ F-8-2 批注用法1（1 天）→ F-8-7 快问（1 天，含 Rust quick_ask）
    → P8.2：F-8-3 文件引用（1 天）→ F-8-4 元数据侧栏（1 天，含 session-core 扩展）
      → P8.3：F-8-5 分叉（1 天）→ F-8-6 回溯（1.5 天）
```

每 F 项独立 commit + 独立验收；**纯函数优先落地并配 vitest，Rust command 配 cargo test，e2e 探针配真实 harness**；每 F 项含日志埋点。

## 8. 工作量估算

| 项 | 估算 |
|---|---|
| P8.1（绑定+批注+快问） | 2.5 天 |
| P8.2（文件 + 元数据） | 2 天 |
| P8.3（分叉 + 回溯） | 2.5 天 |
| 回归 + 验收留档 | 1 天 |
| **合计** | **约 8 天**（不含 P7 前置） |

## 9. 需求追溯

| 功能项 | 溯源 | 验收 |
|---|---|---|
| F-8-1 | IDEA-004 | AC-P8-1…5 |
| F-8-2 | IDEA-001（用法 1） | AC-P8-6…9 |
| F-8-7 | IDEA-001（用法 2/3） | AC-P8-10…14 |
| F-8-3 | IDEA-003 | AC-P8-15…18 |
| F-8-4 | IDEA-002 | AC-P8-19…22 |
| F-8-5 | IDEA-005 | AC-P8-23…25 |
| F-8-6 | IDEA-006 | AC-P8-26…28 |

## 10. 变更记录

| 日期 | 版本 | 变更 | 决策人 |
|---|---|---|---|
| 2026-09-02 | v1.0 | 初版：6 条 IDEA 升格；DEC-13/14/15 | 所有者+Claude |
| 2026-09-03 | v1.1 | IDEA-001 拆 F-8-2（用法 1）+ F-8-7（用法 2/3，DEC-20 打破 LLM 边界）；IDEA-004 对齐进程模型 A+超时回收为 M；新增 §2 统一测试/日志要求，全 F 项补齐测试与埋点 | 所有者+Claude |
