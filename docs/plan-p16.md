# ainone-ui · P16 工具条与分屏体感修正 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-05
**状态**：已批准基线（用户 2026-09-05 二轮反馈）
**上游关系**：承接 P15（界面体感精修）。5 项小步修正，无新主题期。

---

## 0. 需求总览（5 项）

| # | 需求 | 用户原话锚点 |
| --- | --- | --- |
| F-16-1 | 工具调用条黄底与主题不搭，换协调显示 | 「工具的调用现在整个是一根黄色的条，和整个主题非常不搭」 |
| F-16-2 | 活动组耗时统计把工具调用时间一并算入 | 「思考几次和用时几秒，是不是只统计了思考的时间？把工具调用的时间一并加上，整栏是整段耗时」 |
| F-16-3 | 聊天记录底部不被输入框遮挡 | 「聊天记录显示的底部应该在输入框的上面，要不然输入框可能挡住内容」 |
| F-16-4 | 侧栏拖 session 到已有 session 上 → 识别为分屏（不限于快捷键） | 「按住 session 拖动到一个已有的 session，自动识别这是一个分屏的操作，像 VS Code 和 WARP」 |
| F-16-5 | 连续 Ctrl+D 分屏等分而非二分 | 「连续分屏……是等分的效果，而不是不断二分」 |

---

## 1. 调研与决策

| # | 结论 | 依据 |
|---|---|---|
| F-16-1 | tool-head 弃用 `--warning`（琥珀）染色，改**中性卡**：`--bg-2` 底 + `--text-secondary` 文字 + 运行中才点亮状态色（spinner/成功绿/失败红）。与 activity-group 卡同语言 | DeepChat/VS Code 终端面板工具行均为中性灰；状态色只做点睛不做底色 |
| F-16-2 | `turn.ts` 的 `tool_call` 事件记 `startTs`，`tool_update` 收尾（status 到 completed/error）时封口 `ms`；组耗时 = Σthought.ms + Σtool.ms。纯函数可单测 | 现状 `buildActivityGroups` 只累加 thought 的 ms（activity.ts:34）；tool 块无时间戳字段 |
| F-16-3 | dock 高度可变，固定 120px 预留不可靠 → 改 **ResizeObserver 实测**：dock 高度写入 CSS 变量 `--dock-h`，`.chat` 的 `padding-bottom: calc(var(--dock-h) + 8px)`。零新依赖 | dock 内条带（批注/附件/队列/提问卡）数量动态变化，固定值要么遮挡要么留白过大 |
| F-16-4 | 侧栏拖拽已有 `onExternalDrag` 通道（P15 F-15-3）；本项补**「拖到某个 session 上」的精准语义**：flexlayout 的 drop 预览本就支持叠入 tabset（CENTER）与四边缘（分屏），拖到已有 session 所在窗格的边缘即分屏、拖到中间即叠入——行为与 VS Code 一致，flexlayout 原生提供，无需额外代码；仅需验证 drop 到「tab 标题条」也走同一通道 | flexlayout TabSetNode.drop/RowNode.drop 源码已核（dist/index.js 93935+/10632）；P15 已实测叠入，边缘分屏同一通道 |
| F-16-5 | 二分根因：flexlayout `RowNode.drop` 新节点 `setWeight(size/3)`、TabSetNode.drop 同向 `setWeight(this.getWeight()/2)`——都是**切割现有重量**而非均分。修法：分屏动作后调用 `Actions.adjustWeights` 把根 row 同向子树权重均分。抽纯函数 `equalizeSplitWeights` 可单测 | 用户要 VS Code 式等分；flexlayout 无内置「均分」选项 |

**DEC-48**：工具条中性化（状态色点睛）。**DEC-49**：组耗时 = 思考 + 工具全段。**DEC-50**：dock 高度 ResizeObserver 实测注入 `--dock-h`。**DEC-51**：拖拽分屏依赖 flexlayout 原生 drop 语义（叠入/边缘），不另造通道。**DEC-52**：每次分屏后同向均分权重。

---

## 2. 各 F 项规格与验收

### F-16-1 工具条中性化（S）

**功能**：`.tool-head` 改 `--bg-2` 底 / `--text-secondary` 字；`.status` 运行中 `--primary`、completed `--success`、error `--danger`；`.tool-body` 保持 `--bg-2`。

**验收**：
- **AC-P16-1**：工具条无琥珀底色，视觉与活动组卡/文件树一致（中性灰阶）→ 通过
- **AC-P16-2**：运行中工具状态字为品牌色，完成后转绿 → 通过

### F-16-2 组耗时含工具（M）

**功能**：
- `BlockMsg` tool 变体增可选 `startTs`/`ms`（持久化兼容：缺省按 0 计，不参与累加）
- `turn.ts`：`tool_call` 记 `startTs`；`tool_update` status 进入 completed/error 时 `ms = now - startTs`
- `buildActivityGroups`：`ms = Σ(thought.ms ?? 0) + Σ(tool.ms ?? 0)`

**测试**：turn 纯函数（tool_call→update 封口）、activity 纯函数（混合累加）各 2-3 例

**验收**：
- **AC-P16-3**：思考 2s + 工具 5s → 组头显示「用时 7 秒」→ 通过
- **AC-P16-4**：重启回填历史（含 ms 字段的日志行）耗时保持 → 通过

### F-16-3 dock 遮挡修复（S）

**功能**：ChatPanel 挂 ResizeObserver 测 `.composer-dock` 高度 → `--dock-h`；`.chat{padding-bottom: calc(var(--dock-h) + 8px)}`；初始值 120px 兜底。

**验收**：
- **AC-P16-5**：滚到底部最后一条消息完整可见，不被输入框遮挡 → 通过
- **AC-P16-6**：展开批注卡/附件胶囊（dock 变高）→ 预留随之增大，仍不遮挡 → 通过

### F-16-4 拖拽分屏确认（S）

**功能**：验证 + 补充文档；若拖到 tab 标题条不触发 flexlayout drop 预览，则在 tabset 层补 drop 目标（预期不需要）。

**验收**：
- **AC-P16-7**：侧栏拖 session 到已有窗格**左/右/上/下边缘** → 实时预览 + 松手分屏 → 通过
- **AC-P16-8**：拖到窗格中央/标题条 → 叠入为同窗格第二个 tab → 通过

### F-16-5 连续分屏等分（M）

**功能**：
- 纯函数 `equalizeSplitWeights(rootRowJson, orientation): Action[]`：找到根 row（或指定子树）中同向 row 的直接子节点，生成 `Actions.adjustWeights`（或逐 `setWeight`）均分
- `splitCurrent` 成功后调用；`handleExternalDrag` 的 onDrop 后也调用
- 深层嵌套只均分**本次新增节点所在层级**

**测试**：纯函数（2 节点 50/50、3 节点 1/3、不同向不均分）

**验收**：
- **AC-P16-9**：连按 Ctrl+D 三次 → 三窗格宽度相等（±2px）→ 通过
- **AC-P16-10**：先 Ctrl+D 左右再 Ctrl+Shift+D 上下 → 上下两格等高分屏，左右列宽不受影响 → 通过

---

## 3. 排期

```text
P16.1 F-16-1 工具条配色 → F-16-2 组耗时（turn.ts + activity.ts）
P16.2 F-16-3 dock 实测高度 → F-16-4 拖拽分屏验证 → F-16-5 等分纯函数
```
