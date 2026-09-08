# P34 规格需求书：分屏可见性语义修复——失焦窗格白屏回归

> 状态：**已确认**（用户 2026-09-09 报告分屏失焦窗格白屏；要求先调研社区实践再修）。
> 执行分支：`zhubaoduo/perf/p34_visible_semantics`（基于 main @ 98d059c）。
> 性质：**P32 R7 的语义缺陷回归修复**，非新功能。

## 0. 事故与根因（诊断实锤）

**现象**：同页分屏（Ctrl+Shift+D/E）后，焦点切到另一个窗格，原窗格聊天区整块变白。

**根因链**（代码级取证）：
1. `App.factory` 传 `active={t.key === activeKey}`——`activeKeyOf` 是**全局唯一焦点窗格**的选中 tab（layout.ts:238），这是「焦点」语义不是「可见性」语义。
2. flexlayout 的真实可见性规则（dist 源码 `positionTabPanels`）：`visible = node.isSelected()`——**per-tabset** 选中即显示。分屏时两个窗格各自的选中 tab 都在屏幕上。
3. P32 R7 把 `useVirtualizer({ enabled: active })` 绑在了焦点上：失焦窗格 virtualizer 冻结 → `calculateRange` 短路（outerSize=0/enabled=false → range=null）→ `getVirtualItems()` 空 → 可见区消息全部卸载 → **白屏**。
4. R7 修复的原始问题（tabset 内切 tab 的 display:none → rect=0 → 卸载重挂载）真实存在，但绑定对象错了。

**对照正确模型**（用户 2026-09-09 口述确认）：屏幕上显示的窗格无论是否聚焦都应正常显示；优化只应作用于**屏幕之外**的内容（同一 tabset 里被切走的非选中 tab）。子进程/数据永不卸载（LLM 输出不能断）。

## 1. 社区调研结论（2026-09-09，四主题）

| 主题 | 结论 | 对本仓的映射 |
|---|---|---|
| VS Code | 分级策略：Monaco 非激活 tab 保活 model；webview 隐藏默认销毁 iframe，`retainContextWhenHidden` 才保活（suspend 脚本、不能收消息）；官方认可「短暂保活+内存压力卸载」中间态（issue #113507） | 「内容模型保活、渲染按可见性分档」是行业分界线 |
| Chrome 节流 | rAF 在 document hidden 时停摆（2011 起）；**元素级 display:none 不停 rAF**（document 级才停）；intensive throttling 1/min 只作用于整页隐藏 | 本仓 rAF 节流在分屏失焦窗格照常工作；整窗隐藏由平台原生兜底 + turn 结束 flush 兜底（streamCommitThrottle 已有） |
| tanstack virtual | display:none → RO 全 0 → 卸载重绘/死循环是知名坑（#823/#697）；官方解法 = `enabled` 或 `useCachedMeasurements`（隐藏前切缓存） | `enabled` 绑定对象必须是「flexlayout 可见性」而非「全局焦点」；useCachedMeasurements 不采用（enabled 已覆盖，避免多余状态） |
| 多窗格应用 | 无「后台 pane 降频」公开先例；收敛模式：tmux server/client 分离（内容保活+渲染按需）、kitty 被遮挡不画、React 19.2 `<Activity mode="hidden">` = DOM 保留+effects 卸载+更新降优先级 | 不自建降频；保活渲染（rAF 帧级节流已足够） |

**核心共识**：数据/进程层永不卸载，渲染层按「屏幕可见性」分档——可见即全量渲染（rAF 帧率已封顶），不可见才冻结。失焦 ≠ 不可见。

## 2. 改造项

### R1 — 可见性/焦点语义切分（唯一改造项）
- **内容**：
  1. `layout.ts` 新增纯函数 `visibleKeysOf(model): Set<string>`——visitNodes 收集每个 tabset 的 `getSelectedNode().getId()`（= flexlayout 的 visible 判定同源）。鸭子类型，node 可单测。
  2. `App.tsx`：`syncFromModel` 同步 `visibleKeys` state；`factory` 给 ChatPanel 传 `visible={visibleKeys.has(t.key)}`；TerminalPanel 同样传（其 active 语义是切回 re-fit+focus，保持 `active` 不动，不加 visible——终端无虚拟列表）。
  3. `ChatPanel`：props 增加 `visible?: boolean`（默认 true 向后兼容）；`useVirtualizer({ enabled: visible })`；`active` 继续绑焦点（打字机、window 级事件路由、onActiveSession 重抛、回收定时器等——语义不变）。
- **目标**：分屏失焦窗格正常渲染消息（不白屏）；同一 tabset 内被切走的 tab 冻结虚拟计算（保留 R7 性能收益）；切回（selectTab / 激活窗格）后虚拟列表立即恢复。
- **验收标准**：
  - 分屏 + 左右各一个会话 → 点击另一窗格 → 原窗格消息区仍完整渲染（getVirtualItems 非空）。
  - 同一 tabset 切到第二个 tab → 第一个 tab 冻结（enabled=false）；切回 → 恢复渲染。
  - 焦点语义回归：失焦窗格不响应双击 Esc/pane 快捷键/ref-file（activeRef 路径不变）。
- **测试**：
  - `layout.test.ts`：visibleKeysOf 纯函数 4 例（单 tabset、多 tabset 各取 selected、无选中、空布局）。
  - `ChatPanel` 集成：visible 翻转 → virtualizer enabled 断言（渲染项数量随 visible 恢复）。
  - 全量回归：App.test / ChatPanel.test 全绿。

## 3. 提交切分

| 序 | 内容 | commit 前缀 |
|---|---|---|
| 1 | R1 语义切分（layout.ts + App + ChatPanel + 测试） | `fix(chat): ...` |
| 2 | 验收纪要 docs/acceptance/P34-2026-09-09.md | `docs(p34): ...` |

单 commit 修复 + 验收文档，不攒大提交。

## 4. 总验收

1. `pnpm test` 全绿；`pnpm build` 通过。
2. 分屏手动冒烟：左右窗格切焦点无白屏（用户验收项，代码层以测试锁定语义）。
3. 红线：R7 的性能收益不回退（display:none 的 tab 虚拟计算仍冻结）；active 焦点行为不变。
