# P23 规格需求书：内嵌终端（Terminal Session）

> 状态：v1.0（已批准，2026-09-06）
> 执行分支：worktree `feat/p23_terminal_session`（基于 main @ 949346c）。

---

## 0. 需求总览（用户原话 → 特性编号）

| # | 用户诉求 | 特性 |
|---|---|---|
| 1 | 「希望再添加一个功能是直接打开一个终端」 | F-23-1（新建终端入口） |
| 2 | 「终端也是和 session 一样支持分屏，和 session 是同样级别同样定位的东西」 | F-23-2（终端 tab 窗格化） |
| 3 | 「兼容现在已有 session 的显示方案」 | F-23-3（复用现有布局/光晕/拖拽/关闭链路） |

## 1. 背景与目标

ainone-ui 目前只支持一种会话：harness（ACP agent）会话。用户希望在同一个多窗格布局里直接打开本地 shell 终端，与 agent 会话并排分屏使用（典型场景：agent 改代码的同时手动跑构建/看日志）。

目标：终端是一等公民的「session 类型」，创建入口、tab 展示、分屏、关闭全链路对齐现有 harness session。

## 2. 选型结论（金标准：社区成熟方案优先）

终端 = **前端终端仿真器 + 后端 PTY** 两层，均采用社区事实标准，不自研：

| 层 | 选型 | 理由 |
|---|---|---|
| 前端仿真 | **`@xterm/xterm` ^6 + `@xterm/addon-fit`** | VS Code/Hyper/Theia 同款；MIT；零依赖；CJK/IME 完整；维护活跃（2026 仍持续发版）。替代品 ghostty-web 维护停滞且多 tab 内存损坏（2code issue#145 评估），不取 |
| 后端 PTY | **`tauri-plugin-pty`（Tnze，crates.io 0.3.1，底层 portable-pty）** | Tauri 2 官方风格插件：`plugin:pty|spawn/read/write/resize/kill/exitstatus/get_all_pids` 命令齐全 + TS API（`tauri-pty` npm，node-pty 同形 API）；portable-pty 是 wezterm 的跨平台 PTY 层（3.2M 下载/月，795 crate 依赖），macOS/Windows(ConPTY)/Linux 全覆盖 |
| 数据通道 | 插件自带 `read` 轮询（invoke `plugin:pty|read`，EOF 抛错即结束） | 0.3.x 的 TS API 已封装成 `pty.onData` 事件（内部 for(;;) 循环 read），前端拿到的是 node-pty 形状的 `IPty` 对象；无需自建 Channel 桥 |
| shell 探测 | `std::env::var("SHELL")`（fallback `/bin/zsh`），无新代码 | 复用 env_path.rs 同款语义 |

**明确拒绝的方案**：
- `marc2332/tauri-terminal`（130★ 示例仓）：2026-08 已 archive，只作参考。
- `tauri-plugin-pty` 不足处（resize/kill 均已覆盖，`exitstatus` 语义是阻塞 wait）：自写 20 行胶水封装 `src/ipc/pty.ts` 归一化——**业务粘合层允许自研**（CLAUDE.md 金标准第 3 条）。
- 不引入 `tauri-plugin-shell` 的 `Command`（无 PTY/无 TTY 语义，终端必需 PTY）。

**历史决策更新**：`plan.md` F-1-6「不做 PTY」针对的是「ACP harness 工具命令执行」（非交互 collect-and-return），与本需求「用户交互终端」不冲突；本规格不改 F-1-6。

## 3. 现状事实（已探明，实现须对照）

- 布局单真源 `App.tsx`：`tabToJson`（L142）`component` 硬编码 `"chat"`；`factory`（L368）无条件渲染 `ChatPanel`；`renderTab`（L391）leading 槽画 `AgentAvatar`。
- 业务 Tab 类型 `src/app/logic/tabs.ts` `Tab { key, adapterId, sessionId?, title, cwd?, workspaceId? }`；投影 `extractTabsFromModel`（layout.ts L126）读 config 回建 Tab。
- 分屏链路：`splitCurrent`（App.tsx L212，同 harness 新会话语义 DEC-23）；拖入布局 `handleExternalDrag`（payloadToTab）；关闭链路 = flexlayout 删除节点 → `syncFromModel` 投影掉 → 组件 unmount 自清理（ChatPanel.tsx L374-392 范式：dispose + drop(tabKey)）。
- 侧栏索引 `SessionEntry { session_id, adapter_id, title, cwd, workspace_id, mtime_ms }`（Rust sessions.rs L12 / TS ipc/sessions.ts L6），`#[serde(default)]` 读时迁移已有先例（workspace_id）。
- 选中光晕：`.flexlayout__tab[data-active]` CSS（index.css L464+），任何 tab 面板通用，无需改。
- 空布局启动：布局不持久化，重启即空——终端 tab 与 chat tab 一样「当次会话生命周期」。
- 图标纪律：`src/components/ui/icons.ts` 已导出 `TerminalIcon = Terminal`（lucide）。
- 无任何 PTY/xterm 代码与依赖（Cargo.lock、pnpm-lock 均无）。

## 4. 方案

### 4.1 数据模型扩展（kind 字段，兼容旧数据）

- `Tab` 增 `kind?: "agent" | "terminal"`（缺省 `"agent"`，旧 Tab 与旧 config 无字段即 agent）。
- `SessionEntry` 增 `#[serde(default)] pub kind: Option<String>`（`"agent"|"terminal"`，None 兼容旧索引=agent）；TS 镜像 `kind?: "agent" | "terminal"`。侧栏点开终端条目 → 工厂按 kind 分派。
- 终端的 `adapter_id` 固定 `"terminal"`；`session_id` 用 `term-<uuid>` 格式（仅作索引主键，非 ACP sessionId）。

### 4.2 Rust：PTY 命令层（新模块 `src-tauri/src/terminal.rs`）

引依赖 `tauri-plugin-pty = "0.3"` + `tauri-pty`（npm）。**命令注册两选一，随实现验证**：插件 `init()` 注册的 `plugin:pty|*` 命令前端可直接 invoke（capability 加 `pty:default`）；若 0.3.x 权限文件缺失导致 invoke 被拒，则退路 = 不挂插件、在自建 `terminal.rs` 里 `pub use` 透传或包一层同名命令。

`terminal.rs` 只提供 1 条薄命令（复用插件做 PTY 全部重活）：

```
terminal_default_shell() -> { program, args }   // $SHELL，兜底 /bin/zsh；cwd 由前端传
```

交互命令直接用插件的 `plugin:pty|spawn/read/write/resize/kill/exitstatus`（文件名 `file`、argv、cols/rows、cwd、env、handleFlowControl 全有；env 注入 `PATH = enhanced_path()` 复用 env_path.rs 增强逻辑，保证终端里 node/bun/omp 等可达，与 agent 子进程行为一致）。

- 退出清理：`lib.rs` 的 `handle_run_event`（RunEvent::Exit）追加 `get_all_pids → 逐个 kill`，防止退出时 shell 进程残留。
- 不做空闲回收（终端常驻属预期，无 harness 的 LLM 成本语义）。

### 4.3 前端：PTy 胶水封装（`src/ipc/pty.ts`）

node-pty 形状的薄封装（单文件 ~60 行）：

```
createTerminal({ cwd, cols, rows }) → {
  pid, onData(cb), write(data), resize(cols, rows), kill(), onExit(cb)
}
```

- 内部：`invoke("plugin:pty|spawn", {...})` 得 pid → 封装 read 轮询循环（`for(;;) invoke read`，捕 `"EOF"` 停止）→ exitstatus promise → 事件回调。
- xterm 数据默认经 UTF-8 字符串通道（write 传 string）；read 返回 ArrayBuffer → TextDecoder 转 string 写 xterm。二进制无 UTF-8 场景（如 cat 图片）允许有损（harness session 同样不支持）。

### 4.4 前端：TerminalPanel 组件（`src/terminal/TerminalPanel.tsx`）

- 根节点复用 `.panel` class（app.css L324 高度链约定），内衬 `<TerminalIcon>` 空态 + xterm 容器 div。
- 生命周期对齐 ChatPanel 范式：
  - mount → `createTerminal({ cwd })`（懒创建，同 ChatPanel ensureSession；首次写入前不 spawn shell）。
  - unmount → `kill()` + 清 store（`dropTerm(tabKey)`）。
  - Tab 切换/分屏隐藏：flexlayout 对已渲染 tab 保持 DOM（`display:none` 切换，dist 源码实证 `element.style.display = visible ? "" : "none"`），xterm 持续在后台收发——不可见时的输出在重新可见时一次性呈现，无需重放逻辑。
  - xterm 实例持久：component key = tabKey，拖拽 dock 不 remount（flexlayout portal 语义，dist 源码实证）。
- 接线：`addon-fit` 的 `FitAddon.fit()`（ResizeObserver 监听容器）→ `pty.resize(cols, rows)`；`term.onData → pty.write`；`pty.onData → term.write`；`pty.onExit` → 顶部状态条显示「进程已退出 (code N)」+「重新打开」按钮（= kill 旧实例重建）。
- xterm 主题跟随 app：`term.options.theme` 读 CSS 变量（`--bg-base`/`--text-primary` 等），`data-theme` 切换时重建 options（observedAttributes 简化：useEffect 依赖 theme state）。
- 样式：`.terminal-panel` 进 app.css（xterm canvas 全填充、无滚动条双吃——xterm 自带 viewport 滚动）。
- 字体：跟随 app 等宽栈（`ui-monospace, SFMono-Regular, Menlo, monospace`），不引入字体资产。

### 4.5 前端：App.tsx 工厂分派 + 入口

- `tabToJson(tab)`：`component: tab.kind === "terminal" ? "terminal" : "chat"`。
- `factory`：按 `node.getComponent()` 分派 `ChatPanel | TerminalPanel`；terminal 分支不查 adapters（kind=terminal 的 tab adapterId 恒 `"terminal"`）。
- `renderTab` leading 槽：terminal tab 画 `<TerminalIcon size 14>`（替换 AgentAvatar 位置，无品牌色），无状态角标。
- `extractTabsFromModel`：config 透传 `kind`（缺省 `"agent"`），投影 Tab。
- 新建入口（三个，全走 `addTabToModel` 既有锚点/等分/激活逻辑）：
  1. 工具栏「新建会话」旁新增「新建终端」按钮（`TerminalIcon`+文字）；
  2. 工作区右键菜单加「新建终端」（继承该 workspace cwd）；
  3. `NewSessionModal` 顶部加「终端」快捷卡（点它 = 直接确认终端 tab，工作区列表仍可用于改归属）。
- 新建逻辑 `newTerminalTab(workspaceId?, cwd?)`：key 同 `tab-N` 递增序列；title「终端」（工作区归属时 title = 工作区名尾段）；**立即 `sessions_upsert` 落索引**（终端无首条消息时机，mount 后即落，mtime 更新交给实现时验证）。
- 分屏语义扩展（DEC-23 对齐）：`splitCurrent` 增加分支——源 tab 是 terminal → 新窗格 = 同 workspace/cwd 新终端（agent 语义照旧）。
- 侧栏行：`SessionRowLeading` 对 `adapter_id === "terminal"` 画 `TerminalIcon` 而非 AgentAvatar；`deriveStatus` 不变（terminal 无 busy/perm，自然恒 done——可在 runtime 上给 terminal 加 `exited` 状态映射 `awaiting_input` 视觉，随实现取简，默认不做）。
- 拖入布局：`payloadToTab` 透传 kind；终端条目可拖入分屏（F-23-3 兼容项）。

### 4.6 运行时状态（独立轻 store，不塞 sessionStore）

新 `src/store/terminalStore.ts`：`Record<tabKey, { exited: boolean; exitCode: number | null }>`（zustand，无 persist）。sessionStore 的 RuntimeState 深度耦合 ChatMsg，不混入。

## 5. 不做什么

- 不做终端输出持久化/历史回放（重启即失，与布局不持久化一致；会话索引保留标题/cwd 但不存 scrollback）。
- 不做终端内 slash 命令、AI 补全、主题切换 UI。
- 不做 Windows 支持（plan.md 不做清单延续：非 unix 退化为默认 shell 路径，ConPTY 由 portable-pty 兜底但不测试）。
- 不做 SSH/远程终端。
- 不改 ACP session-core / ChatPanel 任何协议与消息逻辑。
- 不做空闲回收（见 4.2）。

## 6. 验收标准

| AC | 内容 | 验证 |
|---|---|---|
| AC-P23-1 | 工具栏「新建终端」点击 → 布局内出现终端 tab，默认 shell 可交互（ls/vim/清屏） | GUI 冒烟 |
| AC-P23-2 | 终端 tab 与 chat tab 同级同位：可与 chat 互拖 dock、Ctrl+D/Shift+D 分屏、关闭走同一链路且子进程被 kill（活动监视器验证无残留 shell） | GUI 冒烟 + 进程检查 |
| AC-P23-3 | 工作区右键「新建终端」→ 终端 cwd = 工作区目录（pwd 验证）；侧栏出现「终端」条目（TerminalIcon leading），点击可恢复 tab | GUI 冒烟 |
| AC-P23-4 | 分屏时终端窗格 resize（拖 splitter）→ PTY 同步 SIGWINCH（在终端跑 `python3 -c "import shutil;print(shutil.get_terminal_size())"` 或 `resize -s` 前后对比行列数） | GUI 冒烟 |
| AC-P23-5 | 选中光晕/焦点行为对 chat tab 一致：点终端窗格 data-active 落在对应面板、Cmd+方向键跨窗格移动 | GUI 冒烟（P20i 既有路径回归） |
| AC-P23-6 | 深浅主题切换：xterm 配色跟随（背景/前景色随 data-theme 变） | GUI 冒烟 |
| AC-P23-7 | 回归：`pnpm test` 全绿（350+ 新增）、`cargo test` 绿、`pnpm build` 零报错；e2e 探针不回归 | CI 手动跑 |
| AC-P23-8 | 单测：tabs/layout 纯函数对 kind 的分派与投影（含旧数据无 kind 兼容）；pty.ts 对 EOF/退出事件的归一化（mock invoke） | vitest |

## 7. 实施顺序（worktree，小步提交，无 AI 署名）

1. S1：Rust 侧——Cargo 依赖 + `terminal.rs`（default_shell 命令 + 退出清理）+ capability/插件注册。验证：`cargo test` + dev 起应用 invoke 通。
2. S2：前端依赖 + `src/ipc/pty.ts` 胶水 + `terminalStore`。验证：vitest（mock invoke）。
3. S3：`TerminalPanel` 组件（xterm + fit + resize + exit 状态条）+ `.terminal-panel` 样式。验证：vitest 冒烟渲染 + dev 起应用手动建 tab（临时入口可 console 触发）。
4. S4：App 工厂分派 + tabToJson/kind + extractTabsFromModel + renderTab 图标 + 三个新建入口 + splitCurrent 分支 + 侧栏行。验证：vitest（tabs/layout/分派单测）+ GUI。
5. S5：SessionEntry kind 字段 + sessions_upsert 接线 + openFromHistory 分派。验证：Rust 读时迁移单测 + GUI（重启侧栏恢复）。
6. S6：全量测试 + GUI 冒烟（AC-P23-1~7 逐条）+ `docs/acceptance/P23-<date>.md` + merge --no-ff 回 main。

每步 `pnpm build + pnpm test` 绿后提交（conventional commits：`feat(p23x): …`）。
