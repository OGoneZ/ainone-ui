# ainone-ui · P9 会话进阶能力（需求池 5 条 IDEA）· 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.1
**日期**：2026-09-03
**状态**：已批准基线（排期 + 测试/日志要求齐备）
**上游关系**：5 条 IDEA 来自 `docs/ideas.md`（IDEA-007…011）；承接 `docs/plan-p8.md`（IDEA-001…006 已排期）

---

## 0. 11 条需求总览（P8 + P9 全貌）

| # | IDEA | 主题 | 优先级 | 归属期 | 状态 |
| --- | --- | --- | --- | --- | --- |
| IDEA-001 | 批注式引用提问 | — | P8.1 | 已排期 |
| IDEA-002 | 右侧元数据侧栏 | — | P8.2 | 已排期 |
| IDEA-003 | 文件引用 | — | P8.2 | 已排期 |
| IDEA-004 | 会话↔harness 绑定 + 后台并行 | — | P8.1 | 已排期 |
| IDEA-005 | 会话分叉 | — | P8.3 | 已排期 |
| IDEA-006 | 消息回溯 | — | P8.3 | 已排期 |
| IDEA-007 | 命令队列 | P1 | **P9.2** | 本文件 |
| IDEA-008 | 会话内搜索与跳转 | P1 | **P9.1** | 本文件 |
| IDEA-009 | 工作区文件树 | P2 | **P9.3** | 本文件 |
| IDEA-010 | 语音输入 | P3 | **P9.4** | 本文件 |
| IDEA-011 | 计划栏 | P1 | **P9.1** | 本文件 |

**排期图谱**：

```text
P7 UI 基建（已完成）
  → P8（IDEA-001…006，已排期）
      → P9.1 计划栏 + 会话内搜索   ← 本文件
          → P9.2 命令队列
              → P9.3 工作区文件树（需 Rust 新命令）
                  → P9.4 语音输入（P3，外部依赖）
```

---

## 1. 调研结论（2026-09-03 源码核查）

| 结论 | 影响 |
| --- | --- |
| SDK 1.4.0 已定义 `plan`/`plan_update`/`plan_removed`，`PlanEntry{content, priority, status}`，status ∈ `pending/in_progress/completed`；注释显式「agent 每次**全量替换**整个 entries」 | IDEA-011 数据源坐实，全量替换是协议语义 |
| `plan_update` / `plan_removed` 标记 **UNSTABLE（experimental）** | 计划栏首期只消费 `plan` 全量替换，暂不依赖 unstable 的增量/移除 |
| omp 报文样例未出现 `plan`，只见 message/thought/tool/usage/available_commands/session_info | 实际 harness 是否发 plan **必须 spike 实测** |
| `session-core.ts` 的 `dispatchUpdate` 目前只处理 message/thought/tool_call/tool_call_update/available_commands；**plan 与 usage_update 都被「安全忽略」** | 计划栏（及 P8 元数据侧栏）都要扩展 `dispatchUpdate` |
| Rust 层**无目录读取命令**（grep `read_dir` 仅命中测试代码） | IDEA-009 文件树需新增 `list_dir` 命令 |
| 输入区上方无既有组件占位 | IDEA-007 队列面板与 IDEA-011 计划栏共用同一「输入框上方条带」，须统一分层 |

**架构决策**：

- **DEC-16**：IDEA-011 计划栏数据源 = ACP `plan` block（全量替换语义）。`session-core` 扩展 `dispatchUpdate` 捕获 `plan` → 外发 `Outgoing { type: "plan", entries }`；每次收到 `plan` 整体覆盖旧计划。首期不消费 `plan_update`/`plan_removed`（unstable + 无样本）。
- **DEC-17**：IDEA-008 搜索数据源 = 本地消息日志（内存态）。5000 条规模线性扫描足够（纯前端估 <10ms），不建倒排索引；性能不达标再升级。
- **DEC-18**：IDEA-009 文件树需 Rust 新增 `workspace_list_dir(path) → { name, is_dir }[]`（懒加载、不递归）。「最近改动」复用 P8 tool_call diff 事件的 path 字段，不做文件系统 watch。
- **DEC-19**：IDEA-007 队列与 IDEA-011 计划栏在「输入框上方」纵向分层：计划栏在上（当前 turn 执行中），命令队列在下（待发送），互不覆盖。

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
- **每个 F 项必须新增关键链路埋点**：入口 → 中间状态 → 结果/失败，各一条。定位套路见 TESTING.md §1.1。

---

## 3. P9.1 · 第一批：计划栏 + 会话内搜索

**定位**：两条都是「读/展示」能力，不碰发送语义，高频可见。前置一个 spike。

### F-9-0 前置 spike：plan block 实测（M，阻塞）

**功能**：e2e 探针实测 omp 与 claude-agent-acp 是否在一轮中发出 `plan` block；记录触发条件（什么 prompt 引出 plan）与报文存档。

**测试**：
- e2e 探针（`tools/spike/e2e-p9-plan-probe.ts`，复用生产 session-core）捕获 `plan` block 并 dump entries

**日志**：
- 探针内 `logger.debug("spike", "plan-seen", {entriesCount})` / `plan-not-seen`

**验收**：
- **AC-P9-0-1**：探针对至少一个 harness 发出「拆解执行计划」类 prompt → 捕获 `plan` block（含 entries）→ 通过；若两 harness 均不发，记录结论并降级（计划栏改走「无数据源即隐藏」，仍交付渲染层，见 §7），记入 §11 变更 → 通过（含偏差记录）
- **AC-P9-0-2**：plan 报文存档入 `docs/protocol-samples/sample-plan.json`（含 entries）→ 通过

### F-9-1 IDEA-011 计划栏（M）

**功能**：
- `session-core` 扩展 `dispatchUpdate`：捕获 `plan` → 外发 `{ type: "plan", entries: {content, priority, status}[] }`；每次全量覆盖（DEC-16）
- 输入框上方（最上层，DEC-19）常驻计划面板：
  - 折叠态：`已完成 N / 共 M` 摘要（按 `PlanEntry.status` 计数）
  - 展开态：条目清单，每条 `content` + 状态勾选（pending/in_progress/completed 三态着色）
- 只在「当前 turn 运行中且收到过 plan」时显示；turn 结束（`turn_stop`）清除，不悬挂下一轮
- 折叠/展开可聚焦（role=button + aria-expanded）

**测试**：
- 纯函数 `extractPlan(u) → PlanEntry[]`（vitest 覆盖：全量替换 / 空 entries / 未知 status）
- 组件：向 onOutgoing 注入 plan 事件 → 计划栏出现、进度计数正确；注入 turn_stop → 计划栏消失（testing-library）

**日志**：
- `logger.debug("session", "plan", {entries, done, total})`（plan 每次更新，debug 级）

**验收**：
- **AC-P9-1**：agent 一轮发出 plan → 输入框上方出现计划栏，折叠态显示 `已完成 0 / 共 N` → 通过
- **AC-P9-2**：plan 再次全量替换（部分条目变 completed）→ 进度计数实时更新，条目状态着色正确 → 通过
- **AC-P9-3**：turn 结束 → 计划栏消失，不残留下一轮 → 通过
- **AC-P9-4**：`extractPlan` vitest 全绿 → 通过

### F-9-2 IDEA-008 会话内搜索与跳转（M）

**功能**：
- 会话顶部搜索入口（快捷键 Cmd/Ctrl+F 唤起，与 slash 补全「输入框内 /」不冲突）
- 对当前会话消息全文搜索（正文、thinking、工具标题）；数据源 = 内存态消息列表（DEC-17）
- 命中高亮 + 命中计数 + 上一条/下一条（Enter/Shift+Enter）
- 跳转：复用 `scrollToIndex` 定位命中消息，命中文本高亮；关闭搜索即清除高亮

**测试**：
- 纯函数 `searchMessages(messages, keyword) → 命中索引数组`（vitest 覆盖：多命中 / 无命中 / 空关键词 / thinking 与工具标题命中）
- 组件：构造带关键词消息 → 打开搜索 → 高亮与计数正确；跳转滚动（testing-library + 虚拟列表 mock）

**日志**：
- `logger.debug("chat", "search", {keyword, hits})`；`logger.info("chat", "search-jump", {index})`

**验收**：
- **AC-P9-5**：输入关键词 → 命中计数显示，当前命中项高亮 → 通过
- **AC-P9-6**：Enter 连续按 → 高亮在命中项间顺序移动，视图滚动跟随 → 通过
- **AC-P9-7**：无命中 → 显示「无结果」，不崩溃、不误高亮 → 通过
- **AC-P9-8**：`searchMessages` vitest 全绿（含 thinking/工具标题命中）→ 通过

> **S 项（非阻塞）**：右侧 anchor rail（消息锚点光带）。只在长会话（>100 条）显示；与虚拟列表配合；不做首期验收。

---

## 4. P9.2 · 第二批：命令队列

**定位**：改发送语义（单条 steering → 队列），依赖 P9.1 确立的输入框上方布局。纯前端。

### F-9-3 IDEA-007 命令队列（M）

**功能**：
- 输入框上方（计划栏之下，DEC-19）命令队列面板：待执行指令列表，可折叠
- **追加**：运行中/空闲时都可排入队列，而非立即打断（保留「打断即发」为另一入口）
- 条目可编辑、删除、拖拽排序
- **消费**：当前 turn 结束（`turn_stop`）后自动按序发送下一条；复用 steering 排队续跑机制（`pendingTextRef` 扩展为数组）
- 容量上限（默认 10 条）：超出给明确 toaster 提示，不静默丢弃
- 队列状态持久化（按 tabKey 写入 zustand + 持久化，跨重启不丢）

**测试**：
- 纯函数队列模块 `enqueue/remove/reorder/next`（vitest 覆盖：容量边界 / 空队列 / 重排出界 / 消费取序）
- 组件：mock 运行中追加 2 条 → 列表显示 2 条 → mock turn_stop → 自动发第 1 条（testing-library）

**日志**：
- `logger.info("queue", "enqueue", {id, len, total})`、`logger.info("queue", "consume", {id})`、`logger.warn("queue", "full", {cap})`

**验收**：
- **AC-P9-9**：运行中追加 2 条 → 队列显示 2 条 → turn 结束后按序发送第 1 条 → 通过
- **AC-P9-10**：拖拽重排 → 顺序改变 → 按新顺序消费 → 通过
- **AC-P9-11**：追加至容量上限后再加 1 条 → 明确提示「队列已满」，未静默丢弃 → 通过
- **AC-P9-12**：重启应用 → 队列恢复（未发送条目仍在）→ 通过
- **AC-P9-13**：队列状态纯函数 vitest 全绿 → 通过

> **待定（实现时定，非阻塞）**：消费触发精确时机（`turn_stop` 后立即 vs 等 `follow_up` 语义，参照 P3 steering 降级）；指令携带的「引用」（文件/@会话）入队后如何保持完整。

---

## 5. P9.3 · 第三批：工作区文件树

**定位**：5 条里唯一动后端（Rust 新命令）。与 P8 文件引用（F-8-3）衔接。

### F-9-4 IDEA-009 工作区文件树（M）

**功能**：
- Rust 新增 `workspace_list_dir(path) → { name, is_dir }[]`（DEC-18）：读单层目录（不递归）、按名排序、返回文件名+是否目录；错误路径（不存在/无权限）返回结构化错误不崩
- 侧栏新增「文件」区（与工作区列表分栏/折叠切换）展示当前会话 cwd 文件树
- **懒加载**：目录节点点击展开时才调 `workspace_list_dir` 拉子项
- 文件节点 hover 提供「引用到输入框」（复用 P8 F-8-3 同路径，`@file:/abs/path`）
- **最近改动高亮**：复用 P8 tool_call diff 的 `path`，diff 中出现过的文件加「M」徽标（不做文件系统 watch）
- 排除大目录（`node_modules`/`.git`/`target`/`dist`/`build`）——硬编码清单

**测试**：
- Rust `workspace_list_dir` 单测（cargo test 覆盖：正常目录 / 不存在 / 文件而非目录）
- 纯函数 `buildFileTree` / 排除清单过滤（vitest）
- 组件：mock list_dir → 侧栏文件区渲染；点目录懒加载子项；点文件填入引用（testing-library + mockIpc）

**日志**：
- Rust `log::debug!("[list_dir] {path} → {} 项", n)` + `log::warn!("[list_dir] 失败 {path}: {e}")`
- 前端 `logger.info("fs", "ref-file", {path})`（复用 P8 引用埋点）

**验收**：
- **AC-P9-14**：打开会话 → 侧栏文件区显示 cwd 单层文件树，目录/文件图标区分 → 通过
- **AC-P9-15**：点击目录 → 懒加载子项显示；再次点击收起 → 通过
- **AC-P9-16**：点文件 → 输入框出现该文件引用（`@file:/abs/path`），与 P8 同路径 → 通过
- **AC-P9-17**：agent 运行中 diff 修改某文件 → 该文件出现「M」徽标 → 通过
- **AC-P9-18**：`workspace_list_dir` Rust 单测全绿（三类）→ 通过
- **AC-P9-19**：`node_modules`/`.git` 等排除目录不显示 → 通过

---

## 6. P9.4 · 第四批：语音输入（P3）

**定位**：低优先级、依赖已有 ASR 服务端 + Tauri 录音权限。可无限期顺延。

### F-9-5 IDEA-010 语音输入（M，期次可延）

**功能**：
- 输入框旁语音按钮；点击开始录音（Tauri 麦克风权限，首次授权）
- 录音中显示时长/音量；停止后音频发往已有自建 ASR 服务端
- 转写文本回填输入框（不自动发送，可编辑确认）
- 权限被拒 / 服务端失败 → 明确 toaster 提示，不崩溃

**测试**：
- Rust（若录音/上传走 Rust command）单测：音频编码/上传失败路径
- 组件：mock 录音状态机 → 录音/转写/回填三态渲染；mock 失败 → 提示（testing-library）

**日志**：
- `logger.info("asr", "record-start" / "record-stop", {ms})`、`logger.info("asr", "transcribe-ok", {chars})`、`logger.warn("asr", "transcribe-fail", {err})`

**验收**：
- **AC-P9-20**：点语音 → 录音开始（时长/音量可见）→ 停止 → 转写文本回填输入框 → 通过
- **AC-P9-21**：麦克风权限被拒 → 明确提示「未授权麦克风」，不崩溃 → 通过
- **AC-P9-22**：ASR 服务端不可达 → 明确提示失败，输入框可正常手动输入 → 通过

> **外部依赖**：不实现 ASR 模型本身，客户端只做录音+上传。服务端「音频格式/采样率/协议/鉴权」与「实时 vs 录后转写」为实现对接项。若 ASR 未就绪，整期顺延不影响 P9.1–P9.3。

---

## 7. MoSCoW 汇总

| 级 | 项 |
|---|---|
| M | F-9-0 spike、F-9-1 计划栏、F-9-2 搜索、F-9-3 命令队列、F-9-4 文件树、F-9-5 语音（期次可延） |
| S | anchor rail（IDEA-008 可选部分） |
| C | 上下文块统一数据结构 API（与 P8 的 C 项合并）、命令队列拖拽第三方库（dnd-kit） |
| W | `plan_update`/`plan_removed`（unstable）、文件系统 watch、MCP/远程工作区文件树 |

---

## 8. 降级预案

- **F-9-1 计划栏**：若 spike 发现两 harness 均不发 `plan` → 计划栏「无数据源即隐藏」，仍交付渲染层（组件+纯函数+单测），待 harness 升级自动点亮；记入变更记录。
- **IDEA-008 搜索**：5000 条线性扫描若实测卡顿，升级「分块+防抖」或轻量索引（DEC-17 兜底）。
- **IDEA-010 语音**：ASR 未就绪 → 整期顺延。

---

## 9. 实施顺序与依赖

```text
P8 完成（前置）
  → P9.1：F-9-0 spike（0.5 天）→ F-9-1 计划栏（0.5 天）→ F-9-2 搜索（1 天）
    → P9.2：F-9-3 命令队列（1.5 天）
      → P9.3：F-9-4 文件树（Rust list_dir 0.5 天 + 前端树 1 天）
        → P9.4：F-9-5 语音（1 天，P3 可延）
```

每 F 项独立 commit + 独立验收；纯函数（`extractPlan`/`searchMessages`/队列 store）、Rust command（`workspace_list_dir`）优先落地配测试；每 F 项含日志埋点。

## 10. 工作量估算

| 项 | 估算 |
|---|---|
| P9.1（spike + 计划栏 + 搜索） | 2 天 |
| P9.2（命令队列） | 1.5 天 |
| P9.3（文件树） | 1.5 天 |
| P9.4（语音） | 1 天（P3，可延） |
| 回归 + 验收留档 | 0.5 天 |
| **合计** | **约 6.5 天**（语音可延后约 5.5 天） |

## 11. 需求追溯

| 功能项 | 溯源 | 验收 |
|---|---|---|
| F-9-0 | IDEA-011（数据源） | AC-P9-0-1…2 |
| F-9-1 | IDEA-011 | AC-P9-1…4 |
| F-9-2 | IDEA-008 | AC-P9-5…8 |
| F-9-3 | IDEA-007 | AC-P9-9…13 |
| F-9-4 | IDEA-009 | AC-P9-14…19 |
| F-9-5 | IDEA-010 | AC-P9-20…22 |

## 12. 变更记录

| 日期 | 版本 | 变更 | 决策人 |
|---|---|---|---|
| 2026-09-03 | v1.0 | 初版：IDEA-007…011 升格；DEC-16…19；四批排期 | 所有者+Claude |
| 2026-09-03 | v1.1 | 新增 §2 统一测试/日志要求；全 F 项补齐「功能+测试+日志」三件套与日志埋点 | 所有者+Claude |
