# P30 需求规格书：窗格焦点保持显示 tab + Ctrl+Tab 窗格内循环切 tab

> 背景：①多窗格分屏下用 Ctrl/Cmd+方向键切焦点，目标窗格会跳到它的第一个 tab（应保持该窗格当前显示的 tab）；②需要 Ctrl+Tab / Ctrl+Shift+Tab 在当前聚焦窗格内向后/向前循环切 tab，并进快捷键面板支持改绑。

## 根因（已实锤，flexlayout-react 0.10.8 源码级确认）

`App.tsx::activateTabsetAndComposer(tabsetId, selectedIdx)` 中：

```ts
const idx = selectedIdx !== undefined && selectedIdx >= 0 && selectedIdx < sel.length ? selectedIdx : 0;
tabKey = sel[idx].getId();
m.doAction(Actions.selectTab(tabKey));
```

焦点键路径（`onFocusMove`）传的是 `curTabset.getSelected() ?? 0` —— **`curTabset` 是源窗格**，不是目标窗格：
- 源窗格 idx=0（单 tab）时，目标窗格被 `selectTab(children[0])` 强切到第一个 tab；
- 源 idx 超出目标 children 范围时兜底成 0，同样跳第一个。

其他踩同一坑的调用点：
- 关闭 tab 的 `retarget`：`activateTabsetAndComposer(nextId)` 不传 idx → 0；
- 鼠标点 tab 条空白/边缘（`paneSwitchFromEvent` 通道 A）：不传 idx → 0；点内容区（通道 B）传 `clickedIdx`，正确。

鼠标路径已部分修过（p20o），本轮一并把「未指定 idx = 不改选中」语义统一掉。

## 1. 需求与验收标准

### R1 窗格焦点切换保持目标窗格当前显示的 tab

**目标**：以屏幕上显示的为准——Ctrl/Cmd+方向键（及任何走 `activateTabsetAndComposer` 的路径）切焦点后，目标窗格显示的 tab 不变，仅激活该窗格并聚焦其输入框。

**方案要点**：`selectedIdx` 语义改为三态——`undefined`/`-1`/越界 = **不改选中**（不调 `selectTab`，只 `setActiveTabset` + focus）；`>=0` 且有效 = `selectTab(children[idx])`。`onFocusMove` 不再传源 tabset 的 idx（传 undefined）。

**验收标准**：
- AC-R1-1：焦点键切到多 tab 窗格，该窗格停留的 tab 与切换前屏幕所见一致（组件测试：mock model 双 tabset，目标 tabset selected=1，切焦点后不产生 selectTab(0)）。
- AC-R1-2：鼠标点窗格内容区仍聚焦被点的 tab（p20o 语义保留，测试锁定）；点 tab 条空白不再跳第一个 tab。
- AC-R1-3：焦点移动后可输入（composer focus 重试链路不变）。

### R2 Ctrl+Tab / Ctrl+Shift+Tab 窗格内循环切 tab

**目标**：聚焦窗格内，Ctrl+Tab 向后切下一个 tab、Ctrl+Shift+Tab 向前切；到头循环。

**方案要点**：
- 纯函数 `tabCycleShortcut(e): "next" | "prev" | null`（layout.ts）：Tab code + 主修饰（ctrl/meta 等价）判定；shift 区分方向。
- 纯函数 `nextTabIndex(count, selected, dir)`：`(selected+1) % count` / `(selected-1+count) % count`（count=0/1 返回原值）。
- keymap 新增两个 pane 作用域条目：`pane.tab-next`（Ctrl+Tab）、`pane.tab-prev`（Ctrl+Shift+Tab），默认表+改绑面板自动获得（P25 体系）。
- App `onKey` 接线：命中 → 取激活 tabset children 与 selected → `selectTab(children[nextIdx])`（flexlayout 自身会把该 tabset 设为 active）+ 聚焦其输入框（复用 activateTabsetAndComposer 传新 idx）。
- 终端 tab 同样参与循环（TerminalPanel 挂载中，仅聚焦方式不同——聚焦不到 textarea 时静默跳过 focus，不阻断切 tab）。

**验收标准**：
- AC-R2-1：`nextTabIndex` 单测锁定循环语义（尾→头、头→尾、单 tab 不动、空 tabset 返回 null 不动作）。
- AC-R2-2：3 tab 窗格内连按 Ctrl+Tab 依序 0→1→2→0；Ctrl+Shift+Tab 反向 0→2→1（组件测试 mock 验证 selectTab 调用序）。
- AC-R2-3：快捷键面板出现「窗格内下一个 tab / 上一个 tab」两行（global 作用域分组），点「改绑」录入新键生效、恢复默认可用。
- AC-R2-4：改绑持久化（keymapStore overrides，同现有机制，无新增持久化代码路径）。

### R3 通用约束

- AC-R3-1：全量 vitest（基线 475+）与 cargo 不回归，tsc 0 错。
- AC-R3-2：改动限 `layout.ts` / `keymap.ts` / `App.tsx` 及对应测试，不动 flexlayout 配置与 Rust 层。

## 2. 分期提交

| 期 | 内容 |
|---|---|
| P30a | R1 焦点保持（三态 selectedIdx + 调用点清理 + 测试） |
| P30b | R2 Ctrl+Tab 循环切 tab（纯函数 + keymap + 接线 + 测试） |
