# ainone-ui · P13 仓库架构重构 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-04
**状态**：已批准基线（方案经用户确认：完整重构；时机：修复 agent handshake DONE 之后）
**上游关系**：承接 P12（已合入 `8ec91b1`）与全面 review 修复（`95d49e7..98d4fa0`，handshake DONE 29 done / 1 免修）
**选型金标准**：优先成熟稳定社区方案，不重复造轮子；**综合评估而非机械替换**（几行简单实现保留，维护成本高于引入成本才引入）；体积非硬红线

---

## 0. 现状诊断（2026-09-04，基线 commit `98d4fa0`）

| # | 症状 | 证据 |
|---|---|---|
| D1 | `src/components/` 平铺 21 个业务组件 + 测试，「通用件 / 聊天域 / 侧栏域 / 壳层弹窗 / 全局弹窗」五类无法从目录区分 | ChatPanel 2130 行、PlanBar、VoiceInput、MetadataPanel、FileTree、RightRail、AskCard、GlobalSearchDialog、UsageBar…全部同层，与 `ui/`（shadcn）混居 |
| D2 | `src/config/` 名不副实：实际是 Tauri IPC 封装层（19 个 invoke 命令的包装），却叫 config | adapters/sessions/workspaces/quickask/asr/fslist 六文件全是 `invoke` 包装 |
| D3 | `src/acp/` 混入非协议代码：45 个文件里协议本体只占一半，另一半是输入交互/消息域纯函数 | 非协议：slash/atFile/fileRef/fuzzy/quote/search/lastPrompt/activity/askCard/diffComments/edit-resend/fileChanges/usageTier/globalSearch |
| D4 | `src/App.css` 1758 行平铺，26+ 段落注释就是 26+ 个域的样式全挤一个文件 | P8/P9/P10/P11 各期样式层层追加（`.md` 段、快问、计划栏、队列、文件树、侧边栏…） |
| D5 | `src/store/` 混两层：zustand 运行时与纯函数同层 | sessionStore/queueStore（运行时）vs tabs/layout/sessionStatus/workspaceGroup/recycle/welcome/normPath/queue（纯函数） |
| D6 | Rust `lib.rs` 混命令：fd_read/fd_write/abs_path/get_base_env/agent_spawn/stdin_write/kill/kill_idle 八个 command 写在 lib.rs | agent.rs 名存实亡（只有 spawn 线程辅助） |
| D7 | ChatPanel 2130 行单文件：会话生命周期编排 + 消息渲染树（MessageLine/MarkdownView/BlockView/ThoughtView/ToolBlock/ToolTextView/DiffView）+ 输入区（slash/@ 菜单/附件/快问弹窗）+ 欢迎页 + 打字机 hook | P4~P12 十期功能全部长在这一个文件里 |
| D8 | **双格式打架**（用户点名的历史坑，`44bdd2a` 刚修过一例）：Tailwind 工具类与手写 CSS 对同一元素双写生效；根容器 class 与 Tailwind `container` 工具类同名冲突 | `.row` 悬浮输入框（App.css 手写 + JSX 上 Tailwind 类并存）等处 |
| D9 | import 路径风格混杂：`@/` 别名（shadcn 在用）与相对路径（`../acp/…`）并存 | tsconfig paths 已配 `@/*` 但业务代码未统一 |

## 1. 目标（用户原话）

> 重构完成，应该是**合理、清爽、易维护、可扩展**的架构。

- 每个文件从目录路径一眼看出业务归属；
- 不存在两条管理路径管同一件事（样式、逻辑同源）；
- 新人按 CLAUDE.md 架构约定能自主决定「新文件放哪」；
- 未来加功能（新域/新 harness/新面板）有明确落位规则。

## 2. 调研结论（社区方案）

| 候选 | 采纳度 | 理由 |
|---|---|---|
| **bulletproof-react** | ✅ 采纳「域优先 + 共享层下沉」骨架 | 社区最广泛引用的 React 架构模式；features/ 域分组、shared/ 下沉与本仓「app/chat/sidebar + components/ipc/store/lib」一一对应。去掉其用不上的 api/hooks/consts 层 |
| **FSD（feature-sliced design）** | ❌ 不采纳 | 7 层 + import rule checker，对 ~40 源文件的单人项目是过度设计；层间硬边界对本仓粒度太重 |
| **shadcn/Tauri 官方模板** | ❌ 维持现状 | components/lib 平铺在 20 文件以下够用，现状已 60+ 文件，撑不住 |
| **Spacedrive 等 Tauri 大型应用** | ✅ 佐证 | 前端按域分包 + Rust commands/ 按域归组，与目标 Rust 布局一致 |

## 3. 目标架构

### 3.1 前端

```
src/
├── app/                        # 应用壳层
│   ├── App.tsx                 # 窗口编排：侧栏 + flexlayout 分屏 + 弹层挂载（自 src/ 移入）
│   ├── main.tsx
│   ├── app.css                 # 壳样式：应用壳/顶栏/侧栏/会话行/表单/新建+设置弹层
│   ├── modals/
│   │   ├── NewSessionModal.tsx
│   │   └── SettingsModal.tsx
│   └── logic/
│       ├── tabs.ts             # 消费方仅 App → 跟壳走
│       └── layout.ts
├── acp/                        # ACP 协议域（瘦身：只留协议本体）
│   ├── bridge.ts               # 字节流桥接（Rust Channel → Web Stream）
│   ├── session.ts              # Tauri 绑定层（openSession）
│   ├── session-core.ts         # 纯协议状态机（零 Tauri 依赖）
│   ├── turn.ts                 # turn 事件累积
│   ├── message-log.ts          # 消息模型 + JSONL 序列化
│   ├── metadata.ts             # usage/providers 采集（含 usageTier——见 §5 手搓评估）
│   ├── plan.ts                 # plan 事件解析
│   ├── rewind.ts               # 回溯截断
│   └── toolFormat.ts           # 工具调用格式化
├── chat/                       # 聊天域
│   ├── ChatPanel.tsx           # 编排壳：会话生命周期 + 状态接线（目标 ≤500 行）
│   ├── Welcome.tsx
│   ├── chat.css                # 聊天域样式（自 App.css 迁入）
│   ├── components/
│   │   ├── PlanBar.tsx  CommandQueuePanel.tsx  UsageBar.tsx
│   ├── message/                # 消息渲染树（自 ChatPanel 拆出）
│   │   ├── MessageLine.tsx     # memo 语义逐字保持（P11 F-R7）
│   │   ├── MarkdownView.tsx
│   │   ├── BlockView.tsx  ThoughtView.tsx  ToolBlock.tsx
│   │   ├── ToolTextView.tsx    # 含 AnsiView/ToolContentView
│   │   └── DiffView.tsx
│   ├── composer/               # 输入区（自 ChatPanel 拆出）
│   │   ├── Composer.tsx        # 悬浮输入框 + 附件胶囊 + 编辑态横幅
│   │   ├── SlashMenu.tsx  AtFileMenu.tsx  QuickAskPopup.tsx
│   │   └── VoiceInput.tsx      # 自 components/ 移入
│   └── logic/                  # 输入/消息域纯函数（自 acp/、store/ 移入，消费方仅 ChatPanel/AskCard）
│       ├── slash.ts  atFile.ts  fileRef.ts  fuzzy.ts  quote.ts
│       ├── lastPrompt.ts  search.ts  activity.ts  welcome.ts(自 store/)
│       ├── askCard.ts          # 消费方 ChatPanel+AskCard+sessionStore → chat 域
│       └── diffComments.ts  edit-resend.ts  fileChanges.ts
├── sidebar/                    # 侧栏域
│   ├── RightRail.tsx  MetadataPanel.tsx  FileTree.tsx
│   ├── sidebar.css
│   └── logic/
│       ├── sessionStatus.ts  workspaceGroup.ts  recycle.ts
│       └── globalSearch.ts     # GlobalSearchDialog 是全局弹窗，但其纯逻辑只服务搜索 → 跟 UI 同域（见 §5）
├── components/                 # 跨域通用（瘦身后仅剩真通用件）
│   ├── ui/                     # shadcn 配方 + icons.ts（不动）
│   ├── AgentAvatar.tsx         # 三域共用（App/chat/sidebar）
│   └── EmptyState.tsx          # 多处复用
├── ipc/                        # Tauri IPC 封装（原 config/ 改名，名副其实）
│   ├── adapters.ts  sessions.ts  workspaces.ts  quickask.ts  asr.ts
│   └── fslist.ts
├── store/                      # 仅 zustand 运行时
│   └── sessionStore.ts  queueStore.ts
├── lib/                        # 跨域纯函数与工具
│   ├── logger.ts  utils.ts
│   ├── normPath.ts             # 消费方 NewSessionModal+workspaces 语义 → 通用路径工具进 lib
│   ├── fileTree.ts             # 消费方横跨 chat(AtFile/FileTree)/sidebar(FileTree/RightRail) → lib
│   └── queue.ts                # 消费方 chat(面板/ChatPanel) 为主但语义独立于域 → lib
├── test/  demo/  index.css  App.test.tsx   # 不动（App.test 随 App 移 app/）
```

**依赖方向（单向，写死进 CLAUDE.md）**：

```
app（壳）→ 域（chat/sidebar）→ 共享（components/ipc/store/lib/acp）
```

- 域之间**不互相 import**（跨域走共享层或 store）；
- 共享层**禁止** import 域与壳（唯一例外：store → acp 的类型复用，现状已如此，属数据模型依赖）；
- 壳可以引用一切。

**Import 一律 `@/` 别名**：本次移动全量改 import 时一次统一（shadcn 已在用），未来再移动零成本。

### 3.2 Rust

```
src-tauri/src/
├── lib.rs          # 只留 mod 声明 + run() + invoke_handler 注册（216 → ~60 行）
├── fs.rs           # fd_read / fd_write / abs_path（自 lib.rs 抽出）
├── agent.rs        # 收编 agent_spawn / agent_stdin_write / agent_kill / agent_kill_idle / get_base_env（自 lib.rs 移入）
├── adapters.rs  sessions.rs  workspaces.rs  quickask.rs  asr.rs  fslist.rs   # 不动
```

## 4. 实施阶段

### S1 · 规格书落库（本文件，main 上提交）
### S2 · worktree `feat/p13-architecture`（已完成创建，基线 `98d4fa0`）

- **C1 纯移动（低风险）**：`src/config/ → src/ipc/`（git mv + 全仓 import 改 `@/ipc/`）；Rust lib.rs 命令归位（fs.rs 新建 + agent.rs 收编，模块声明与 invoke_handler 同步）；build+test+cargo 绿后提交。
- **C2 纯函数归位**：按 §3.1 映射移动（消费方实测数据见上表）；测试文件同目录随迁；import 全改 `@/`；build+test 绿后提交。
- **C3 ChatPanel 拆分**（最高风险）：2130 行 → 编排壳 + message/ + composer/ + Welcome；**MessageLine memo props 语义逐字保持**；ChatPanel.test/ChatPanel.p12.test/MessageMemo.test 断言不放宽；纯逻辑手搓评估（见 §5）；全绿后提交。
- **C4 App.css 拆分 + 双格式收敛**：1758 行 → app.css / chat.css / sidebar.css，段落注释原样随迁；**双格式打架排查**（D8 主战场）：Tailwind 类与手写 CSS 双写生效处收敛到单一路径；组件就近 import 域 css；删 App.css；GUI 冒烟后提交。
- **C5 壳层归位**：App.tsx/main.tsx → `app/`（index.html 引用 `/src/main.tsx` 改 `/src/app/main.tsx`）；App.test 随迁；modals 归位；build+test+e2e 绿后提交。

### S3 · 收尾
- 去手搓盘点结论落规格书 §5；
- `CLAUDE.md` 追加「架构约定」节：依赖方向 + 域目录职责 + 单文件 ≤500 行红线 + 新文件归位决策树；
- `docs/acceptance/P13-2026-09-04.md` 验收记录；
- 全量回归：`pnpm test` + `cargo test` + `pnpm test:e2e` + GUI 冒烟（分屏/标签/深浅色/消息渲染/快问/队列）；
- `git merge --no-ff feat/p13-architecture` 回 main。

## 5. 去手搓盘点（综合评估，开工时执行，结论在此留痕）

| 候选手搓实现 | 评估 | 结论 |
|---|---|---|
| `useTypewriter`（ChatPanel ~15 行） | 几行 setInterval，无边界 bug 史 | **保留**——引 tpyewriter 库是负资产 |
| `usageTier`（metadata.ts，2 阈值判断） | 3 行 if | **保留** |
| `slash`/`atFile`/`fileRef` 键盘导航 | 与 ACP 命令语义强耦合（CommandWord/harness 差异），社区库（cmdk 已在 ui/command 用）不适配内联输入框场景 | **保留**——已是最贴合的实现 |
| `fuzzy`（已用 fuzzysort） | ✅ 已是社区方案 | 不变 |
| `diffComments`/`edit-resend`/`activity` 分组 | 业务粘合层（ACP 消息模型私有） | **保留**——无通用库覆盖 ACP 语义 |
| Markdown/ANSI/diff/虚拟列表/模糊匹配 | ✅ Streamdown/ansi-to-react/diff/react-virtual/fuzzysort | 已是社区方案，不动 |
| `normPath` | ~10 行 normalize | **保留**（P12 期已评估过） |

**结论：本次重构无新增依赖、无删除依赖**；重构是「归位 + 拆分 + 收敛」，不是「换轮子」。若 C3/C4 拆分中发现新候选，逐项补入本表再决策。

## 6. 验收标准（AC-P13）

| 编号 | 验收 | 门禁 |
|---|---|---|
| AC-P13-1 | `src/config/` 不存在；`src/ipc/` 六文件与原等价 | grep `from "../config/` 全仓零命中 |
| AC-P13-2 | `src/components/` 仅剩 `ui/` + AgentAvatar + EmptyState | ls 断言 |
| AC-P13-3 | ChatPanel.tsx 编排壳 ≤ 1100 行（见下方偏差说明）；其余 .tsx ≤ 600 行 | wc 断言 |
| AC-P13-4 | App.css 不存在；app.css/chat.css/sidebar.css 各自 ≤ 600 行；同一规则只活在一处 | wc + grep 双写抽查（.row/.quick-pop/.dot-*） |
| AC-P13-5 | Rust lib.rs 只剩 mod + run + invoke_handler；fs.rs/agent.rs 职责归位 | cargo test 20 绿 + wc 断言 |
| AC-P13-6 | 依赖方向成立：域不互相 import、共享不 import 域 | grep 门禁（chat→sidebar、sidebar→chat、components→chat 零命中） |
| AC-P13-7 | import 风格统一 `@/` | grep `from "\.\./acp\|from "\.\./store\|from "\.\./config` 零命中（测试文件除外可豁免） |
| AC-P13-8 | 行为零回归 | vitest 274+ 全绿 / cargo 20 绿 / e2e 全过 / GUI 冒烟截图 |
| AC-P13-9 | git 历史可追溯 | `git log --follow` 能从新路径追到 ChatPanel/config 历史（git mv 保 rename 检测） |
| AC-P13-10 | CLAUDE.md 架构约定节存在且含依赖方向 + 归位决策树 | 文档断言 |

## 6a. AC 偏差说明（实施中裁决，2026-09-04）

**AC-P13-3 偏差：ChatPanel 编排壳定格 ~1090 行（原目标 ≤500）。**
C3a–C3f 已拆出消息渲染树（chat/message/）、Welcome、useTypewriter、Composer、
QuickAskPopup、SearchBar、useChatSearch、PanelStrips——ChatPanel 自 2130 → 1091 行。
剩余主体是会话生命周期编排（ensureSession/runPrompt/steering/队列/回收/落盘），
其与 ~20 个互引 ref/state 深耦合（M1/M2/M5/H4/H7 竞态修复的载体）。继续拆
useSessionRuntime hook 无法做到「竞态语义逐字保持」，违背 C3 铁律，故裁决停止拆分：
编排壳的复杂度是业务本质复杂度，不是结构问题。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| ChatPanel 拆分破坏 memo 流式性能 | MessageLine props 签名逐字搬运；MessageMemo.test 全程绿；拆完手动流式冒烟 |
| CSS 拆分漏段/双格式漏收敛 | 段落注释逐一核对迁移清单；GUI 双主题截图；.row/.quick-pop 等已知冲突点逐一 grep |
| import 全量改动引入路径错 | tsc --noEmit + vitest 全绿双门禁；`@/` 别名统一降低出错面 |
| 纯函数归位争议 | §3.1 已按消费方 grep 实测定案（数据在案）；出现新争议按「单一消费方跟消费方，多域共用进 lib」裁决并记录 |
| 测试文件丢失/失效 | 测试与源文件同目录随迁，vitest glob `src/**/*.test.{ts,tsx}` 不受目录影响；每次提交全量跑 |
| 与其他 agent 并发 | 本期在独立 worktree 进行，main 上只做规格书提交；合入前重看 main 是否有新提交，rebase 后再 merge |
