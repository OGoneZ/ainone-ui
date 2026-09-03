# ainone-ui · P10 窗口与编辑器布局 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-03
**状态**：已批准基线
**上游关系**：承接 `docs/plan-v2.md`（P4–P6）与 `docs/plan-p7-ui.md`（P7 UI 基建）；独立于 P8/P9（会话进阶能力）的新主题期
**选型金标准**：**优先成熟稳定社区方案，不重复造轮子；体积非硬性红线**（本节立于所有后续决策之上）

---

## 0. 目标（一句话）

把「单窗口单 Tab」升级为「**可自由编排的多窗格编辑器**」：窗口有最小尺寸下限；标签页像 Chrome 一样可压缩省略；窗格可左右/上下分屏、拖拽重排、带明显动画提示；输入框悬浮在底部不随滚动、半透明圆角。

---

## 1. 调研结论（2026-09-03 源码核查）

| 项 | 结论 | 依据 |
|---|---|---|
| 窗口最小尺寸 | Tauri v2 `windows[].minWidth/minHeight/maxWidth/maxHeight`（逻辑像素）直接控制；无需 Rust 命令 | `@tauri-apps/cli@2.11.4/config.schema.json:293-330`；当前 `tauri.conf.json` 仅 `width/height` 未设 min |
| 标签页现状 | `.tabs-bar`=flex+overflow-x；`.tab`=button（裸标题文本+关闭钮），无 flex-shrink/min/max 宽度约束 → 文字撑宽标签、标签撑宽窗口 | `src/App.tsx:332`、`src/App.css:221-246` |
| 分屏布局库 | **flexlayout-react 0.10.8**（React 19 兼容）——tab 拖拽 dock/undock、上下左右 split、分隔线 resize、开合动画全内置，免自建；unpacked 1.8MB（体积红线可修订，见 DEC-22） | `npm view`（本机）；**所有者裁决采纳** |
| 输入框现状 | `ChatPanel` 的 `form.row` 在滚动容器 `.chat` 之外，物理上已不随滚动；但无「悬浮」视觉（无半透明/blur/圆角浮层） | `src/components/ChatPanel.tsx:290-441` |

**架构决策**：

- **DEC-21**：窗口尺寸限制用 Tauri 静态配置（`minWidth/minHeight`），不走运行时 setMinSize 命令——这是「配置即声明」的最简路径，无需前端交互。
- **DEC-22**：分屏**采用 flexlayout-react@^0.10.8**，不重复造轮子（选型金标准）。理由：分屏窗格（拖拽 dock/undock、上下左右 split、分隔线 resize、开合动画）是成熟通用能力，自建要重写一套拖拽坐标系 + 命中判定 + 动画，成本高收益低；flexlayout 换取「更好的交互体验 + 更短的交付」是净收益。**体积不设硬红线**。

**开发流程金标准（立本文为据，后续所有开发优先遵循）**：凡遇到通用能力（布局/拖拽/编辑器等），先查成熟稳定社区库，默认采用，而非自建，除非有实质性功能或架构冲突；**体积 20MB 不作为否决项，只作预算参考，可选择更优框架而超之**。
- **DEC-22a**（flexlayout 对接待办）：ChatPanel 挂进 flexlayout 的 tabset（`factory` 按 tab.id = 现有 `tabKey` 渲染）；flexlayout 的 tab 样式与 `--color-*` 变量**映射到本令牌层**（深色随 data-theme 自动换值）；标签「定高/限宽/省略号」由覆盖其 tab CSS 达成（F-10-2）。
- **DEC-23**：分屏快捷键 **Ctrl+D（左右）/ Ctrl+Shift+D（上下）**，新窗格 = **同 harness + 同 cwd 的新会话**（复用 `newTab(activeTab.adapterId, activeTab.workspaceId, activeTab.cwd)`），与 WARP 终端分屏语义一致；不建「同 session 第二视图」（与 F-4-4 单实例约束冲突）。快捷键仅在「编辑器窗格获得焦点时」生效，不拦截输入框按键。
- **DEC-24**：输入框「悬浮」= 底部固定容器（在 `.chat` 滚动容器之外）+ `backdrop-blur(var(--blur-panel))` + 半透明 `color-mix` 背景 + `--radius-lg` 圆角 + `--shadow-pop`，视觉浮在消息流上方；harness 徽标并入该容器。

---

## 2. 功能规格

### F-10-1 窗口最小尺寸限制（M）

- `tauri.conf.json` `windows[0]` 增 `minWidth: 720, minHeight: 480`（侧栏 240px + 内容区 ≥ 480 的保底）。
- 拖拽缩到再小 → 系统强制停住，不允许继续缩小；放大无上限。

### F-10-2 Chrome 式标签页（M）

- 标签**高度恒定**（padding + 行高固定），任何情况下不变高不变矮。
- 每个标签宽度弹性：上限 200px（`flex: 0 1 200px`），窗口变窄/标签变多时**可压缩**，但**下限 80px**；压缩到下限仍放不下 → `.tabs-bar` 横向滚动（已 `overflow-x: auto`）。
- 标题超长 → 尾部省略号（`text-overflow: ellipsis` + `white-space: nowrap` + `overflow: hidden`），**不换行、不撑宽**；关闭钮与头像固定不缩放。
- 标题抽纯函数归一到「不截断字符串、由 CSS 负责省略」，保证可测。

### F-10-3 分屏窗格系统（M，flexlayout-react）

**核心模型**：flexlayout-react `Model`（`{ global, borders[], layout: TabNode|RowNode }`）。每个 tab.id = 现有 `tabKey`（ChatPanel 的唯一键）；`factory` 回调按 tab.id 渲染 `<ChatPanel tabKey=...>`。窗格开合/拖拽 docking 全由 flexlayout 内置。

**3.1 快捷键分屏（第一批，先交付）**
- 编辑器区获得焦点（非输入框）时，**Ctrl+D** → 当前聚焦窗格**左右**切分，新窗格放置**同 harness + 同 cwd 的新会话**；**Ctrl+Shift+D** → **上下**切分。
- 焦点判断：监听 `keydown`，当 `document.activeElement` 不在 `textarea/input` 内才响应；不拦截对话输入。
- 落点：调用 flexlayout `Action.addNode`（相对当前 active tab）在新窗格创建该新 tab，同步 `setTabs`。

**3.2 拖拽分屏 + 动画（第二批，flexlayout 原生）**
- Tab 拖拽 docking：拖 tab 到窗格边缘，flexlayout 内置**半透明入驻预览遮罩**（上/下/左/右切分 + 覆盖）与过渡动画。
- 分隔线拖拽微调比例（row/col splitter）实时反馈，flexlayout 内置。
- 关闭某窗格最后一个 Tab → 窗格与兄弟合并，flexlayout 内置。
- 视觉：flexlayout 的 tab/分隔线/遮罩颜色映射到令牌层变量（深色随 data-theme 自动换值）。

### F-10-4 悬浮输入框（M）

- 输入区（harness 徽标 + 输入框 + 发送/停止按钮）整体**固定在面板底部**，不随消息滚动。
- 悬浮视觉：半透明底色 `color-mix(in srgb, var(--bg-1) 82%, transparent)` + `backdrop-filter: blur(var(--blur-panel))` + `--radius-lg` 圆角 + `--shadow-pop`。
- 深色主题自动换值（`data-theme` → 令牌），无需单独深色规则。

### F-10-5 全量回归保护（M）

- 既有 Latch 能力复验：多 Tab 并行（AC-P2-3）、暗号续聊（AC-P2-4）、closeTab 清理子进程（AC-P2-5）、状态指示切 Tab 不丢（AC-P6-3）、slash 补全（AC-P4-7/8）。
- 全部 vitest + cargo 测试绿；e2e 探针绿。

---

## 3. 测试与日志要求（承接 TESTING.md / P8 §2）

| F 项 | 纯函数（vitest node） | 组件（vitest jsdom） | 日志埋点 |
|---|---|---|---|
| F-10-1 | — | — | —（纯配置，无运行日志） |
| F-10-2 | `tabEllipsis` 相关纯函数（标题归一） | 断言渲染 `.tab` 含 `text-overflow` 类结构、标题 span 存在 | — |
| F-10-3 | **窗格树全操作**：`splitPane/removeTabFromPane/findPaneOfTab/resizePane/collectVisibleLeafs/serialize` 穷举边界 | mock 快捷键 → 分屏后出现两个窗格 + 同 harness 新会话；关闭末 tab 塌缩 | `logger.info("split", "split-pane", {axis, srcTabKey, newTabKey})` + `logger.info("split", "close-merge", {paneId})` |
| F-10-4 | — | 断言输入框容器在 `.chat` 滚动容器外 + 有悬浮类（半透明/blur/圆角） | — |

**铁律**：凡「输入确定→输出确定」逻辑抽纯函数配单测；e2e 探针直接 import 生产代码。

---

## 4. 验收标准（原子、二元可判）

- **AC-P10-1**：窗口拖到 <720×480 → 系统停住无法继续缩小（`tauri.conf.json` 含 `minWidth:720/minHeight:480`，`pnpm build` 通过）→ 通过
- **AC-P10-2**：开 1 个标签 vs 开 20 个长标题标签 → 标签高度**完全一致**；标签多时每个变窄（≥80px），标题尾部省略号，`.tabs-bar` 出现横向滚动；窗口拉宽 → 标签回弹至 ≤200px → 通过
- **AC-P10-3**：Ctrl+D → 当前窗格左右切分，新窗格挂**同 harness 同 cwd 的新会话**；Ctrl+Shift+D → 上下切分 → 通过
- **AC-P10-4**：拖标签到窗格上边缘 → 下半屏出现半透明「上下切分」预览遮罩（动画）；松手完成切分 → 通过
- **AC-P10-5**：拖拽行/列分隔线 → 两侧比例实时变化，松手落定 → 通过
- **AC-P10-6**：关闭某窗格最后一个 Tab → 窗格与其兄弟合并、父节点塌缩、动画收拢 → 通过
- **AC-P10-7**：消息区滚到很下方 → 输入框始终停在面板底部不动，自带半透明 + 圆角 + backdrop 模糊；深色下背景自动换值，文字清晰可读 → 通过
- **AC-P10-8**：焦点在输入框时按 Ctrl+D → **不触发分屏**、正常输入；焦点在编辑器区时生效 → 通过
- **AC-P10-9**：窗格树纯函数 vitest + 组件测试全绿（`pnpm test`）；cargo test 绿 → 通过
- **AC-P10-10**：回归多 Tab/暗号续聊/slash/状态指示中至少多 Tab 并行与 closeTab 清理 2 项 e2e 绿 → 通过

---

## 5. MoSCoW

| 级 | 项 |
|---|---|
| M | F-10-1 最小尺寸、F-10-2 标签页、F-10-3 分屏（快捷键+拖拽+动画）、F-10-4 悬浮输入框、F-10-5 回归 |
| S | 「Ctrl 拖拽=复制窗格」语义、左右箭头滚动 Tab（Chrome 式）、多窗口（真多窗口） |
| W | 同 session 第二视图（冲突 F-4-4）、窗口布局状态持久化、tab 拖出成独立浮窗 |

---

## 6. 实施顺序

```text
第一批（无争议、独立可验）：F-10-1 最小尺寸 → F-10-2 标签页 → F-10-4 悬浮输入框
第二批（重点）：F-10-3 分屏（先落窗格树纯函数+单测 → 快捷键分屏 → 拖拽+动画）
第三批：F-10-5 全量回归 → 验收留档
```

每 F 项独立 commit + 独立验收。

## 7. 工作量估算

| 项 | 估算 |
|---|---|
| F-10-1 + F-10-2 + F-10-4 | 0.5 天 |
| F-10-3 分屏（纯函数 + 快捷键 + 拖拽 + 动画） | 2 天 |
| F-10-5 回归 + 验收 | 0.5 天 |
| **合计** | **约 3 天** |

## 8. 变更记录

| 日期 | 版本 | 变更 | 决策人 |
|---|---|---|---|
| 2026-09-03 | v1.0 | 初版：P10 窗口与编辑器布局（最小尺寸/Chrome 式标签页/分屏/悬浮输入框）；DEC-21…24 | 所有者+Claude |
