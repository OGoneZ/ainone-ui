# ainone-ui · P12 会话编辑与灵动交互 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-03
**状态**：已批准基线（调研 + 选型 + 测试/日志要求齐备）
**上游关系**：承接 `docs/plan-p8.md` / `docs/plan-p9.md`（消息流/回溯/diff/队列已就绪）；独立于 P11（输入交互/渲染增强）的新主题期
**选型金标准**：优先成熟稳定社区方案，不重复造轮子；体积非硬红线（CLAUDE.md 仓库级纪律）

---

## 0. 需求总览（6 项）

| # | 需求 | 优先级 | 归属批 |
| --- | --- | --- | --- |
| F-12-1 | 消息编辑重试（edit & resend，ChatGPT 语义） | P1 | P12.1 |
| F-12-2 | 结构化提问交互卡（AskUserQuestion 风格） | P1 | P12.1 |
| F-12-3 | 工具活动组折叠（连续 thinking+tool 聚合卡） | P1 | P12.2 |
| F-12-4 | 文件变更聚合卡（+N/-M 徽标） | P1 | P12.2 |
| F-12-5 | diff 行内评论回传 agent（review 闭环） | P2 | P12.2 |
| F-12-6 | 上下文用量进度条 + 灵动微交互（全局 CSS） | P1 | P12.3 |

**排期图谱**：

```text
P12.1 编辑重试（F-12-1）→ 提问卡（F-12-2）
  → P12.2 活动组（F-12-3）→ 文件变更卡（F-12-4）→ diff 评论（F-12-5）
    → P12.3 进度条（F-12-6a）→ 灵动微交互（F-12-6b，横切全局）
```

---

## 1. 调研结论（2026-09-03 npm 实测 + 社区实践）

| 需求 | 结论 | 依据 |
|---|---|---|
| 编辑重试 | **自研纯函数**（~20 行）：截断消息数组 + 走既有 prompt 通道 | `@ai-sdk/react` 绑定 AI SDK transport 生态，与本仓 ACP 直连架构错位；纯数据操作无库可引 |
| 提问卡 | **复用 `radix-ui@1.6.7`**（已实测导出 RadioGroup/Checkbox），补 shadcn 配方薄封装 `radio-group.tsx` / `checkbox.tsx` | 统一包 1282 万周下载、2026-07 发布、peer 支持 React 19；社区无 ACP 语义现成提问卡 |
| 活动组 | **自研纯函数分组**（~40 行）+ 已有 `collapsible.tsx` | 聚合判定是业务逻辑；DeepChat `messageActivityGroups` 交互模式直接照抄 |
| 文件变更卡 | **引入 `diff@^9.0.0`**（周下载 1.44 亿、零依赖、tree-shake 后 ~9KB gzip），`diffLines` 算增删行数 | 手写行数统计在中间插入/删除块时会算错；`fast-diff` 是字符级且 2023 年停更 |
| diff 评论 | **纯前端粘合，零新依赖**（已有 popover/tooltip/button） | Vibe Kanban 官方文档实证：行 hover → 评论 → 聊天框徽标 → 随消息发送后清空 |
| 进度条 | **复用 radix-ui 的 `Progress`**，补 `progress.tsx` 封装；CSS transition 动画，不引 framer-motion | `@radix-ui/react-progress` 周下载 4913 万；JS 驱动动画对虚拟列表+流式渲染是纯开销 |
| 灵动 UI | **CSS 令牌优先，暂不引 motion** | 仓库令牌层已齐备（`--motion-fast 140ms` / `--ease-out-soft` / `--blur-panel 16px` / shadow 三档 / `prefers-reduced-motion` 短路）；缺的是组件层消费。WebKitGTK 的 `backdrop-filter` 有 GPU 驱动 ghosting 案例 → 毛玻璃必须 `@supports` 渐进增强。motion（13.2.0，framer-motion 官方后继）列为条件性备选：仅当出现共享布局/拖拽手势/可中断 spring 需求时引入 |

**架构决策**：

- **DEC-35**：编辑重试语义 = ChatGPT 式「从该消息重新聊」——以用户消息 `i` 为目标：截断 store 消息到 `i`（含 i）→ `log_truncate(keep=i+1)` → 该消息文本回填输入框进入编辑态（或直接重发）。用户消息 `i` **保留**（它自己是被编辑对象），`i` 之后的 assistant 回复与后续轮次全部丢弃；harness 侧复用回溯链路（`dispose` 子进程 + 下次 prompt 重新 `session/load`，本地日志已截断）。
- **DEC-36**：活动组只聚合**已完成**（status 非运行中）且**连续**的 thought/tool 块；连续段内含 text 正文块则截断分组（正文始终独立渲染）。默认折叠，运行中的 thought/tool 保持可见不进组。分组纯函数 `buildActivityGroups` 零 React 依赖可单测。
- **DEC-37**：文件变更聚合与活动组同层生效——tool 块（含 diff content）先进活动组；组展开后按 tool 内容聚合出「文件变更」子卡（文件名 + `+N/-M`），同路径多次修改跨 tool 去重合并。`countDiffLines(oldText,newText)` 用 `diffLines` 实现、可单测。
- **DEC-38**：diff 行内评论 = Vibe Kanban 模式：diff 行 hover 浮现评论按钮 → Popover 输入 → 收集进「待发评论」集（输入框上方徽标显示 N）→ 随下一条消息或单独发送 → 组装格式确定性纯函数 `composeDiffComments` 可单测；发送后清空。
- **DEC-39**：上下文进度条常驻输入框左下（`usage_update` 已有数据流，store.runtime[t].usage），三态着色：<80% 正常 / 80-99% 琥珀 `--warning` / ≥100% 红 `--danger`。radix Progress 原语 + `progress.tsx` 封装。
- **DEC-40**：灵动微交互**只做 CSS 消费**，分五类落地：① 卡片 hover 抬升（`translateY(-1px)` + shadow-sm→md）；② 按压回弹（`scale(0.98)` + ease-out-express）；③ 面板/弹层进出（tw-animate-css fade/zoom 类）；④ 悬浮卡毛玻璃（实底 + `@supports (backdrop-filter)` 才叠加 blur+透明，兼容 Linux WebKitGTK）；⑤ 所有过渡统一走 `--motion-*` 令牌与 `--ease-out-*` 曲线。`motion@^13` 列为条件性备选，触发条件：共享布局变形 / 拖拽手势 / 可中断 spring。

---

## 2. 统一测试与日志要求（每 F 项强制）

承接 `TESTING.md` 分层。**每个 F 项的「完成」定义 = 功能 + 测试 + 日志三件齐全**。

### 2.1 测试矩阵

| 层 | 手段 | 命令 |
|---|---|---|
| 纯函数 | vitest（node） | `pnpm test` |
| 组件交互 | vitest + jsdom + testing-library，`mockIpc` + `vi.mock(openSession)` | `pnpm test` |
| 协议 e2e | bun 探针（复用生产 session-core） | `pnpm test:e2e` |

**铁律**：凡「输入确定 → 输出确定」的逻辑必须抽纯函数并配单测。

### 2.2 日志埋点

- 前端走 `logger`（scope 前缀）。每个 F 项：入口 → 中间状态 → 结果/失败各一条。

---

## 3. P12.1 · 第一批：编辑重试 + 提问卡

### F-12-1 消息编辑重试（M）

**功能**：
- 用户消息 hover 操作行新增「编辑」入口（与现有「回溯到这里」并列）
- 点击后：该消息文本回填输入框、消息区滚动到该消息位置、输入框获得焦点进入编辑态（编辑态横幅提示「正在编辑第 N 条消息，发送后将从此处重新对话」，可 Esc 取消）
- 发送时（DEC-35）：
  - 截断 store 消息到该条（含该条替换为新文本）→ `truncateMessagesToEdit(messages, index, newText)` 纯函数
  - `log_truncate(keep=index+1)` 后 `log_append([新文本行])` 落盘
  - 复用回溯的进程断开链路：`dispose` 当前子进程，下次 prompt 重新 `session/load`
  - 之后按普通 prompt 发送 → agent 从该点重新生成回复（上一轮回复不进上下文）
- 上一轮回复「不再进上下文」由截断保证（ACP session/load 回放的是截断后的本地日志序）

**测试**：
- 纯函数 `truncateMessagesToEdit(messages, index, newText)`（vitest：index=0/中间/越界/-1；替换文本生效；之后消息丢弃）
- 组件：hover 用户消息 → 点「编辑」→ 输入框回填原文本 + 编辑横幅出现 → 改文本发送 → 消息列表截断且新 user 消息文本正确（testing-library + mockIpc）

**日志**：
- `logger.warn("chat", "edit-resend", {index, oldLen, newLen})`（破坏性操作，warn 级留痕）；取消编辑 `logger.debug("chat", "edit-cancel", {index})`

**验收**：
- **AC-P12-1**：hover 历史用户消息 → 操作行出现「编辑」→ 点击 → 输入框回填原文本并聚焦，出现编辑态横幅 → 通过
- **AC-P12-2**：修改文本发送 → 该消息之后的回复消失，新文本作为最后一条 user 消息，agent 从该点重新回复 → 通过
- **AC-P12-3**：编辑态 Esc → 退出编辑态，消息列表不变 → 通过
- **AC-P12-4**：编辑第 1 条消息 → 其后全部丢弃；`truncateMessagesToEdit` vitest 全绿（含越界）→ 通过
- **AC-P12-5**：重启应用重开会话 → 日志回显的是编辑后的序列（截断+替换已落盘）→ 通过

### F-12-2 结构化提问交互卡（M）

**功能**：
- 检测 agent 请求中的结构化提问（ACP `session/request_permission` 的 options 语义扩展 / harness 自定义 ask 报文；先按「options 分组语义」实现：多 option 分组 + input hint → 渲染为提问卡）
- 提问卡组件 `AskCard`：
  - 问题文本（单卡支持多问题，逐题作答）
  - 单选题：radix RadioGroup（shadcn 配方新封装 `radio-group.tsx`）
  - 多选题：radix Checkbox（新封装 `checkbox.tsx`）+ 每题「Other」自由文本输入
  - 底部按钮组：提交（全部作答才可点）/ 拒绝回答（整体 decline，返回 reject 语义）
  - 提交后卡片显示「已回答」态（不消失，保留历史可查）
- 数据契约：答案以 question 文本为键组装为纯文本注入 prompt 通道（与现有 permResolver 同路径，映射回 `allow_once`/`reject_once` optionId）
- 卡片视觉走 F-12-6b 灵动规范（悬浮卡 + 入场动画）

**测试**：
- 组件：mock 提问请求（2 题：单选+多选）→ 卡片渲染 → 未全答提交禁用 → 作答后提交 → resolver 收到正确映射 optionId（testing-library）
- 纯函数 `composeAskAnswers(answers) → string`（vitest：全答/含 Other/拒绝 null）

**日志**：
- `logger.info("chat", "ask-open", {questions: n})`；`logger.info("chat", "ask-answer", {picked})`；拒绝 `logger.info("chat", "ask-decline")`

**验收**：
- **AC-P12-6**：agent 发起结构化提问 → 消息流出现提问卡（单选/多选/Other 元素齐全）→ 通过
- **AC-P12-7**：未全部作答 → 提交按钮禁用；全部作答 → 提交 → 卡片变「已回答」态，答案回传 agent → 通过
- **AC-P12-8**：点「拒绝回答」→ 返回 reject 语义，agent 收到明确拒绝 → 通过
- **AC-P12-9**：`composeAskAnswers` vitest 全绿 → 通过

---

## 4. P12.2 · 第二批：活动组 + 文件变更 + diff 评论

### F-12-3 工具活动组折叠（M）

**功能**：
- 纯函数 `buildActivityGroups(blocks: BlockMsg[]) → RenderItem[]`（DEC-36）：
  - 连续的已完成 thought/tool 块 → 一个 `{kind:"activity_group", thoughts:n, tools:m, ms:sum}` 项
  - text 块、运行中（status==="pending"/"in_progress"）块独立渲染并截断分组
- UI：活动组渲染为一张 Collapsible 卡（已有 `collapsible.tsx`）：
  - 折叠态：`思考 N 次 · 工具 M 个 · 用时 X 秒`（X = 组内 thought ms 总和）
  - 展开态：组内原块按序渲染（复用现有 BlockView）
- 历史回填消息同样走分组（渲染层统一处理，不区分流式/历史）

**测试**：
- 纯函数 `buildActivityGroups`（vitest：纯 tool 连续段合并 / thought+tool 混合 / text 截断 / 运行中不进组 / 空数组 / 全组）
- 组件：注入含连续 tool 的 turn → 折叠卡出现计数正确 → 点击展开渲染原块（testing-library）

**日志**：
- `logger.debug("chat", "activity-group", {groups: n})`（渲染层 debug 级，防刷屏）

**验收**：
- **AC-P12-10**：一轮内连续 3 个工具调用（无正文穿插）→ 渲染为一张折叠卡「思考 N 次 · 工具 3 个 · 用时 X」→ 通过
- **AC-P12-11**：展开卡片 → 组内工具块按原序完整可见，可再折叠 → 通过
- **AC-P12-12**：工具间穿插正文 → 分组在正文处截断，正文始终可见 → 通过
- **AC-P12-13**：`buildActivityGroups` vitest 全绿（六类边界）→ 通过

### F-12-4 文件变更聚合卡（M）

**功能**：
- 活动组展开态内，tool 块的 diff content 聚合为「文件变更」子卡（DEC-37）：
  - 每个文件一行：文件名 + `+N`（绿）/ `-M`（红）徽标
  - 同路径多次修改合并为一条（行数累加）
  - 点击行 → 展开该文件 diff（复用 DiffView）
- 行数计算 `countDiffLines(oldText, newText) → {added, removed}`：引入 `diff@^9` 的 `diffLines` 实现（DEC-37），纯函数可单测
- 新文件（oldText 空/null）→ 全部记 `+N`；oldText/newText 缺失 → 记 0

**测试**：
- 纯函数 `countDiffLines`（vitest：纯增/纯删/混合/新文件/null 缺失/空串/相同文本）+ `aggregateFileChanges(diffs)`（同路径合并/排序稳定）
- 组件：活动组内含 2 个 diff tool → 文件变更子卡 2 行徽标正确；同路径 2 次修改合并 1 行（testing-library）

**日志**：
- `logger.debug("chat", "file-changes", {files: n})`

**验收**：
- **AC-P12-14**：活动组内 diff 工具 → 文件变更卡显示文件名与 `+N/-M` 徽标，数字与 diffLines 一致 → 通过
- **AC-P12-15**：同文件两次修改 → 合并一行、行数累加；点击行展开该文件完整 diff → 通过
- **AC-P12-16**：`countDiffLines` / `aggregateFileChanges` vitest 全绿 → 通过

### F-12-5 diff 行内评论回传（M，Vibe Kanban 模式）

**功能**：
- DiffView 每行 hover → 行尾浮现评论按钮 → 点击弹 Popover 输入框（已有 popover.tsx）→ 提交后该行标记已评论（高亮左边线 + 底部小标）
- 待发评论集显示在输入框上方条带：「N 条 diff 评论」徽标，点击展开列表可逐条删除
- 发送（DEC-38）：随下一条消息一起或点击徽标「发送评论」单独发 → `composeDiffComments(comments) → string` 确定性组装：
  ```
  [diff 评论 1] <文件路径>:<行号>
  <行内容>
  评论：<评论文本>
  ---
  ```
- 发送成功后评论集清空；会话切换（Tab）评论集随 tabKey 独立

**测试**：
- 纯函数 `composeDiffComments`（vitest：单条/多条/无行号（新文件）/空集）
- 组件：diff 行 hover → 评论按钮出现 → Popover 输入提交 → 徽标计数 +1 → 发送 → user 气泡含组装文本且徽标清零（testing-library）

**日志**：
- `logger.info("chat", "diff-comment-add", {path, line})`；`logger.info("chat", "diff-comment-send", {count})`

**验收**：
- **AC-P12-17**：diff 行 hover 出现评论入口 → 输入提交 → 行标记已评论，输入框上方徽标 +1 → 通过
- **AC-P12-18**：发送评论 → user 气泡含 `[diff 评论] 路径:行号 + 行内容 + 评论` 组装文本，徽标清零 → 通过
- **AC-P12-19**：徽标展开列表可删除单条 → 计数同步 → 通过
- **AC-P12-20**：`composeDiffComments` vitest 全绿 → 通过

---

## 5. P12.3 · 第三批：进度条 + 灵动微交互

### F-12-6a 上下文用量进度条（M）

**功能**：
- 输入框左下常驻窄进度条（宽 ~120px，高 4px，圆角 `--radius-full`），数据 = `store.runtime[t].usage`（`usage_update` 已有链路，无新采集）
- 三态着色（DEC-39）：<80% `--color-primary` / ≥80% `--warning` / ≥100% `--danger`；阈值判定抽纯函数 `usageTier(used,size) → "ok"|"warn"|"danger"`
- 条上 hover Tooltip：`已用 X% · used/size tokens`（已有 tooltip.tsx）
- 无 usage 数据（harness 未上报）→ 不渲染（与元数据侧栏共存，不重复大块信息）

**测试**：
- 纯函数 `usageTier`（vitest：0/50/79/80/99/100/110 边界 + size=0）
- 组件：注入 usage 事件 → 进度条宽度与 tier 类名正确；无 usage 不渲染（testing-library）

**日志**：
- `logger.debug("chat", "usage-bar", {pct, tier})`（tier 跨档时 debug 一条）

**验收**：
- **AC-P12-21**：会话运行中收到 usage_update → 输入框左下进度条实时变化 → 通过
- **AC-P12-22**：used/size ≥ 80% → 琥珀色；≥100% → 红色满条 → 通过
- **AC-P12-23**：hover → Tooltip 显示 `已用 X% · N/M tokens` → 通过
- **AC-P12-24**：`usageTier` vitest 全绿 → 通过

### F-12-6b 灵动微交互（M，横切全局 CSS）

**功能**（DEC-40 五类，全部 CSS 实现，统一走既有 `--motion-*` / `--ease-*` 令牌）：
1. **卡片 hover 抬升**：消息气泡外层、侧栏会话行、面板卡 — hover `translateY(-1px)` + shadow-sm→md，`--motion-fast` + `--ease-out-soft`
2. **按压回弹**：所有 button `:active` `scale(0.98)`，`--ease-out-express`
3. **面板/弹层进出**：提问卡、快问悬浮窗、slash 菜单、Popover/Dialog 内容入场 `fade + zoom(0.96→1) / translateY(4px→0)`（tw-animate-css 类）
4. **悬浮毛玻璃卡**：提问卡与快问悬浮窗升级为「实底 `--bg-2` + `@supports (backdrop-filter: blur(1px))` 叠加 `color-mix` 半透明 + `--blur-panel`」+ `--shadow-pop` + `--radius-lg`（WebKitGTK 渐进增强，不裸奔）
5. **reduced-motion 全局短路**：确认既有 `prefers-reduced-motion` 覆盖新增动画类
- 范围约束：只加过渡与静态样式，不改布局结构；不做共享布局/手势（motion 备选不引入）

**测试**：
- CSS 层不写单测；组件测试断言关键节点带动效类名（`data-motion` 或 animate 类存在）
- 视觉验收：手测 macOS（毛玻璃 + 抬升 + 回弹生效）

**日志**：
- 无新增（纯样式层）

**验收**：
- **AC-P12-25**：提问卡入场有 fade+zoom 过渡（非瞬现）；hover 卡片有抬升阴影过渡 → 通过
- **AC-P12-26**：按钮按压有回弹；弹层关闭平滑（无闪烁）→ 通过
- **AC-P12-27**：`prefers-reduced-motion: reduce` 下全部动效瞬时完成（无过渡）→ 通过
- **AC-P12-28**：提问卡/快问悬浮窗在不支持 backdrop-filter 的环境（模拟）仍可读（实底背景兜底）→ 通过

---

## 6. MoSCoW 汇总

| 级 | 项 |
|---|---|
| M | F-12-1 编辑重试、F-12-2 提问卡、F-12-3 活动组、F-12-4 文件变更卡、F-12-5 diff 评论、F-12-6a 进度条、F-12-6b 灵动微交互 |
| S | 活动组展开态的锚点定位（滚动定位到组内块）、进度条点击跳元数据侧栏 |
| C | 提问卡 schema 化（不同 harness 提问格式适配层） |
| W | motion 引入（共享布局/手势/可中断 spring）、审批权限梯度（所有者裁决不做）、上下文用量环 |

---

## 7. 实施顺序与依赖

```text
P12.1：F-12-1 编辑重试（纯函数先行）→ F-12-2 提问卡（radio-group/checkbox 封装先行）
  → P12.2：F-12-3 活动组（纯函数先行）→ F-12-4 文件变更卡（依赖活动组 + diff 包）→ F-12-5 diff 评论（依赖 F-12-4 的文件卡容器）
    → P12.3：F-12-6a 进度条（独立）→ F-12-6b 灵动微交互（横切收尾，覆盖前面所有新组件）
```

每 F 项独立 commit + 独立验收；纯函数优先落地配 vitest；每 F 项含日志埋点。**直接在 worktree 分支开发**（分支名 `zhubaoduo/feat/p12_edit_lively`），完成后 merge 回 main（--no-ff）。

## 8. 工作量估算

| 项 | 估算 |
|---|---|
| P12.1（编辑重试 + 提问卡） | 1.5 天 |
| P12.2（活动组 + 文件卡 + diff 评论） | 2 天 |
| P12.3（进度条 + 灵动微交互） | 1 天 |
| 回归 + 验收留档 | 0.5 天 |
| **合计** | **约 5 天** |

## 9. 需求追溯

| 功能项 | 溯源 | 验收 |
|---|---|---|
| F-12-1 | 用户裁决（ChatGPT 编辑重试语义） | AC-P12-1…5 |
| F-12-2 | 调研报告 #5（AionUi MessageQuestion + ACP Elicitation） | AC-P12-6…9 |
| F-12-3 | 调研报告 #6（DeepChat messageActivityGroups） | AC-P12-10…13 |
| F-12-4 | 调研报告 #7（AionUi MessageFileChanges） | AC-P12-14…16 |
| F-12-5 | 调研报告 #8（Vibe Kanban review 闭环） | AC-P12-17…20 |
| F-12-6a | 调研报告 #9（Zed usage，所有者裁决改进度条形态） | AC-P12-21…24 |
| F-12-6b | 用户诉求「灵动悬浮 UI」+ DeepChat 动效令牌实践 | AC-P12-25…28 |

## 10. 变更记录

| 日期 | 版本 | 变更 | 决策人 |
|---|---|---|---|
| 2026-09-03 | v1.0 | 初版：6 功能项；DEC-35…40；审批三件套经所有者裁决不纳入 | 所有者+Claude |
