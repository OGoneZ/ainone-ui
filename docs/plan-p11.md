# ainone-ui · P11 输入交互与布局体验 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-03
**状态**：已批准基线（快捷键分配与 ! 语义经所有者裁决）
**上游关系**：承接 `docs/plan-p8.md` / `docs/plan-p9.md`（已交付）；P10（flexlayout 多窗格）独立进行中，本文件不依赖、不冲突 P10 的窗格模型（P11 改造的是 ChatPanel 内部与 App 壳布局，P10 未来接入时替换壳）

---

## 0. 需求总览（9 项）

| # | 需求 | 优先级 | 归属期 | 备注 |
| --- | --- | --- | --- | --- |
| F-11-1 | slash 补全：键盘翻页滚动跟随 + 模糊匹配 | P1 | P11.1 | fzf/zoxide 风格 |
| F-11-2 | 全局 session 搜索（Ctrl+F 悬浮） | P1 | P11.1 | 会话内搜索改 Ctrl+Shift+F（所有者裁决） |
| F-11-3 | `@` 文件选取补全 | P1 | P11.1 | 参考社区实现（Claude Code/Codeium 风格） |
| F-11-4 | `!` 命令注入 Agent 上下文并执行 | P2 | P11.1 | **先 spike 再定执行方**（所有者裁决） |
| F-11-5 | 分叉后自动跳转新会话 + 历史加载 | P1 | P11.2 | 修 bug |
| F-11-6 | 批注悬浮窗失焦自动关闭，删「关闭」按钮 | P1 | P11.2 | 修交互 |
| F-11-7 | 元数据 + 文件树收进右侧侧边栏（tab 切换） | P1 | P11.3 | 参考 AionUi |
| F-11-8 | 布局固定：仅聊天消息区滚动 | P1 | P11.3 | 修布局 |
| F-11-9 | 顶部「上一条指令」折叠气泡 + 点击回跳 | P2 | P11.3 | 长会话定位 |

**排期图谱**：

```text
P11.1 输入交互（F-11-1 → F-11-2 → F-11-3 → F-11-4 spike+实施）
  → P11.2 行为修复（F-11-5 → F-11-6）
      → P11.3 布局重构（F-11-7 → F-11-8 → F-11-9）
```

---

## 1. 调研结论（2026-09-03 源码核查）

| 项 | 结论 | 依据 |
|---|---|---|
| slash 键盘不跟随 | `.slash-menu`（max-height 240 + overflow-y:auto）没有 scrollIntoView；slashIdx 循环移动但高亮项滚出可视区后菜单不滚动 | `src/App.css:336-344`、`src/components/ChatPanel.tsx:876-897` |
| slash 匹配算法 | `filterCommands` 只做「前缀→包含」两段排序，无子序列/相邻性评分 | `src/acp/slash.ts:17-29` |
| 模糊匹配参考 | fzf/zoxide 核心是「子序列匹配 + 打分排序」：连续命中加分、词首加分、间隔惩罚。实现为纯函数（零依赖自研 ~60 行，避免引 fzf.js 这类无维护度库；P10 选型金标准里「成熟库优先」对**交互框架**成立，对 60 行纯函数自研更简单可控） | fzf algo 文档；zoxide 源码 |
| Ctrl+F 冲突 | ChatPanel 已把 Cmd/Ctrl+F 绑给「会话内内容搜索」（F-9-2）；全局搜索需求与其冲突 → **所有者裁决：全局搜索占 Ctrl+F，会话内搜索改 Ctrl+Shift+F** | `src/components/ChatPanel.tsx:203-212` |
| 全局搜索数据源 | `sessions_list`（Rust sessions.json）已含 session_id/title/cwd/adapter_id/workspace_id/mtime_ms；标题即「首条消息前 40 字」，搜标题=搜话题。前端拉全量后本地过滤（会话数 <千级，线性过滤足够） | `src/config/sessions.ts`、`src-tauri/src/sessions.rs` |
| cmdk 已在依赖 | `cmdk@1.1.1`（shadcn Command 封装在 `src/components/ui/command.tsx`）自带模糊过滤+键盘导航+滚动跟随，但它是 Listbox 模型，**不适合**输入框内联补全（slash/@ 需要保留输入文本原样、光标位置语义）；适合**全局搜索弹层**。决策：slash/@ 用自研纯函数 + 现有 `.slash-menu` 结构；全局搜索用 shadcn CommandDialog | `package.json:26`、`src/components/ui/command.tsx` |
| @ 文件选取现状 | 已有 FileRef 体系（P8 F-8-3）：按钮选文件→附件胶囊→`@file:/abs/path` 注入发送文本；FileTree 已能 `workspace_list_dir` 列目录。缺的是「输入 `@` 时联想文件路径」 | `src/acp/fileRef.ts`、`src/components/FileTree.tsx` |
| ! 命令现状 | 无任何实现。ACP `session/prompt` 只传文本，harness 在 ACP 通道下是否解释 `!` 前缀未知 | `src/acp/session-core.ts:177-194` |
| 分叉不跳转根因 | `doFork` 拿到新 sessionId 后只调 `onFork`（写索引），没有让 App 新开/激活对应 Tab，也没有把新会话日志读进当前视图 → 用户看到「上下文已恢复，历史消息未找到」（新 sessionId 无 JSONL 日志） | `src/components/ChatPanel.tsx:367-388`、`src/App.tsx:145-155` |
| 批注悬浮窗根因 | `.quick-pop` 是绝对定位 div，无失焦监听；「关闭」按钮是唯一出口 | `src/components/ChatPanel.tsx:664-725` |
| 页面整体滚动根因 | `.container` 无 `overflow:hidden`；侧栏 `.sidebar` 自身 overflow-y:auto 但内容超高时推挤 `.workspace`；Tab 内容里 FileTree/队列面板等在 `.panel` flex 链里把 `.chat`（flex:1）压到内容高度 → 整页变长产生 body 滚动 | `src/App.css:14-19,68-80,263-274` |
| 元数据/文件树现状 | MetadataPanel 独立右栏（可折叠）；FileTree 在输入框下方条带（可折叠）——两者分居两处 | `src/components/MetadataPanel.tsx`、`src/components/FileTree.tsx` |

**架构决策**：

- **DEC-25**：模糊匹配**采用 fuzzysort@4**（0 依赖、<1KB gzip、周下载 ~10M、TypeScript 内建类型、2026-08 仍在维护），不重复造轮子（金标准修订）。首版自研 60 行评分器被 fuzzysort 替换：评分（连续/词首/起始位置）内置且经过大规模实战校准；`threshold: -Infinity` 全收 + 按分数排序（v4 默认 0.5 阈值会丢弃弱子序列命中，对文件路径导航仍有价值）。候选库否决记录：fuse.js（6.8KB+，面向自然语言字段，路径评分差）、microfuzz（社区规模小）、fzf.js（无维护）。
- **DEC-26**：快捷键分配：**Ctrl+F = 全局 session 搜索**（App 层监听，悬浮顶部弹层）；**Ctrl+Shift+F = 会话内内容搜索**（ChatPanel 层监听，改绑）。两层互不拦截。
- **DEC-27**：全局搜索弹层用 shadcn `CommandDialog`（cmdk，成熟方案），顶部悬浮定位（top: 12% 居中），数据源 = `sessions_list` 全量 + `fuzzyScore` 过滤排序；回车/点击 → 复用 `resolveHistoryOpen` 打开会话 Tab。
- **DEC-28**：`@` 文件选取复用 FileRef 体系：输入 `@` 触发文件联想菜单（对 cwd 递归目录索引，懒加载 + fuzzy 过滤），选中 → 当前光标处插入 `@file:/abs/path ` 附件语义文本；发送时既可作为附件胶囊（复用 files state）也可留在文本中。首个 `@` 语义与 Claude Code 对齐：**引用文件**，不是上传。
- **DEC-29**：`!` 命令执行方 **由 spike 实测裁决**（e2e 探针分别给 claude-agent-acp / omp / pi-acp 发 `!ls` 类 prompt，看返回是否含执行结果）。spike 结论分支：a) 任一 harness 执行 → 原样透传，客户端不预执行；b) 均不执行 → 客户端本地执行（Rust 新增 `exec_in_cwd` 命令，捕获 stdout/stderr，把「$ cmd + 输出」拼进 prompt 文本发给 harness，且 prompt 中明确标注这是本地命令输出）。spike 报文存档 `docs/protocol-samples/`。
- **DEC-30**：分叉跳转走「App 编排」：ChatPanel.doFork 成功后回调 `onFork`（现有），新增回调 `onForkNavigate(newSessionId)` → App 用 `resolveHistoryOpen` 语义新开 Tab（sessionId=新 id、resumeSessionId 注入）并激活；新 Tab 挂载后 ChatPanel 既 `session/load` 恢复 harness 上下文，又 `logRead` 回填 UI——「历史消息未找到」的正解是 **fork 后把父会话日志复制为新 sessionId 的 JSONL**（Rust 新增 `log_copy(from,to)`，上下文与 UI 历史同时成立）。
- **DEC-31**：批注悬浮窗（quick-pop）改为「点外关闭」：document mousedown 监听 + ref outside 判定；「关闭」按钮删除；Escape 也可关。选中文本重新框选时重定位。
- **DEC-32**：右侧侧边栏（RightRail）单容器多 tab：`元数据` / `文件` 两个 tab（AionUi 风格），折叠态收为细栏杆（沿用 MetadataPanel 的 railing 交互）；开合状态持久化 localStorage。MetadataPanel 与 FileTree 改造为 tab 内容组件，布局位置从 ChatPanel 内移到 App 壳（与左栏对称）。
- **DEC-33**：布局固定 = 壳级约束：`html,body,#root,.container` 全链 `height:100%` + `.container` `overflow:hidden`；`.workspace`/`.tabs-area`/`.panel` 保持 `min-height:0` 的 flex 收敛；唯一滚动容器 = `.chat`（消息区）+ `.sidebar`（左栏，自身内容滚动）+ 右栏内容区。侧栏/顶栏/Tab 栏/输入区一律不滚。
- **DEC-34**：「上一条指令」= 消息列表中最后一条 user 消息。滚动位置不在底部时，顶部悬浮折叠气泡（单行省略，最多一个气泡高度）；点击 → `scrollToIndex(lastUserIndex, align:"start")`；滚到底部自动隐藏；新指令发出时刷新指向。

---

## 2. 统一测试与日志要求（每 F 项强制）

承接 `TESTING.md` 分层。**每个 F 项的「完成」定义 = 功能 + 测试 + 日志三件齐全**，缺一不可通过验收。

### 2.1 测试矩阵（防回归）

| 层 | 手段 | 覆盖 | 命令 |
|---|---|---|---|
| 纯函数 | vitest（node） | `fuzzyScore`/`filterFuzzy`/`lastUserIndex` 穷举边界 | `pnpm test` |
| 组件交互 | vitest + jsdom + testing-library，`mockIpc` + `vi.mock(openSession)` | 键盘导航/失焦/弹层/tab 切换 | `pnpm test` |
| Rust 逻辑 | cargo test | `log_copy` / `exec_in_cwd`（视 spike） | `cd src-tauri && cargo test` |
| 协议 e2e | bun 探针（复用生产 session-core） | `!` 语义 spike | `pnpm test:e2e` |

**铁律**：凡「输入确定 → 输出确定」的逻辑必须抽纯函数并配单测；e2e 探针直接 import 生产代码，不写第二份副本。

### 2.2 日志埋点

- 前端走 `logger`（`src/lib/logger.ts`，scope 前缀），Rust 走 `log::`。
- 每个 F 项入口 → 中间状态 → 结果/失败各一条。

---

## 3. P11.1 · 第一批：输入交互

### F-11-1 slash 补全：翻页跟随 + 模糊匹配（M）

**功能**：
- `fuzzyScore(needle, haystack)`（DEC-25）进 `src/acp/fuzzy.ts`；`filterCommands` 改用之，按分数降序，null 过滤
- 键盘 ArrowDown/ArrowUp 移动高亮时，当前项 `scrollIntoView({ block:"nearest" })`（菜单容器内滚动，不滚页面）
- 菜单打开时默认高亮第 0 项（现状 -1 需两次按键的问题一并修）
- Mouse hover 不同步高亮（键盘/鼠标双轨，回车永远取当前高亮或第 0 项）

**测试**：
- 纯函数 `fuzzyScore`（vitest：精确/子序列/连续加成/词首加成/不匹配 null/空 needle）
- `filterCommands` 更新用例：`clr` 命中 `clear` 排在 `xxclxxr` 前；大小写不敏感
- 组件（jsdom）：打开 slash 菜单 → ArrowDown × N → 断言 `aria-selected` 项 `scrollIntoView` 被调用（mock）；断言首项默认高亮

**日志**：
- `logger.debug("chat", "slash-filter", {query, hits})`（输入时）；选中时 info `slash-pick`

**验收**：
- **AC-P11-1**：slash 菜单项多于可视高度，键盘 ArrowDown 走到视口外 → 菜单自动滚动让高亮项可见（页面不滚）→ 通过
- **AC-P11-2**：输入 `/clr` → `clear` 排第一（连续+词首命中），输入 `/cmp` → `compact` 等子序列命中出现 → 通过
- **AC-P11-3**：菜单打开瞬间第 0 项已高亮，直接 Enter 即选中 → 通过

### F-11-2 全局 session 搜索（M，Ctrl+F）

**功能**：
- App 层快捷键 Ctrl/Cmd+F（DEC-26）→ 顶部悬浮弹层（shadcn CommandDialog，`top: 12%` 水平居中，遮罩点击关闭）
- 数据源：`sessions_list()` 全量；条目渲染：标题 + harness logo（复用 AgentAvatar）+ 工作区尾段 + 相对时间（mtime）
- 过滤：`fuzzyScore` 对 title（主）+ cwd（辅）打分排序；空查询 = 最近 mtime 前 20 条
- 回车/点击 → `resolveHistoryOpen` 打开/激活 Tab，弹层关闭；Esc 关闭
- ChatPanel 会话内搜索改绑 Ctrl+Shift+F（文案与快捷键同步更新）

**测试**：
- 纯函数：`filterSessions(entries, query)`（fuzzy 过滤 + mtime 排序 + 空查询截断 20）
- 组件：mock sessions_list → Ctrl+F 打开 → 输入关键词 → 命中渲染 → Enter → `resolveHistoryOpen` 被调（spy）
- 回归：ChatPanel 测试中 Ctrl+F 改为不再打开会话内搜索；Ctrl+Shift+F 打开

**日志**：
- `logger.info("search", "global-open", {})` / `global-jump {sessionId}` / `global-close`

**验收**：
- **AC-P11-4**：任意界面按 Ctrl+F → 顶部 12% 处悬浮搜索弹层（非贴边平铺），列出最近会话（logo+标题+时间）→ 通过
- **AC-P11-5**：输入模糊关键词（如 `acs` 命中 `ainone acp session`）→ 结果按相关度排序；点击/回车 → 对应会话 Tab 打开并激活，弹层关闭 → 通过
- **AC-P11-6**：Ctrl+F 不再触发会话内搜索；Ctrl+Shift+F 打开会话内搜索，原 Enter/Shift+Enter 导航不变 → 通过

### F-11-3 `@` 文件选取补全（M）

**功能**：
- 输入框中键入 `@`（词首，即前面是空白或行首）→ 弹出文件联想菜单（与 slash 菜单同结构）
- 数据源：cwd 目录递归索引（懒加载：先一层，展开按需；Rust `workspace_list_dir` 复用 + 前端递归扁平化为相对路径列表，排除清单复用 `EXCLUDED_DIRS`），上限 500 条防大仓卡顿
- 过滤：`@` 后文本 fuzzy 过滤（DEC-25），展示相对路径 + 目录/文件图标
- 选中 → 把 `@file:/abs/path ` 插入输入文本（`@` 起点到光标处替换）；同时把该文件加入附件胶囊（复用 FileRef/files state，发送走既有 `composeFileReference`）
- 键盘：↑↓ 循环、Enter 选中、Esc 关闭；与 slash 互斥（`/` 只认行首、`@` 只认词首）

**测试**：
- 纯函数：`detectAtToken(text, caret)` → `{ query, start, end } | null`（词首判定/嵌套替换边界）；`flattenTree(entries, prefix)` 递归扁平化 + 排除清单
- 组件：输入 `@re` → 菜单出现含 `README.md` → Enter → 输入框文本含 `@file:/…/README.md`、附件胶囊出现

**日志**：
- `logger.debug("chat", "at-filter", {query, hits})`；选中 info `at-pick {path}`

**验收**：
- **AC-P11-7**：输入 `@` → 弹出文件联想菜单（cwd 相对路径，node_modules/.git 等不出现）→ 通过
- **AC-P11-8**：输入 `@read` → `README.md` 排前（fuzzy）；Enter → 输入框插入 `@file:/abs/path ` + 附件胶囊出现；对 agent 发送后 agent 可读到该文件（harness 语义不变）→ 通过
- **AC-P11-9**：`@` 在词中（如邮箱 `a@b`）不触发；Esc 关闭菜单 → 通过

### F-11-4 `!` 命令注入（M，spike 先行）

**功能（F-11-4a spike，阻塞实施）**：
- e2e 探针 `tools/spike/e2e-p11-bang-probe.ts`：对 claude-agent-acp / omp / pi-acp 各发 `!echo hello-ainone` 与 `!ls`，捕获 assistant 回复，判定是否出现命令执行痕迹
- 报文存档 `docs/protocol-samples/sample-bang-*.json`；结论写入 §7

**功能（F-11-4b 实施，按 DEC-29 分支）**：
- 分支 a（harness 解释）：无客户端改动，输入 `!` 仅做提示文案（「命令将交由 harness 解释」）
- 分支 b（客户端执行）：输入框行首 `!` → 本地执行确认气泡（命令回显 + 执行/取消）；确认后 Rust `exec_in_cwd(cwd, command)` 执行（超时 30s、截断输出 64KB、不跨 shell 注入——argv 直传）；输出组装为：
  ```
  [本地命令] $ <cmd>
  <stdout/stderr 截断>
  ```
  随用户后续问题一起进 prompt（或单独 turn 直接发送，实施时定）；消息流中该条 user 消息折叠显示「$ cmd」+ 可展开输出
- 两种分支都：`!` 无确认不执行；运行中输入 `!` 走既有 steering 队列

**测试**：
- spike 探针本身（e2e）
- 分支 b：Rust `exec_in_cwd` cargo test（正常/不存在命令/超时/输出截断）；纯函数 `composeBangPrompt(cmd, output)`；组件：输入 `!ls` → 确认气泡 → 确认 → prompt 收到含 `[本地命令]` 文本
- 分支 a：仅文案断言

**日志**：
- spike：`logger.debug("spike", "bang-probe", {adapter, executed})`
- 分支 b：`logger.info("bang", "exec", {cmd, exitCode, outputBytes})` / `exec-timeout`；`logger.warn("bang", "rejected")`

**验收**：
- **AC-P11-10**：spike 探针产出三 harness 判定结论 + 报文存档，写入本文件 §7 → 通过（含「均不执行→走分支 b」的记录）
- **AC-P11-11**：输入 `!ls` → 出现确认气泡（不自动执行）；确认后（分支 b）agent 收到含命令与输出的 prompt，消息流可见「$ ls」折叠项；拒绝则不执行不发送 → 通过
- **AC-P11-12**：执行超时/命令不存在 → 错误 toast + 日志，不崩溃，turn 不挂起 → 通过

---

## 4. P11.2 · 第二批：行为修复

### F-11-5 分叉后自动跳转 + 历史加载（M）

**功能**：
- Rust 新增 `log_copy(from_session_id, to_session_id)`：复制 JSONL（目标已存在则覆盖）；`log_copy` 后 App 端无需感知行数
- `ChatPanel.doFork` 成功后：`log_copy(from, newId)` → `onFork(from, newId)`（写索引，现有）→ **`onForkNavigate(newId)`**（新增回调）
- App 收到 `onForkNavigate`：以新 sessionId 新开 Tab（`resolveHistoryOpen` 语义：标题「从 XX 分叉」、同 adapter/workspace/cwd）并激活；原 Tab 保留（父会话不动）
- 新 Tab 挂载 → 既有恢复链路生效：`logRead(newId)` 回填 UI（复制的日志）+ `session/load` 恢复 harness 上下文 → 「历史消息未找到」消除

**测试**：
- Rust `log_copy` cargo test（源不存在/目标覆盖/内容一致）
- 组件：mock fork → 断言 `onForkNavigate` 被调、`logCopy` 被调（spy）；App 集成（mockIpc）：分叉 → 新 Tab 出现且 resumeSessionId=新 id、消息列表含父会话历史

**日志**：
- `logger.info("session", "fork-navigate", {from, to})`；Rust `log_copy` info

**验收**：
- **AC-P11-13**：点击分叉 → 自动切换到新 Tab（父 Tab 保留在 Tab 栏），新 Tab 标题「从 XX 分叉」→ 通过
- **AC-P11-14**：新 Tab 内历史消息完整回显（= 父会话历史），无「上下文已恢复，历史消息未找到」降级提示；继续对话 harness 上下文连贯 → 通过
- **AC-P11-15**：分叉失败（busy/无 sessionId）行为不变（toast，不跳转）→ 通过

### F-11-6 批注悬浮窗失焦关闭（M）

**功能**：
- `.quick-pop`（含加载/结果态）点击浮层外任意处 → 自动关闭（document mousedown + ref outside 判定，DEC-31）
- 删除「关闭」按钮（确认态与结果态两处）；Escape 保留为键盘出口
- 重新选中文本 → 浮窗重定位（现状已有）；滚动静默不关（只关鼠标点外/Esc）

**测试**：
- 组件：选中文字 → 浮窗出现 → `userEvent.click(document.body)` → 浮窗消失；断言「关闭」按钮不存在；Esc 仍可关；点浮窗内部不关

**日志**：
- `logger.debug("chat", "quick-pop-dismiss", {reason: "outside"|"escape"})`

**验收**：
- **AC-P11-16**：选中文字弹浮窗 → 点击浮窗外任意位置 → 浮窗消失，无需找关闭按钮 → 通过
- **AC-P11-17**：DOM 中不存在「关闭」按钮（两态均无）；点浮窗内部（如「批注」「快速解释」）不触发关闭 → 通过

---

## 5. P11.3 · 第三批：布局重构

### F-11-7 右侧侧边栏：元数据 / 文件双 tab（M，AionUi 风格）

**功能**：
- 新组件 `RightRail`：单一右栏容器，顶部两个 tab：`元数据` / `文件`；激活 tab 高亮，切换只换内容区
- `MetadataPanel`、`FileTree` 改为 RightRail 的 tab 内容（组件接口微调，逻辑不动）；FileTree 从 ChatPanel 输入框下方移除
- 折叠：右栏收为 28px 细栏杆（竖排「元数据/文件」字样或图标，点击展开）；开合 + 激活 tab 持久化 localStorage（key：`ainone-rightrail`）
- 挂载位置：App 壳 `.tabs-area` 内、ChatPanel 右侧（与左栏对称）；仅在有活跃会话时渲染
- 空态：无会话时右栏不渲染

**测试**：
- 组件：RightRail 渲染两 tab → 点击切换内容（MetadataPanel/FileTree 内容各自可见）；折叠/展开；localStorage 恢复
- 回归：MetadataPanel.test / FileTree.test 迁移适配（props 变化）

**日志**：
- `logger.debug("layout", "rightrail-tab", {tab})` / `rightrail-toggle {open}`

**验收**：
- **AC-P11-18**：有会话时右侧出现侧边栏，`元数据`/`文件` 两 tab 可切换，各自内容正确渲染；文件树不再出现在输入框下方 → 通过
- **AC-P11-19**：折叠为细栏杆 → 点击展开恢复上次激活 tab；刷新应用后开合与 tab 记忆保持 → 通过

### F-11-8 布局固定：仅消息区滚动（M）

**功能**：
- 壳级约束（DEC-33）：`.container` `overflow:hidden`；`.sidebar` 内容自身滚动（已）；`.tabs-bar` 横向滚动（已）；`.chat` 唯一纵向滚动区
- ChatPanel 内 FileTree/队列面板等非滚动条带改为固定高度自适应（max-height + 内滚），不得把 `.chat` 挤出视口
- 顶部 toolbar（新建会话/设置/主题）、Tab 栏、输入区、harness 徽标、计划栏：全部固定不随滚动
- 验证手段：长会话（>50 条消息）下 body `scrollHeight === clientHeight`（无 body 滚动）

**测试**：
- 组件（jsdom 结构断言）：`.chat` 存在 `overflow-y:auto`、`.container` 存在 `overflow:hidden`（getComputedStyle 或 class 断言）
- 手工验收：长会话滚动时侧栏/输入框纹丝不动

**日志**：
- 无（纯布局，无运行时行为）

**验收**：
- **AC-P11-20**：长会话（50+ 条）滚动时：左侧工作区、顶部 toolbar、Tab 栏、输入区全部固定不动，仅消息列表滚动 → 通过
- **AC-P11-21**：整页（body）不出现滚动条；窗口缩小到最小尺寸（720×480）布局不破 → 通过

### F-11-9 顶部「上一条指令」回跳气泡（P2，M）

**功能**：
- `lastUserIndex(messages)` 纯函数：最后一条 user 消息下标（无则 -1）
- `.chat` 顶部悬浮折叠气泡（sticky 于消息区顶端）：显示最后一条 user 消息单行省略（max 一个气泡高，约 40px）
- 显隐：滚动位置距底 > 一个气泡高 → 显示；贴底 → 隐藏；无 user 消息 → 不渲染
- 点击 → `virtualizer.scrollToIndex(lastUserIndex, { align: "start" })` + 该消息短暂高亮
- 监听 `.chat` scroll 事件（节流 raf）驱动显隐

**测试**：
- 纯函数 `lastUserIndex`（空/纯 agent/多轮）
- 组件：mock 虚拟列表 → 消息多 → 气泡可见含最后 user 文本省略 → 点击 → scrollToIndex 被调（spy）→ mock 滚动到底 → 气泡隐藏

**日志**：
- `logger.debug("chat", "last-prompt-jump", {index})`

**验收**：
- **AC-P11-22**：长会话上滚后顶部出现「你最后说的：…」折叠气泡（单行省略）；贴底时消失 → 通过
- **AC-P11-23**：点击气泡 → 视图滚动到最后一条 user 消息（align start），该消息高亮提示 → 通过

---

## 6. MoSCoW 与工作量

| 级别 | 项 |
|---|---|
| M | F-11-1…F-11-9 全部（F-11-9 为 P2 内的 M） |
| S | （未排）@ 多目录根切换；全局搜索搜消息正文（跨会话全文检索） |

| 批次 | 内容 | 估算 |
|---|---|---|
| P11.1 | F-11-0 spike（0.5d）→ F-11-1（0.5d）→ F-11-2（1d）→ F-11-3（1d）→ F-11-4（1d） | 4 天 |
| P11.2 | F-11-5（1d）→ F-11-6（0.5d） | 1.5 天 |
| P11.3 | F-11-7（1d）→ F-11-8（0.5d）→ F-11-9（0.5d） | 2 天 |

---

## 7. 实施顺序、依赖与 spike 结论

```text
P11.1: F-11-4a spike（!语义，阻塞 F-11-4b）
         F-11-1（fuzzy.ts 是 F-11-2/3 的公共依赖，先行）
           → F-11-2 全局搜索（依赖 fuzzy + CommandDialog）
             → F-11-3 @ 文件（依赖 fuzzy + workspace_list_dir）
               → F-11-4 ! 命令（依赖 spike 结论）
P11.2: F-11-5 分叉跳转（Rust log_copy）→ F-11-6 失焦关闭
P11.3: F-11-8 布局固定（先立壳）→ F-11-7 右栏（壳稳后迁入）→ F-11-9 回跳气泡
```

### F-11-4a spike 结论（实施时回填）

| harness | `!cmd` 是否被执行 | 证据（报文存档） |
|---|---|---|
| claude-agent-acp | 待测 | 待存档 |
| omp | 待测 | 待存档 |
| pi-acp | 待测 | 待存档 |

**裁决规则**（DEC-29）：任一 harness 执行 → 分支 a（透传）；均不执行 → 分支 b（客户端 `exec_in_cwd` 本地执行 + 输出注入 prompt）。

---

## 8. 需求追溯

| F 项 | 来源（用户原话归并） | AC |
|---|---|---|
| F-11-1 | slash 菜单键盘不翻页 + 支持模糊匹配（fzf/zoxide） | AC-P11-1…3 |
| F-11-2 | 全局搜索 session，Ctrl+F，悬浮中上，模糊匹配 | AC-P11-4…6 |
| F-11-3 | 输入 @ 选取文件（参考社区实现） | AC-P11-7…9 |
| F-11-4 | ! 直接输入命令注入 Agent 上下文并执行 | AC-P11-10…12 |
| F-11-5 | 分叉自动跳转新 session + 历史加载 | AC-P11-13…15 |
| F-11-6 | 批注悬浮窗失焦关闭，删关闭按钮 | AC-P11-16…17 |
| F-11-7 | 元数据/文件在右侧侧边栏切换（AionUi 风格） | AC-P11-18…19 |
| F-11-8 | 只有聊天记录滚动，其余固定 | AC-P11-20…21 |
| F-11-9 | 顶部显示最后一条指令，点击回跳 | AC-P11-22…23 |

---

## 10. 变更记录

| 日期 | 版本 | 变更 | 决策人 |
|---|---|---|---|
| 2026-09-03 | v1.0 | 初版：9 项需求成文；DEC-25…34；Ctrl+F 分配（全局搜索）与会话内搜索改 Ctrl+Shift+F 经所有者裁决；! 语义裁决为先 spike 再定 | 所有者+Claude |
