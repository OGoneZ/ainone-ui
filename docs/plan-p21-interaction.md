# P21 · 交互体验打磨规格书

> 状态：v1.0（已批准）
> 前置：P13 架构重构已合入 main（a56a46f 后续）。工作区存在未提交改动（H12/H8/H14 语义修复），P21 开工前先单独提交该批修复，P21 全部工作在新 worktree `feat/p21-interaction` 上进行。

## 0. 需求总览（用户原话 → 特性编号）

| # | 用户诉求 | 特性 |
|---|---|---|
| 1 | 「不同 session 在中间聊天区上面的 tab 栏，每一个标题前面也能显示对应 Harness 的 logo」 | F-21-1 |
| 2 | 「不需要一个专门的排队按钮……用户在 agent 执行过程中再发消息，自动触发排队，agent 不断消费」 | F-21-2 |
| 3 | 「排序时容易误合并……没有一个很明确会被吸进去融合的动画预览效果」 | F-21-3 |
| 4 | 「权限审批直接弹一个全屏的，我不知道是什么操作申请权限……在对应 session 自己的聊天窗口里弹出；需要审批时左侧工作区 session 行光晕高亮闪烁提醒」 | F-21-4 |
| 5 | 「输入框的全屏按钮只填满 session window 大小；分屏时只在自己那块屏幕显示」 | F-21-5 |
| 6 | 「左侧工作区和右侧侧边栏，鼠标放到边缘时有拖拽把手，自由拉伸宽度」 | F-21-6 |

## 1. 现状诊断

### D1 · tab 栏无 harness 标识（F-21-1）
- `App.tsx:760-766` 的 `<Layout>` 只传 `model/factory/onModelChange/realtimeResize/onExternalDrag`，未用 `onRenderTab`。
- flexlayout-react 0.10.8 提供 `onRenderTab(node, renderValues)`（`Layout.d.ts:29`），`ITabRenderValues = { leading, content, buttons }`（`LayoutTypes.d.ts:30-37`）——`leading` 槽就是 tab 标题前缀位。
- 头像体系现成：`AgentAvatar`（`src/components/AgentAvatar.tsx`）四层降级（CDN SVG → 本地 5 个 harness SVG → monogram → Bot 图标），注释明确预留「14（Tab 徽标）」尺寸档，当前只用于侧栏行（22）与输入框徽标（16）。
- tab → adapter 反查数据齐备：`tabs` 数组每项含 `adapterId`，`factory` 已示范 `tabs.find(x => x.key === node.getId())`。

### D2 · 排队按钮冗余（F-21-2）
- P16 DEC-50 已落地「busy 时发送自动入队」：`ChatPanel.submit`（L557-564）、`sendSuggestion`、`sendQuotes`、`sendDiffComments` 四条路径 `busy → enqueueCommand`。
- 但 Composer 仍保留独立「排队」按钮（`Composer.tsx:358-375`，`onEnqueue` prop）——与自动语义重复，按钮含义（排队 vs 立即发）让用户困惑。
- 残留不一致：busy 时 placeholder 文案仍是「运行中，输入将打断当前 turn…」（`Composer.tsx:227/312`），与实际「入队不打断」矛盾。

### D3 · 队列拖拽合并误触 + 无吸入预览（F-21-3）
- 现状（`QueueDock.tsx:81-122`）：`onDragOver` 悬停**任意条目**满 600ms 即进入合并候选（`mergeCandidate`）——想插队排序的用户在条目上稍作停顿就被误标为合并；松手即合并，误合并只能事后编辑文本弥补。
- 吸入动画现状：松手后 DragOverlay 只做**原地** `scale(0.35)+opacity 0`（`chat.css .merge-sink`），DEC-50 设计的「transform 到目标中心再收缩」未实现， merger 缺乏「谁吸进谁」的明确指向。
- 候选高亮只有脉冲边框（`.candidate`），无「将合并」的语义图标。

### D4 · 权限审批是全屏 modal（F-21-4）
- 现状：`ChatPanel.tsx:1170-1185` 用 shadcn `Dialog`（Radix portal 到 body + `fixed inset-0` 遮罩）——盖住**整个应用窗口**包括其他分屏窗格与侧栏；用户看不出是哪个 session 在申请什么。
- 数据只存了 `pending: string`（工具标题，`sessionStore.ts:35`），`params.options`（harness 给的权限选项）被丢弃，UI 恒为「允许/拒绝」两键——丢失 `allow_always`（总是允许）等选项。
- 阻塞机制良好无需动：`onPermission` 回调内 `new Promise + permResolver ref`（`ChatPanel.tsx:408-425`），H10 兜底（turn 结束强制 reject）。
- 内嵌卡现成参照：AskCard（F-12-2）——store 存 `ask` 状态 → composer-dock 内渲染卡（`ChatPanel.tsx:1228-1234`）→ resolver resolve。权限卡完全同构。
- 侧栏提醒数据流现成：`deriveStatus` 里 `pending !== null → awaiting_input`（`sessionStatus.ts:21`，优先级最高），侧栏行已有 `status-awaiting_input` 类（左 3px 警告色竖条），无光晕动画。

### D5 · 全屏编辑覆盖整个屏幕（F-21-5）
- 现状：`Composer.expanded` 时 `createPortal(form, document.body)` + `.composer-expanded { position: fixed; inset: 0; width: 100vw }`（`composer.css:219-234`）——覆盖整个 Tauri 窗口，分屏时遮挡邻居窗格。
- Portal 的原因（必须保留约束）：祖先 `.composer-dock` 有 `transform: translateX(-50%)`，fixed 后代包含块被锁死在 dock 内（F-19-2 实测坍塌根因）。
- pane 边界 = `.panel`（`ChatPanel.tsx:1085`，`position: relative; height:100%`）；pane 级 overlay 现成参照：FilePreview 浮层（`.filepreview` absolute 挂 `.panel` 内）。

### D6 · 两侧栏宽度固定（F-21-6）
- `.sidebar { width: 240px }`（`app.css:71`）、`.rightrail { width: 260px }`（`sidebar.css:246`），均写死，无拉伸入口。
- 仓库内现成把手模式：FilePreview 左缘拖宽（`FilePreview.tsx:150-164` pointer capture + `{startX, startW}` ref + clamp；`sidebar.css .filepreview-resize` 6px 热区）——**不引第三方库**，复用此模式符合「自研仅几行不引依赖」金标准。

## 2. 方案

### F-21-1 · tab 栏 harness logo
- `App.tsx` 的 `<Layout>` 增加 `onRenderTab` 回调：
  ```tsx
  onRenderTab={(node, renderValues) => {
    const t = tabs.find((x) => x.key === node.getId());
    const ad = t ? adapterById.get(t.adapterId) : undefined;
    if (ad) renderValues.leading = (
      <AgentAvatar adapterId={ad.id} name={ad.name} brandColor={ad.logo} size={14} />
    );
  }}
  ```
- `adapterById` Map 已存在（`App.tsx:588`），直接复用。
- 样式：`index.css` 现有 `.flexlayout__tab_button` 调整区追加 `.flexlayout__tab_button_leading` 间距规则（logo 与标题 gap ~6px，垂直居中）。
- 不改 model/name 逻辑（renameTab 流程零影响——leading 是渲染回调）。

### F-21-2 · 移除排队按钮，busy 自动入队为唯一语义
- 删除 `Composer.tsx:358-375` 排队按钮；删 `onEnqueue` prop（L42/62）与 `ChatPanel.tsx:1254-1257` 的接线。
- 修正 busy placeholder 两处：「运行中，发送将加入队列」。
- `enqueueCommand`/队列消费链路（runPrompt finally → dequeue）不动——行为本就正确，只删冗余入口。

### F-21-3 · 队列拖拽：中心区判定 + 吸入预览
**判定（防误触）**——合并候选改为双条件：悬停时长 ≥600ms **且** 指针位于目标条目的**中心 50% 区域**（x ∈ [25%, 75%]）：
- `onDragOver` 里读 `e.over.rect`（dnd-kit collision 事件携带激活 rect；条目 rect 通过 `document.querySelector([data-id="${overId}"])` 实测或 event.activatorEvent 换算），指针 x 相对条目宽度落在中带才计时；落在边缘带 = 纯排序意图 → 清计时器与候选态。
- 边缘带 + 中心带的视觉暗示：拖拽进入条目边缘带时该条目上下缘显示 2px 插入指示线（排序落点预览，`insert-line` 类）；进入中心带且满 600ms 后切换为候选脉冲（合并预览）。
- 键盘路径不变：只排序不合并。

**预览（吸入感）**：
- 候选态增强：目标条目脉冲边框之外，左侧序号位替换为 `MergeIcon`（lucide `Merge`/`GitMerge`），颜色 `--primary`。
- 吸入动画真实化：松手合并时，读取目标条目中心坐标与 DragOverlay 当前坐标，给 overlay 内联 style 赋 `transform: translate(dx, dy) scale(0.35)` 初值，下一帧切换到终值（或反向先 translate 到目标位再 scale+fade）——CSS transition 320ms 收尾，落账仍延迟 320ms（现有时序不变）。
- 全部动画沿用 CSS transition（不引动画库，DEC-50 决议延续）。

### F-21-4 · 权限审批内嵌卡 + 侧栏光晕
**数据层**：
- `RuntimeState.pending: string | null` → 扩展为结构化 `perm: { title: string; options: { optionId: string; name: string; kind: string }[] } | null`（`sessionStore.ts`）。`collectSignals`/`deriveStatus` 的 `pending` 判定同步改为 `perm !== null`（`sessionStatus.ts` RuntimeSignal 字段名跟着改，纯函数单测同步迁移）。
- `ChatPanel.onPermission` 回调：`patch(tabKey, { perm: { title: params.toolCall.title ?? "（无标题工具调用）", options: params.options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })) } })`；resolve 值从 `"allow" | "reject"` 改为 `optionId: string`；最终 `find(o => o.optionId === decision)` 兜底 `options[0]`。L12 的 kind 前缀匹配逻辑删除（选项由 harness 全量给出，不再客户端猜）。
- `permResolver` ref 类型同步改。H10 兜底逻辑保留（turn 结束 resolver 悬挂 → resolve options 中第一个 reject 类或第一个选项，并清 `perm`）。

**UI 层**：
- 新组件 `src/chat/components/PermCard.tsx`（AskCard 同款模式）：
  - 渲染在 composer-dock 内（PlanBar 下方、AskCard 同区，`ChatPanel.tsx` 替换原 Dialog 块）。
  - 内容：标题「⚠️ 需要批准执行」+ 工具调用 title（`<code>` 等宽字体，`.perm-code` 样式复用）+ 按钮组（每个 option 一个按钮，按 kind 上色：allow→primary 实底、reject→outline/danger、allow_always 加「（总是）」副文案；顺序按 harness 给定）。
  - 回答后显示「已批准 xxx / 已拒绝」1.2s（AskCard answered 态同款，可选——简化版直接消失，跟 AskCard 不一致无妨；**裁决：直接消失**，审批动作在聊天流中由后续工具调用体现，无需驻留）。
- 删除 `ChatPanel.tsx:1170-1185` 全屏 Dialog（`Dialog/DialogContent/...` import 若无他用一并清理）。
- 样式 `.perm-card` 进 `chat.css`（`.ask-card` 同区，max-width 480px 复用视觉语言）。

**侧栏光晕**：
- `app.css` 的 `.history-item.status-awaiting_input` 追加光晕动画（`awaiting-glow` keyframes：box-shadow 品牌色/警告色呼吸扩散，仿 `.dot-pulse` 写法）；reduced-motion 兜底关闭动画保留静态竖条。
- 状态机已有判定（pending → awaiting_input），零逻辑新增。

### F-21-5 · 全屏编辑限定 pane
- ChatPanel 新增 `expandHostRef = useRef<HTMLDivElement|null>`（挂在 `.panel` 内、`.chat` 之后的 absolute 覆盖层容器 `<div className="composer-expand-host" ref={expandHostRef} />`；CSS `position:absolute; inset:0; z-index: var(--z-modal); pointer-events:none`，子元素 `pointer-events:auto`）。
  - 备选（更简）：不加大容器，直接把 portal 目标设为 `panelRef.current`——`.panel` 已 `position:relative`，`.composer-expanded` 改 `position:absolute; inset:0` 即可。**裁决：取备选**，少一层 DOM；portal 目标通过新 prop `expandPortalTarget?: HTMLElement | null`（state 驱动，挂载后由 ChatPanel 传 `panelRef.current`）传给 Composer。
- Composer 改动：`createPortal(..., expandPortalTarget ?? document.body)`（target 缺省兜底 body，向后兼容测试环境）；`.composer-expanded` CSS 改 `position:absolute; inset:0; width:auto`（去掉 100vw/fixed）。
- ChatPanel 传 `expandPortalTarget={panelEl}`（`const [panelEl, setPanelEl] = useState<HTMLDivElement|null>(null)` + `ref={setPanelEl}` 或 effect 同步）。
- Esc 退出逻辑不变。

### F-21-6 · 两侧栏拖宽把手
- 新纯函数 `src/lib/resize.ts`：`clampWidth(startW, startX, curX, min, max, dir)` → `{ width }`（dir: "left"=右缘把手向左拖增宽 / "right"=左缘把手向右拖增宽；内部即 FilePreview 的 min/max 逻辑提炼，可单测）。FilePreview 现有实现不动（避免扩散改动面；纯函数供新把手用）。
  - 简化裁决：把手组件内联 3 行 clamp 即可，**不新建 lib 文件**——两个把手各一处使用，抽象无收益。FilePreview 模式直接照抄。
- 左 sidebar：`App.tsx` sidebar `<aside>` 内加右缘把手 `<div className="sidebar-resize" role="separator" aria-label="拖拽调整侧栏宽度" onPointerDown.../>`（sidebarOpen 时才渲染；折叠态 28px 栏不渲染）。宽度改 state `sidebarWidth`（默认 240，clamp 200~min(480, 40vw)），inline style 覆盖 CSS 固定宽，持久化 `localStorage ainone-sidebar-width`。
- 右 rightrail：`RightRail.tsx` 加左缘把手（展开态渲染；把手在 `rightrail-collapsed` 不渲染）。宽度 state 默认 260，clamp 220~min(520, 40vw)，持久化 `localStorage ainone-rightrail-width`（并入现有 STORAGE_KEY 结构或独立 key，随实现取简）。
- 把手 CSS：复制 `.filepreview-resize` 模式（6px 热区、col-resize、hover 高亮；sidebar 的放右缘 `-3px`、rightrail 的放左缘 `-3px`）。
- `user-select` 防选中：把手 pointerdown 时 `e.preventDefault()`（pointer capture 已含）。

## 3. 不做什么

- 不改队列 merge 数据语义（文本拼接、位置取较前者不变）。
- 不做审批卡 answered 驻留态（裁决：直接消失）。
- 不动 flexlayout 布局/分屏逻辑、不动 H12/H8/H14 语义修复内容。
- 不为两个把手引入 re-resizable 等第三方库（自研 ~15 行，金标准：不值得引依赖）。
- 不改 FilePreview 既有把手实现。

## 4. 验收标准

| AC | 内容 | 验证 |
|---|---|---|
| AC-P21-1 | 聊天区上方每个 tab 标题前显示对应 harness logo（CDN/本地 SVG 降级链同侧栏）；无 logo 的 harness 显示首字母 monogram | GUI 冒烟截图 + 单测（onRenderTab 回调断言 leading 非 null） |
| AC-P21-2 | 输入区无「排队」按钮；busy 时 Enter/点发送 → toast「已加入队列（第 N 位）」+ 队列徽标 +1；空闲时行为不变；QueueDock「立即发」不受影响 | 组件测试（Composer 无排队按钮、ChatPanel busy 提交入队）+ GUI |
| AC-P21-3 | 拖 A 到 B 的**边缘带** → 仅显示插入指示线，松手 = 排序；拖到 B 的**中心带**悬停 600ms → B 候选脉冲 + Merge 图标，松手 → overlay 飞向 B 中心收缩消失后合并落账；文案按原顺序拼接不变 | GUI 手测 + queue.test.ts 既有断言不放宽 |
| AC-P21-4 | 权限请求不再弹全屏 modal；审批卡出现在**发起请求的 session 窗格**输入框上方，展示工具 title 与 harness 全部选项按钮；点选后按 optionId 回传；其他窗格/侧栏不被遮挡；侧栏对应会话行光晕闪烁（reduced-motion 下静态高亮） | 组件测试（PermCard 渲染选项/回调 optionId）+ sessionStatus 单测迁移 + GUI |
| AC-P21-5 | 全屏编辑只覆盖当前 session 窗格（分屏时另一窗格可见可交互）；Esc 退出；展开态内输入/发送/停止正常 | GUI 冒烟（分屏 + 全屏编辑截图） |
| AC-P21-6 | 左右栏边缘悬停出现拖拽把手（6px 热区 + 高亮），拖动实时改宽；宽度持久化（重启保留）；clamp 范围生效；折叠态无把手 | GUI 手测 + 持久化 key 检查 |
| AC-P21-7 | 回归：`pnpm test` 全绿（274+ 新增）、`cargo test` 绿、e2e 通过、`pnpm build` 零报错 | CI 手动跑 |

## 5. 实施顺序（worktree `feat/p21-interaction`，小步提交）

1. S0：main 工作区未提交修复先提交（H12/H8/H14）→ 切 worktree。
2. S1 = F-21-2（删按钮，最小且独立）。
3. S2 = F-21-1（tab logo）。
4. S3 = F-21-4（PermCard + store 结构化 + 侧栏光晕）。
5. S4 = F-21-3（队列判定 + 动画）。
6. S5 = F-21-5（全屏 pane 化）。
7. S6 = F-21-6（两侧栏把手）。
8. S7：全量测试 + GUI 冒烟 + `docs/acceptance/P21-2026-09-06.md` + merge --no-ff 回 main。

每步 `pnpm build + pnpm test` 绿后提交（conventional commits，无 AI 署名）。
