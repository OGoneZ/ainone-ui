# ainone-ui · P7 UI 基建与视觉改版 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-02
**状态**：已批准基线（所有者裁决：引入框架，废弃「不引组件库」的 DEC-11）
**上游关系**：承接 `docs/plan-v2.md`（P4–P6 已 Latch 至 v0.6.0）；本文档是 P7 的完整规格，写入 plan-v2 作为 DEC-12 与 P7 期

---

## 0. 文档说明

### 0.1 目的

P4–P6 交付了功能层的现代聊天体验，但视觉与交互仍由 958 行手写 CSS（`src/App.css`）+ emoji 图标 + 零动效构成，「古旧感」的根因是缺一层**设计语言基建**。P7 一次性解决：

1. **UI 基建**：引入 Tailwind CSS v4 + shadcn/ui + lucide-react，建立设计令牌（design token）体系，为未来所有设计定调
2. **视觉重构**：把 P4–P6 已交付的功能按 DeepChat/AionUI 验证过的成熟范式重做视觉与微交互层

### 0.2 研究依据（2026-09-02 源码研究结论）

对标仓库：**AionUi**（Electron + React + Arco + UnoCSS）与 **DeepChat**（Electron + Vue + shadcn 风格 + Tailwind 4）。可复用结论：

| 发现 | 来源 | P7 采纳 |
| --- | --- | --- |
| 全局动效令牌：`--dc-motion-fast: 140ms / default: 220ms / slow: 320ms` + 两条缓动曲线 + 模糊档位 + z 轴层级令牌 | DeepChat `style.css` | §F-7-2 |
| 10 级灰阶 + 10 级品牌色阶 + 语义色（`--message-user-bg`、`--thought-gradient`） | AionUi 主题体系 | §F-7-2 |
| thinking 块：13px 浅灰小字、pulse 省略号、完成自动折叠「思考了 Ns」、chevron 0.2s 旋转、浅底圆角卡片左缩进 | 两家一致 | §F-7-5 |
| 消息流 container query：容器 ≥720px 才留 `clamp(80px, 10cqw, 240px)` 双侧留白 | AionUi `messages.css` | §F-7-4 |
| 头像链：ACP registry CDN SVG（内联可随主题换色）→ 本地品牌 SVG → 首字母 monogram → 通用机器人图标 | DeepChat `AcpAgentIcon` / `AgentAvatar.vue` | §F-7-3 |
| `ThemedLogo`：检测 SVG 含 `currentColor` 则用 CSS mask 渲染随主题变色 | AionUi | §F-7-3 |
| 侧栏状态：working=Spin、awaiting=wiggle（3s 周期前 20% 摇一下）、hover 置顶图标 | AionUi `ConversationRow` | §F-7-7 |
| hover 才浮现的操作行（`opacity-0 → group-hover:opacity-100`） | 两家一致 | §F-7-4 |
| 打字机 placeholder（80ms/字）+ 建议 prompt hover 箭头浮现 | AionUi `useTypewriterPlaceholder` | §F-7-6 |
| shadcn 40+ 无头组件（Dialog/Dropdown/Tooltip/cmdk）正好覆盖聊天客户端的标准控件甜点区 | DeepChat | §F-7-1 |
| Arco 教训：重组件库导致持续的 `arco-override.css` + `!important` 之战 | AionUi | 选型否决项 |

### 0.3 MoSCoW 分级与验收约定

沿用 plan-v2 §0.2：M/S/C/W 分级；每条验收原子、二元可判；开发自验 + 所有者复验双签 Latch；patch 版本递增，不占 v1.0.0。

### 0.4 明确不做（W 项汇总）

1. 不做组件库主题定制器/皮肤市场——令牌层定死一套品牌基调
2. 不做移动端/响应式断点适配（桌面单窗口形态，仅 container query 级别的自适应）
3. 不做品牌 VI 重设计（logo/字体采购）——用现有 Inter 字体与默认 shadcn 色板起步
4. 不做流式 Markdown 的 Worker 渲染（DeepChat 的 markstream 方案）——留待性能实测后再议
5. 不改任何协议层/状态层代码——P7 只动视图层与样式层

---

## 1. 技术选型（DEC-12）

### 1.1 决策

**UI 基建采用 Tailwind CSS v4 + shadcn/ui（Radix 系无头组件）+ lucide-react 图标库。**

### 1.2 决策理由

| # | 论据 |
| --- | --- |
| 1 | DeepChat（对标之一）就是这个栈，聊天 UI 的构成（气泡/thinking/diff/流式文本 80% 自定义表面 + 20% 标准控件）已被其验证 |
| 2 | shadcn 组件是**复制源码进仓库**而非运行时依赖：打包体积不变（SM-3 ≤20MB 不受影响），且可任意修改——不会重蹈 AionUi 维护 `arco-override.css` 的覆辙 |
| 3 | cmdk（shadcn Command 组件）直接覆盖 F-4-7 slash 补全菜单的键盘导航/过滤/高亮 |
| 4 | shadcn 的 CSS 变量体系天然就是设计令牌层，可直接映射 DeepChat 的动效令牌 |
| 5 | Tailwind v4 构建毫秒级（Oxide 引擎），HMR 体感与现状无异 |
| 6 | React 19 完全支持（shadcn 现同时支持 Radix 与 Base UI） |

### 1.3 被否决的候选

| 候选 | 否决理由 |
| --- | --- |
| Arco Design（AionUi 的选择） | 视觉风格压制自定义；AionUi 源码中大量 `!important` 对抗框架样式是其代价实证 |
| UnoCSS | 等效于「自己搭 Tailwind」但组件生态空白；AionUi 用它还得配 Arco 才凑齐控件 |
| Panda CSS | 类型安全是亮点但社区规模小，组件要全部自建 |

### 1.4 已识别风险与对策

| 风险 | 对策 |
| --- | --- |
| Tailwind v4 依赖 `@property`/`oklch`/`color-mix`（基线 Safari 16.4+）；Linux WebKitGTK 版本取决于发行版补丁状态（R-3 的实例化） | **M 项前置验证**（F-7-0）：P7 第一件事就是在目标 Linux 发行版上跑冒烟；兜底降级 Tailwind v3（Safari 14.1 基线，shadcn 同样支持） |
| 一次性大改回归破坏 P4–P6 已 Latch 的能力 | 验收含全量回归节（§3 AC-P7-0 系列），逐条复验既有 AC |
| 令牌层被后续代码绕过（重新散落颜色字面量） | 验收含「零字面量」静态检查（AC-P7-10） |

### 1.5 依赖清单（新增）

```text
dependencies:
  tailwindcss ^4.x、@tailwindcss/vite（构建）
  class-variance-authority、clsx、tailwind-merge（shadcn 标配 cn() 工具）
  lucide-react（图标）
  tw-animate-css（shadcn 动画类）
devDependencies:
  shadcn CLI（npx，不入依赖）
Radix 系（@radix-ui/react-dialog、dropdown-menu、tooltip、popover 等，随 shadcn add 逐个引入）
```

---

## 2. 功能规格

### F-7-0 Linux WebKitGTK 前置冒烟（M，Phase 0 阻塞项）

**需求**：在写任何业务代码之前，验证 Tailwind v4 在目标 Linux 环境可运行。

- 用最小 demo（`@property` 声明 + `oklch()` 颜色 + `color-mix()` 各一处）在 Ubuntu 22.04（打过系统更新的 WebKitGTK ≥2.44）与 Debian 12 各打包跑一次 `tauri dev`
- 记录两环境的 WebKitGTK 实际版本与渲染截图入 `docs/acceptance/P7-*`
- **任一环境验证失败 → 执行降级预案**：整体切 Tailwind v3 + shadcn v3 版组件，并记入 §10 变更
- macOS 开发机上的验证不作为本条通过依据

**验收**：
- **AC-P7-0-1**：Ubuntu 22.04 目标机上，含 `@property`/`oklch`/`color-mix` 的 demo 页三处样式全部正确渲染（截图留档）→ 通过
- **AC-P7-0-2**：Debian 12 同上 → 通过
- **AC-P7-0-3**：若降级：`docs/plan-v2.md` §10 已登记降级决定与原因 → 通过

### F-7-1 基建接入（M）

**需求**：完成 Tailwind v4 + shadcn/ui 的工程接入，新旧样式体系可共存过渡。

- Vite 配置接入 `@tailwindcss/vite`；`src/index.css` 建立 `@theme` 令牌层（取代 App.css 的 `:root`）
- `npx shadcn@latest init`：建立 `components.json`、`src/lib/utils.ts`（`cn()`）、`src/components/ui/` 目录
- 按需 `shadcn add`：button、dialog、dropdown-menu、tooltip、popover、command（cmdk）、context-menu、scroll-area、avatar、collapsible、sheet、sonner（toast）
- lucide-react 替换全部 emoji 图标（🔧→Wrench、💭→Brain、🖥→Terminal、▾/▸→ChevronDown/ChevronRight 等）
- 迁移策略：**逐文件改写、每文件可独立验收**；App.css 中的规则被一个文件迁完就删一段，全迁完删文件

**验收**：
- **AC-P7-1-1**：`pnpm build` 产物 CSS 中含 `@property` 声明且构建成功 → 通过
- **AC-P7-1-2**：`src/components/ui/` 下组件均为 shadcn 生成的本地源码（无运行时 UI 库依赖加入 package.json dependencies）→ 通过
- **AC-P7-1-3**：全仓库 grep 无 `🔧|💭|🖥|emoji 占位图标`（源码中的字符串字面量除外）→ 通过
- **AC-P7-1-4**：`src/App.css` 删除且 `pnpm build` 通过 → 通过（迁移完成的定义）

### F-7-2 设计令牌层（M）

**需求**：把 DeepChat/AionUi 的令牌纪律落成我们自己的单一真源，**这是「为未来设计定调」的核心交付物**。

`src/index.css` `@theme` + `:root` 定义（数值即采纳值，来源见 §0.2）：

```css
/* 动效档位（DeepChat 实证数值） */
--motion-fast: 140ms;      /* hover、图标旋转、小交互 */
--motion-default: 220ms;   /* 面板、折叠、下拉 */
--motion-slow: 320ms;      /* 页面级过渡、欢迎页迁移 */
--ease-out-express: cubic-bezier(0.16, 1, 0.3, 1);
--ease-out-soft: cubic-bezier(0.22, 1, 0.36, 1);

/* 表面层级（AionUi 灰阶语义化命名） */
--bg-base / --bg-1(悬浮层) / --bg-2(输入框) / --bg-3(边框) —— 明暗两套值
--text-primary / --text-secondary / --text-disabled

/* 语义色 */
--primary(品牌) / --success / --warning / --danger
--message-user-bg / --thought-bg

/* 模糊与阴影 */
--blur-soft: 8px / --blur-panel: 16px
--shadow-sm / --shadow-md / --shadow-pop

/* z 轴层级（DeepChat 阶梯） */
--z-sticky: 10 / --z-float: 20 / --z-popover: 50 / --z-modal: 100 / --z-toast: 1000

/* 圆角阶梯 */
--radius-sm: 6px / --radius: 10px / --radius-lg: 14px / --radius-full: 999px
```

- 明暗主题沿用现有 `data-theme` 属性机制，双主题各一套令牌值
- **纪律**：组件层禁止出现颜色/时长/缓动/阴影字面量，一律 `var(--*)` 或 Tailwind 语义类

**验收**：
- **AC-P7-2-1**：上述七组令牌全部在 `src/index.css` 定义且被至少一处引用（引用即生效证明）→ 通过
- **AC-P7-2-2**：同一次交互（如折叠动画）在侧栏、消息区、设置页三处的时长与缓动取值一致（抽查断言同一令牌）→ 通过
- **AC-P7-2-3**：切换明暗主题 → 全部令牌换值无残留旧色（肉眼核查 + 截图对比留档）→ 通过

### F-7-3 头像体系（M）

**需求**：F-4-1 的 logo 头像升级为协议原生方案，四层降级链。

- 优先级 1：**ACP registry CDN**（`https://cdn.agentclientprotocol.com/registry/<id>.svg`）拉取 SVG 并内联（内联才能随主题变色），按 adapterId 解析，内存缓存
- 优先级 2：本地品牌 SVG 资产（`src/assets/agent-logos/`，预置 OMP/Pi/Claude Code/OpenCode/Codex）
- 优先级 3：首字母 monogram（品牌色底 + 白字，与 DeepChat `AgentAvatar` 同法）
- 优先级 4：lucide `Bot` 通用图标
- 单色 SVG 检测 `currentColor` → 用 CSS mask 渲染跟随主题文字色（AionUi `ThemedLogo` 方案）
- 组件 `<AgentAvatar adapterId size>`：消息流头像（32px）、输入框徽标（16px）、Tab 徽标（14px）三档
- CDN 不可达时静默降级到优先级 2，无网络延迟感知（缓存 + 默认同步展示本地资产，CDN 命中后升级渲染）

**验收**：
- **AC-P7-3-1**：OMP 会话中 agent 消息左侧显示 OMP logo（CDN 或本地资产）→ 通过
- **AC-P7-3-2**：未配置 logo 的自定义 adapter → 显示名称首字母 monogram，颜色稳定（同 adapter 恒定）→ 通过
- **AC-P7-3-3**：断网启动应用 → 头像全部降级到本地资产/monogram，界面无加载转圈、无破图 → 通过
- **AC-P7-3-4**：深色主题下单色 logo 自动反色为浅色（CSS mask 生效）→ 通过
- **AC-P7-3-5**：消息流 32px、输入框徽标 16px、Tab 14px 三档渲染清晰无锯齿 → 通过

### F-7-4 消息流视觉重构（M）

**需求**：气泡与内容区按两家范式重做，P4 的布局逻辑不变、视觉全换。

- 行对齐：用户 `justify-end` / agent `justify-start`，行内 `[&>div]:max-w-full` 防溢出
- **自适应宽度**：滚动容器 `container-type: inline-size`，内容列 `.chat-surface`（`width: 100%`）；容器 ≥720px 时内容列 `width: calc(100% - clamp(80px, 10cqw, 240px))` 居中——窄窗不留白，宽窗有呼吸感（AionUi 同法）
- 用户气泡：`--message-user-bg` 底 + `--radius-lg` 圆角，最大宽 75%
- agent 消息：无底色全宽，头像在左（32px 圆形），正文 Markdown 排版
- **hover 操作行**：每条 agent 消息底部 hover 浮现复制按钮（`opacity-0 → group-hover:opacity-100`，140ms）；用户消息 hover 浮现重发/删除（S）
- 消息间距节奏：同类消息 8px、异类 20px（紧凑但不粘连）
- 时间戳：每轮首条消息左侧灰色 11px 时间（hover 已有，不新增常驻元素）

**验收**：
- **AC-P7-4-1**：窗口 800px 宽 → 内容列全宽；拖到 1400px → 内容列居中且两侧留白（目测留白约 80–240px 区间）→ 通过
- **AC-P7-4-2**：agent 消息 hover → 底部浮现复制按钮；点复制 → 剪贴板内容与消息全文一致 → 通过
- **AC-P7-4-3**：连续流式输出 200 条 chunk → 滚动跟随不抖动、无布局跳动（回归 AC-P3-5 精神）→ 通过
- **AC-P7-4-4**：用户气泡最大宽度约束生效：发送超长单行文本 → 气泡自动换行不横向撑破 → 通过
- **AC-P7-4-5**：深浅两主题下消息区对比度可读（无浅字浮浅底）→ 通过

### F-7-5 thinking 块重构（M）

**需求**：对齐两家一致范式，替换 P4 的实现。

- 折叠头：Brain 图标 + 标签 + 状态。思考中：`Brain + pulse 动画省略号图标 + 实时计时（12s）`；完成：`已思考 Ns`
- 展开态正文：13px、`--text-secondary` 色、行高 1.7、`--thought-bg` 浅底圆角卡片、左缩进 20px 表示从属
- 完成自动折叠（`status → done` 即收起），展开/收起 chevron 0.2s 旋转（`--motion-fast` + `--ease-out-soft`）
- 多段 thinking 各自独立折叠（P4 已有，保持）
- `prefers-reduced-motion` → 全部动画退化为瞬切

**验收**：
- **AC-P7-5-1**：思考中：省略号图标 pulse 动画 + 秒数实时跳动 → 通过
- **AC-P7-5-2**：思考完成：自动折叠为「已思考 Ns」一行；点击展开 → 卡片样式与缩进正确 → 通过
- **AC-P7-5-3**：展开/收起 chevron 旋转过渡 0.2s（非瞬切）→ 通过
- **AC-P7-5-4**：系统开启「减弱动态效果」→ 全部动画瞬切，功能不损失 → 通过

### F-7-6 欢迎页与输入区重构（M）

**需求**：空态体验对齐 AionUi GuidPage 范式。

- 居中 hero：问候语（P6 已有，保留）+ **打字机 placeholder**（80ms/字循环打出当前 harness 的建议语，光标 `|` 闪烁；`prefers-reduced-motion` 时直接显示全文）
- 输入卡：`--radius-lg` + 边框常态 `--bg-3`、聚焦品牌色 + `--shadow-pop`（浮起感）+ 聚焦过渡 `--motion-default`
- 建议 prompt 列表：hover 时文字变主色 + 箭头图标从左滑入浮现（140ms）
- 首条消息发送 → 输入区以 `--motion-slow` 过渡到底部（transform 动画，非重排）
- 输入区底部工具行：harness 徽标（16px 头像）+ `/` 命令提示 + 发送/停止按钮（圆形，与 AionUi 同款 breathe 呼吸态：停止按钮运行中 box-shadow 脉冲环）

**验收**：
- **AC-P7-6-1**：空会话 → 输入框 placeholder 逐字打出并循环 → 通过
- **AC-P7-6-2**：输入框聚焦 → 边框变品牌色 + 阴影浮起，220ms 过渡 → 通过
- **AC-P7-6-3**：建议 prompt hover → 箭头浮现；点击 → 填入输入框（行为回归 F-4-5）→ 通过
- **AC-P7-6-4**：发送首条消息 → 输入区 320ms 平滑过渡到底部，无闪跳 → 通过
- **AC-P7-6-5**：agent 运行中 → 停止按钮呈呼吸脉冲态；空闲 → 恢复常态 → 通过
- **AC-P7-6-6**：`prefers-reduced-motion` → 打字机直接显示全文、过渡全部瞬切 → 通过

### F-7-7 侧栏与状态视觉重构（M）

**需求**：P5 工作区树 + P6 状态指示按 AionUi `ConversationRow` 范式重做视觉。

- 会话行 leading 槽位状态机（icon 区域 22px）：`working → Loader2 旋转`；`awaiting_input → 贝尔图标 wiggle（3s 周期仅前 20% 摇动，不刺眼）`；`done/idle → 正常图标`
- 会话行 hover：背景 `--bg-hover`（140ms）+ 删除按钮浮现（`opacity-0 → group-hover:opacity-100`）
- 工作区分组头：文件夹图标 + 名称 + cwd 尾部（`--text-secondary` 11px 省略）+ 会话计数徽标；**右键菜单迁移到 shadcn ContextMenu**（新建会话/重命名/移除，键盘可导航）
- 侧栏收起/展开：宽度过渡 `--motion-fast` + `--ease-out-express`（DeepChat 同款曲线）；收起后留 48px 图标栏（S）
- 活跃会话高亮：左侧 2px 品牌色竖条 + `--bg-1` 底
- 全部侧栏入口键盘可达（Tab 聚焦环用 `--primary` 色 2px）

**验收**：
- **AC-P7-7-1**：agent 生成中 → 对应会话行 leading 图标旋转；完成 → 静态图标 → 通过
- **AC-P7-7-2**：权限请求 → 会话行 bell 图标 wiggle 一次可见摇动后间歇（3s 周期）→ 通过
- **AC-P7-7-3**：右键工作区 → shadcn ContextMenu 弹出，↑↓ + Enter 可完成「新建会话」操作 → 通过
- **AC-P7-7-4**：Tab 键从新建按钮开始逐项走完侧栏 → 每项有 2px 品牌色聚焦环 → 通过
- **AC-P7-7-5**：会话行 hover → 删除按钮浮现；离开 → 隐藏；行背景 140ms 变化 → 通过

### F-7-8 弹层体系统一（M）

**需求**：全部浮层迁移到 shadcn 组件，消灭原生 `alert/confirm` 与手写 modal。

- 迁移清单：设置页（Dialog → Sheet 或独立路由）、新建会话选工作区（Popover + Command）、权限审批（Dialog，危险操作 `--danger` 色确认钮）、右键菜单（ContextMenu）、`NewSessionModal`（Dialog + Command 混合）
- 所有弹层动画：进出场 `--motion-default` + `--ease-out-express`，`transform-origin` 从触发点（Radix 原生支持）
- toast（sonner）：错误横幅、复制成功、adapter 不可用提示迁移为 toast，位置右下，3s 自动消失
- 弹层打开时背景 `backdrop-blur: var(--blur-soft)` + 遮罩 `--bg-base/60%`

**验收**：
- **AC-P7-8-1**：grep 全仓库无 `alert(`/`confirm(` 原生调用 → 通过
- **AC-P7-8-2**：权限弹窗从触发位置缩放弹出（220ms），Esc 关闭不误触发背景点击 → 通过
- **AC-P7-8-3**：触发一次错误（如 adapter 命令不存在）→ 右下 toast 出现，3s 自动消失，不遮挡输入框 → 通过
- **AC-P7-8-4**：弹层打开 → 背景模糊 + 遮罩；关闭 → 恢复（回归 AC-P1-3 权限流可用）→ 通过

### F-7-9 图标体系（M）

**需求**：lucide-react 统一全部图标，语义映射表入库。

- 语义映射（写入 `src/components/ui/icons.ts` 集中导出）：agent=Bot、thinking=Brain、工具=Wrench、终端=Terminal、文件=FileText、diff=FileDiff、工作区=Folder/FolderOpen、会话=MessageSquare、状态 working=Loader2、awaiting=BellRing、done=CheckCircle2、用户=User、设置=Settings、发送=ArrowUp、停止=Square
- 尺寸令牌：12/14/16/20/24 五档（`size` prop 强约束），线宽统一 1.75
- 禁止直接 import lucide 散用——统一从 `icons.ts` 取（未来换图标库只改一处）

**验收**：
- **AC-P7-9-1**：全部图标 import 自 `src/components/ui/icons.ts`（grep 无 `from "lucide-react"` 直引，`icons.ts` 本身除外）→ 通过
- **AC-P7-9-2**：同一语义（如「工具」）在消息区、侧栏、设置页三处图标一致 → 通过
- **AC-P7-9-3**：抽查 10 处图标尺寸全部落在五档之内且线宽一致 → 通过

### F-7-10 Markdown 与 diff 视觉升级（S）

**需求**：内容呈现层的观感升级（功能不变）。

- Markdown：字体 `text-[15px]` 行高 1.7、段落间距 0.75em、行内代码 `--bg-2` 底圆角 4px、代码块头部文件名栏 + 复制按钮（hover 浮现）+ 圆角卡片化
- 代码高亮：明暗主题各接一套 highlight.js 主题 CSS（浅=github、深=github-dark，随 data-theme 切换 import）
- diff 视图：增行绿底/删行红底（语义色 10% 透明度）+ 行号列 + 文件名头部 + 等宽字体
- 表格/引用块/链接：链接品牌色下划线 hover 加深；表格斑马纹

**验收**：
- **AC-P7-10-1**：含代码块/表格/引用/链接的回复渲染排版正确（对照 DeepChat 截图目测）→ 通过
- **AC-P7-10-2**：代码块 hover → 右上角复制按钮浮现；点击 → 复制成功 toast → 通过
- **AC-P7-10-3**：明暗主题切换 → 代码高亮主题同步切换，无深底深字 → 通过
- **AC-P7-10-4**：diff 视图增删行底色对比清晰、行号对齐 → 通过

### F-7-11 可访问性基线（S）

- 全部交互元素有可聚焦态（focus-visible 环）；图标按钮带 `aria-label`；`prefers-reduced-motion` 全局短路所有动画；对比度抽查正文 ≥4.5:1

**验收**：
- **AC-P7-11-1**：Tab 遍历主界面全部交互元素无「无法聚焦」死角 → 通过
- **AC-P7-11-2**：DevTools 审查 8 个图标按钮 → 均有 aria-label → 通过
- **AC-P7-11-3**：明暗两主题下正文/背景对比度 ≥4.5:1（抽查 5 处取最小值）→ 通过

### F-7-12 杂项视觉清理（S）

- Tab 栏改为顶部胶囊分段（P5 前遗留的方形 Tab 视觉过时）；窗口标题栏与应用合一（Tauri 无边框 + 自绘控制钮，S）
- 空状态插画：会话历史为空/工作区为空时的 EmptyState 组件（lucide 图标 + 一行文案 + 主行动按钮）
- 滚动条：全局细滚动条样式（8px、透明轨道、hover 加深），`scroll-area` 用 shadcn 组件

**验收**：
- **AC-P7-12-1**：Tab 栏呈胶囊分段样式，活跃 Tab 有底色区分 → 通过
- **AC-P7-12-2**：清空全部会话 → 侧栏显示 EmptyState（图标 + 文案 + 新建按钮）→ 通过
- **AC-P7-12-3**：消息区与侧栏滚动条为细样式且 hover 反馈 → 通过

---

## 3. 全量回归（Latch 保护，M）

P7 是视图层大改，以下既有能力逐条复验（对应原验收编号）：

| # | 回归项 | 溯源 |
| --- | --- | --- |
| AC-P7-R1 | 暗号续聊：重启后历史完整恢复、agent 记得暗号 | AC-P4-4/5 |
| AC-P7-R2 | slash 补全：`/` 弹出、↑↓/Enter/Esc/鼠标全通 | AC-P4-7/8 |
| AC-P7-R3 | 工作区：分组、右键新建、移除归未归组 | AC-P5-1…6 |
| AC-P7-R4 | 状态指示：working 动画、切 Tab 不丢、权限脉冲 | AC-P6-1…4 |
| AC-P7-R5 | 5000 条消息回填 < 2s 且滚动流畅 | AC-P4-9 |
| AC-P7-R6 | 权限弹窗允许/拒绝流不回归 | AC-P1-3 |
| AC-P7-R7 | 多 Tab 并行互不串扰 | AC-P2-3 |
| AC-P7-R8 | 全部既有 vitest 单测绿（不改断言改代码才算通过） | AC-P4-10 |

---

## 4. 实施顺序与依赖

```text
F-7-0 Linux 冒烟（阻塞项，失败则降级 v3）
  → F-7-1 基建接入 + F-7-2 令牌层（同一 PR，地基）
    → F-7-9 图标体系 + F-7-3 头像体系（并行，原子组件）
      → F-7-4 消息流 + F-7-5 thinking（同链路，一个 PR）
        → F-7-6 欢迎页 + F-7-7 侧栏（并行）
          → F-7-8 弹层 + F-7-12 杂项
            → F-7-10 Markdown/diff + F-7-11 可访问性（收尾）
              → §3 全量回归 → Latch
```

迁移纪律：每个 F 项独立 commit；`App.css` 只减不增；任何一步 Linux 冒烟不过即回滚该步。

## 5. 工作量估算

| 项 | 估算 |
| --- | --- |
| F-7-0 冒烟 | 0.5 天（含双发行版打包） |
| F-7-1 + F-7-2 基建与令牌 | 1 天 |
| F-7-3 头像 + F-7-9 图标 | 1 天 |
| F-7-4 + F-7-5 消息流与 thinking | 1.5 天 |
| F-7-6 + F-7-7 欢迎页与侧栏 | 1 天 |
| F-7-8 + F-7-12 弹层与杂项 | 1 天 |
| F-7-10 + F-7-11 收尾 | 1 天 |
| 全量回归 | 0.5 天 |
| **合计** | **约 7.5 个工作日** |

## 6. MoSCoW 汇总

| 级 | 项 |
| --- | --- |
| M | F-7-0 冒烟、F-7-1 基建、F-7-2 令牌、F-7-3 头像、F-7-4 消息流、F-7-5 thinking、F-7-6 欢迎页输入区、F-7-7 侧栏状态、F-7-8 弹层、F-7-9 图标、§3 全量回归 |
| S | F-7-10 Markdown/diff、F-7-11 可访问性、F-7-12 杂项、侧栏收起 48px、用户消息 hover 操作、无边框标题栏 |
| C |（资源允许才做）消息骨架屏 shimmer、ShimmerText 流光等待态 |
| W | §0.4 所列五项 |

## 7. 需求追溯

| 功能项 | 验收条目 | 溯源决策 |
| --- | --- | --- |
| F-7-0 | AC-P7-0-1…3 | §1.4 风险对策 |
| F-7-1 | AC-P7-1-1…4 | DEC-12 |
| F-7-2 | AC-P7-2-1…3 | 研究结论 §0.2 |
| F-7-3 | AC-P7-3-1…5 | DeepChat AcpAgentIcon/AgentAvatar |
| F-7-4 | AC-P7-4-1…5 | AionUi messages.css container query |
| F-7-5 | AC-P7-5-1…4 | 两家 thinking 范式 |
| F-7-6 | AC-P7-6-1…6 | AionUi GuidPage/打字机/呼吸按钮 |
| F-7-7 | AC-P7-7-1…5 | AionUi ConversationRow/wiggle |
| F-7-8 | AC-P7-8-1…4 | shadcn 弹层体系 |
| F-7-9 | AC-P7-9-1…3 | lucide 语义映射 |
| F-7-10 | AC-P7-10-1…4 | DeepChat Markdown 样式 |
| F-7-11 | AC-P7-11-1…3 | 可访问性基线 |
| F-7-12 | AC-P7-12-1…3 | 视觉清理 |
| §3 回归 | AC-P7-R1…R8 | P4–P6 Latch 保护 |

## 8. 变更记录

| 日期 | 版本 | 变更 | 决策人 |
| --- | --- | --- | --- |
| 2026-09-02 | v1.0 | 初版：P7 全规格（选型 DEC-12、13 个功能项、38 条验收、8 项回归、实施顺序、工作量） | 所有者+Claude |
