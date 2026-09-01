# AINONE-UI · 软件开发计划书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-01
**状态**：已批准基线（P0 执行中）

---

## 0. 文档说明

### 0.1 文档目的

本计划书是 ainone-ui 唯一的开发基线文档，规格书（Requirement Spec）与阶段计划（Phased Plan）合一。作用：

1. 定义产品的范围、边界与不做的事（§1–§2）
2. 给出系统架构与接口规格（§3–§4）
3. 按阶段（Phase）拆分交付物，**每阶段附带可验收标准**（§7）
4. 作为跨阶段的变更裁判基准：任何偏离本计划的决定需记录于 §11

### 0.2 需求分级定义（MoSCoW）

| 级别                             | 含义         | 缺失后果                           |
| -------------------------------- | ------------ | ---------------------------------- |
| **M**（Must）              | 本期必须交付 | 不满足则本期验收不通过             |
| **S**（Should）            | 本期应当交付 | 允许一次延期，须记入 §11 变更记录 |
| **C**（Could）             | 本期可选项   | 资源/进度允许才做                  |
| **W**（Won't，this phase） | 明确本期不做 | 留待后续期，防止范围蔓延           |

### 0.3 验收标准写法约定

- 每条验收标准是**原子**的：一条只验证一件事
- 每条是**二元可判**的：执行给定步骤后，结果只有"通过/不通过"两种
- 每条格式：`[验收编号] 执行步骤 → 预期结果`
- 验收执行人：开发者自验 + 项目所有者复验，双签后状态 Latch

---

## 1. 项目概述

### 1.1 产品定位（Mission Statement）

ainone-ui 是一个跨平台桌面客户端，通过标准化的 ACP 协议统一驱动多个本地 coding agent harness（OMP、Pi、Claude Code、OpenCode、Amp…），让用户在**一个**界面内使用、对比与管理所有 agent。GUI 只承担展示与交互职责；模型调用、工具执行、上下文管理全部保留在原有 harness 内部。

**命名释义**：A(i)N(one) = Agent in One。

### 1.2 要解决的问题（Problem Statement）

| #    | 用户痛点                                    | ainone-ui 的解法                                      |
| ---- | ------------------------------------------- | ----------------------------------------------------- |
| PS-1 | 终端 UI 观感差、信息密度低、不可定制        | 原生桌面 UI：Markdown/diff 渲染、折叠分组、自定义主题 |
| PS-2 | 多个 harness 并存，各开各的终端，上下文割裂 | 统一聊天界面 + 适配器注册表，会话按项目集中管理       |
| PS-3 | 切换 harness 需要重学交互方式               | 单一交互范式，所有 agent 共用同一套 UI 手势           |
| PS-4 | 无法并行/对比运行多个 agent                 | 多会话并行，每会话独立子进程                          |

### 1.3 目标用户与使用场景

**目标用户画像**：个人开发者 / 小团队工程师，已在日常使用 ≥1 个命令行 coding agent，拥有多 harness 并用经历。

**核心使用场景（User Scenario）**：

- US-1：在同一个项目里，用 OMP 完成一次重构，随后新建会话换 Claude Code 对比方案
- US-2：并行开两个会话，分别让两个 agent 做两件事，互不干扰
- US-3：让 agent 修改文件时，GUI 弹出权限确认，看到 diff 后再批准
- US-4：昨天没聊完的会话，今天打开续聊，agent 记得上下文
- US-5：agent 后台跑长任务，完成后系统通知提醒

### 1.4 成功指标（成功定义）

发布 v1.0 时：

- SM-1 **功能**：≥4 个 harness 接入可用（OMP/Pi/Claude Code/OpenCode）
- SM-2 **稳定**：连续 30 天个人日常使用，崩溃 ≤1 次，且子进程无残留
- SM-3 **轻量**：安装包 ≤20MB（三平台），空载内存 ≤150MB
- SM-4 **生态**：配置新增一个 ACP 兼容 harness（零代码改动）耗时 ≤10 分钟

### 1.5 风险登记表（Risk Register）

| ID  | 风险                                                         | 概率 | 影响 | 缓解措施                                  | 风险期 |
| --- | ------------------------------------------------------------ | ---- | ---- | ----------------------------------------- | ------ |
| R-1 | 各 harness ACP 实现成熟度参差                                | 高   | 高   | P0 逐个验证握手/事件流；适配器可单独禁用  | P0–P2 |
| R-2 | harness 迭代导致协议行为漂移                                 | 中   | 高   | 报文存档做回归基线；容忍未知 content type | 全程   |
| R-3 | Linux WebKitGTK 渲染差异                                     | 中   | 中   | CI 三平台构建截图比对；CSS 兼容前缀清单   | P3–P4 |
| R-4 | Claude Code SDK/headless 计费独立于订阅额度（2026-06-15 起） | 中   | 中   | 文档明示；设置页展示用量来源              | P2     |
| R-5 | ACP 远程模式（HTTP）规范仍在演进                             | 低   | 低   | P1–P4 仅走本地 stdio 模式                | P5+    |
| R-6 | 单人开发精力有限                                             | 高   | 中   | 分期 Latch，每期都可用，不追求一步到位    | 全程   |

---

## 2. 范围

### 2.1 In Scope（做什么）

1. 桌面客户端：Linux / macOS / Windows 三平台（Tauri 2 + React + TypeScript）
2. ACP client 实现（本地 stdio JSON-RPC）
3. harness 适配器注册表（配置驱动，用户可扩展）
4. 会话管理：新建/恢复/并行/关闭
5. 对话渲染：流式文本、工具调用、权限审批、diff、终端输出
6. 系统集成：托盘、通知、全局快捷键、i18n

### 2.2 Out of Scope（明确不做什么）

1. **不实现 LLM 调用**——不内置任何模型客户端，不做 API 代理
2. 不做云服务、账号系统、数据上报（本地优先，无遥测）
3. P1–P4 不做远程 harness（SSH/云端 agent），留待 P5
4. 不做 harness 内部功能的重实现（权限策略、上下文压缩等遵循 harness 侧配置）
5. 不做移动端（Tauri 2 移动端支持列为 P5+ 观察项）

---

## 3. 系统架构

### 3.1 架构总图

```text
┌─ ainone-ui 桌面应用（Tauri 2）──────────────────────────┐
│                                                          │
│  UI 层（React + TS，WebView 内）                         │
│  ├─ 会话列表/多 Tab ── 聊天流 ── 权限弹窗 ── diff 视图   │
│  │      ↑ invoke(请求)          ↓ event(订阅)            │
│  ├─ ACP 状态机（纯 TS，可单测）                          │
│  │      ↑ IPC              ↓ IPC                        │
│  Rust 层（薄胶水）                           │
│  ├─ 进程管理：spawn/kill 子进程树                        │
│  ├─ 行缓冲 JSONL 解析（只按 LF 切分）                    │
│  └─ ACP client 能力实现：fs 读写、terminal 执行          │
│         ↕ stdio：JSON-RPC over stdin/stdout             │
└──────────┬──────────┬──────────┬──────────┬────────────┘
           ↓          ↓          ↓          ↓
         OMP        Pi        Claude    OpenCode     ← 各 harness
       (原生ACP)  (pi-acp桥) (cc-acp)  (内置acp)        自行调用 LLM
```

### 3.2 模块职责

| 模块          | 位置                          | 职责                             |
| ------------- | ----------------------------- | -------------------------------- |
| UI 组件       | `src/components/`           | 渲染与交互                       |
| ACP 状态机    | `src/acp/`                  | 请求 id 关联、事件分发、会话状态 |
| Rust process  | `src-tauri/src/process.rs`  | 子进程生命周期                   |
| Rust rpc      | `src-tauri/src/rpc.rs`      | JSONL 行解析/报文装配            |
| Rust commands | `src-tauri/src/commands.rs` | IPC 接口（invoke/event 桥）      |
| 配置存储      | `src/config/`               | 适配器注册表、会话索引           |

架构意图（非硬性限制）：业务逻辑全部在 TypeScript，Rust 层只做进程管道与 ACP client 能力实现。

### 3.3 核心数据流（Prompt 一条消息的完整路径）

```text
用户输入 → invoke('agent_prompt', sessionId, text)
  → Rust 层封装 {method:"session/prompt", params:{sessionId, prompt}}
  → 写入子进程 stdin
  → harness 内部决定调用 LLM/工具（GUI 无感知）
  → 子进程 stdout 按行输出 JSON-RPC 消息
  → Rust 行缓冲解析 → emit('agent-stdout', line) → 页面 ACP 状态机
  → session/update(流式文本/工具调用/权限请求) → React 渲染
```

### 3.4 关键技术决策记录（ADR 摘要）

| #     | 决策                           | 理由                                                                                                     | 备选方案与否决理由                                 |
| ----- | ------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| DEC-1 | 桌面框架 Tauri 2               | 同类项目（opcode/OpenCovibe/Graphone）一致选择；轻量（3–15MB vs Electron 100MB+）；Rust 管进程稳        | Electron：渲染一致但重，团队无历史包袱             |
| DEC-2 | 协议 ACP over stdio            | 四个目标 harness 全部可经 ACP 接入；Zed+JetBrains 维护的开放标准，带 Registry；JSON-RPC 语义贴合聊天 GUI | AG-UI：需 HTTP+SSE 服务端形态，不适配本地 CLI 场景 |
| DEC-3 | 业务逻辑全部 TS，Rust 只做管道 | TS 可测试、类型集中、降低 Rust 维护门槛                                                                  | 全 Rust：性能无必要，开发速度慢                    |
| DEC-4 | 无 ACP 的 harness 走外部桥接器 | 保持 GUI 单协议；pi-acp/acp-amp 生态已有先例                                                             | GUI 内置多协议：违反原则 1，维护面爆炸             |
| DEC-5 | JSONL 行切分只认 LF            | pi 文档明确警告勿用通用行读取器（Unicode 分隔符陷阱）                                                    | —                                                 |
| DEC-6 | Zustand 替代 Redux | 本项目状态形态（会话×消息列表）用轻量方案足够 | — |
| DEC-7 | ACP 协议层采用官方 TS SDK（`@agentclientprotocol/sdk`） | 官方维护、纯 Web API 可直接跑在 WebView、离 React 渲染层零距离（事件免二次序列化）；Rust 层退化为纯字节管道 | 自研状态机：重复造轮子；Rust SDK：事件需过 IPC 二次序列化，且 Client trait 样板重 |
| DEC-8 | 「成熟实现优先」作为选型纪律 | 用户明确要求：有成熟第三方实现（协议 SDK、diff 渲染、虚拟列表等）一律直接采用，自研仅限无现成方案的业务粘合层 | — |

### 3.5 错误处理策略（分层）

| 层   | 故障类型                 | 处理                 | 用户可见结果                |
| ---- | ------------------------ | -------------------- | --------------------------- |
| Rust | spawn 失败（命令不存在） | 返回结构化错误       | 设置页标红 + 启动失败弹窗   |
| Rust | 子进程崩溃/断管          | 监听 exit + 断管检测 | 会话内错误横幅 + 重启按钮   |
| TS   | 未知 content type        | 安全忽略 + 计数      | 消息流内「已忽略未知块×N」 |
| TS   | JSON 解析失败            | 计数+日志            | 开发者面板可见，不打断 UI   |

---

## 4. 接口规格（IPC 与 ACP）

### 4.1 IPC 接口（页面 ↔ Rust）

所有 invoke 命令名蛇形命名，参数/返回为 JSON 结构。

#### IPC-1 `agent_spawn`

```jsonc
入参: { adapterId: string, cwd?: string }
出参: { agentId: string }   // 长连接代理进程 id，非 ACP sessionId
错误: { code: 'SPAWN_FAIL'|'ADAPTER_NOT_FOUND', message: string }
```

#### IPC-2 `agent_send`

```jsonc
入参: { agentId: string, line: string }   // line 为完整 JSON-RPC 行
出参: { ok: true }
错误: { code: 'AGENT_DEAD'|'AGENT_NOT_FOUND', message: string }
```

#### 4.1.1 命令总表（全量，P1–P2 交付）

| 命令                                                        | 功能                          | 备注                                           |
| ----------------------------------------------------------- | ----------------------------- | ---------------------------------------------- |
| `agent_spawn {adapterId, cwd?} → {agentId}`              | 启动 agent 子进程             | 失败返回`SPAWN_FAIL` / `ADAPTER_NOT_FOUND` |
| `agent_send {agentId, line}`                              | 向 stdin 写一行完整 JSON-RPC  | 进程已死返回`AGENT_DEAD`                     |
| `agent_stop {agentId}`                                    | kill 进程树                   | 关窗/关会话时必须调用                          |
| `agent_get_status {agentId}`                              | 查询运行状态                  |                                                |
| `fs_read {path}` / `fs_write {path, content}`           | ACP fs 回调                   | 仅供状态机调用                                 |
| `term_create {cmd, cwd} → {termId}`                      | ACP terminal 回调：非交互执行 | 输出流式回推                                   |
| `term_output {termId}` / `term_wait {termId} → {code}` | ACP terminal 回调             |                                                |
| `term_kill {termId}`                                      | ACP terminal 回调             |                                                |
| `config_list/save/delete_adapter`                         | 适配器注册表 CRUD             | P2                                             |
| `session_index_load/save`                                 | 会话索引                      | P2                                             |

#### 4.1.2 事件（Rust → 页面，单向广播）

| event 名     | payload           | 语义                    | Phase |
| ------------ | ----------------- | ----------------------- | ----- |
| agent-stdout | { agentId, line } | 子进程输出一行完整 JSON | P1    |
| agent-stderr | { agentId, line } | 子进程 stderr 行        | P1    |
| agent-exit   | { agentId, code } | 子进程退出              | P1    |
| term-stdout  | { termId, line }  | 终端命令输出行          | P1    |
| term-exit    | { termId, code }  | 终端命令退出            | P1    |

#### 4.1.3 确定性约束

- **单一编写者**：stdin 只在 Rust 层写，页面不得绕过 IPC 直接接触进程
- **行完整性**：`agent-stdout` 事件保证 payload.line 为完整一帧（行缓冲保证，见 4.2.3）
- **背压（P2 起）**：事件队列超长时合并节流，防 UI 假死

### 4.2 ACP 协议接口（页面状态机 ↔ harness 子进程）

#### 4.2.1 ACP 状态机处理的方法（按 ACP v1，protocolVersion=1）

**C→A（请求）**：`initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`

**A→C（请求，需响应）**：`fs/read_text_file`、`fs/write_text_file`、`terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/kill`、`session/request_permission`

**A→C（通知）**：`session/update`，contentBlock 类型按 4.2.3 渲染矩阵处理

#### 4.2.2 状态机状态集

`disconnected → initializing → initializing_wait → ready → prompting → prompting_wait`，外加 `error`、`dead`（终态，可重启回 ready）。

后续各期扩展的消息面：P2 加 `session/load`；P3 加 steering（follow_up 语义）；P4 与系统通知联动。

#### 4.2.3 render 矩阵（P1 验收基准）

| contentBlock 类型                    | P1 渲染                  | P3 升级       |
| ------------------------------------ | ------------------------ | ------------- |
| `agent_message_chunk`              | 流式追加                 | —            |
| `tool_call` / `tool_call_update` | 折叠块（图标+名称+状态） | 分组折叠+计时 |
| `agent_thought_chunk`              | 隐藏，计数的眉批行       | thinking 块   |
| `plan` / `file_change`           | 安全忽略+计数            | diff 视图     |
| `rpc_message` / `stdio`          | 安全忽略+计数            | —            |

---

## 5. 技术栈与工程约定

### 5.1 技术栈

| 层       | 选型                             | 说明     |
| -------- | -------------------------------- | -------- |
| 桌面框架 | Tauri 2                          | 见 DEC-1 |
| ACP 协议 | @agentclientprotocol/sdk（官方） | 见 DEC-7 |
| UI       | React 18 + TypeScript + Vite     |          |
| 状态     | zustand                          | 见 DEC-6 |
| 渲染     | react-markdown + Shiki（P3）     |          |
| 包管理   | pnpm                             |          |
| 构建     | Tauri CLI + GitHub Actions（P4） |          |

### 5.2 目录结构

```text
ainone-ui/
├─ src/
│  ├─ acp/            # ACP 状态机（纯 TS，无 DOM 依赖）
│  ├─ components/     # React 组件
│  ├─ stores/         # zustand
│  ├─ config/         # 适配器注册表读写
│  └─ bridge/         # IPC invoke/event 封装
├─ src-tauri/src/
│  ├─ process.rs      # 子进程管理
│  ├─ rpc.rs          # JSONL 解析/装配
│  └─ commands.rs     # [tauri::command] 集合
├─ docs/
│  ├─ plan.md         # 本计划书
│  ├─ acceptance/     # 每期验收执行记录（双签）
│  ├─ protocol-samples/ # P0 报文存档
│  └─ adr/            # 架构决策记录全本
├─ tools/spike/       # P0 验证脚本
└─ tests/
```

### 5.3 工程约定

- 提交：Conventional Commits（`feat(scope): …`）
- 分支：main 恒可用；feature 短分支；每期验收通过打 tag：P0→v0.0.1，P1→v0.1.0 …
- 测试策略：Rust 单测（rpc.rs 行解析/装配）+ TS 单测（状态机回放 P0 报文）+ 验收标准即 E2E 脚本
- 镜像：cargo 走 rsproxy.cn，pnpm 走 npmmirror（国内网络前提）

---

## 6. 阶段计划总览

每期完成都产生一个**可安装/可使用的增量**，验收通过即 Latch（状态锁定，只前进不回退）。

| 期 | 主题 | 一句话交付 | 主要需求 | 净工作日 |
| -- | ------ | -------------------------------- | ---------- | ------ |
| P0 | 技术验证 | 协议链路手动打通，报文存档       | REQ-1 组   | 0.5–1 |
| P1 | MVP      | OMP 一条链路端到端可用           | REQ-2 组   | 3–5   |
| P2 | 多 harness | 注册表+4 个 harness+会话恢复     | REQ-3/4 组 | 3–4   |
| P3 | 开发者体验 | diff/终端面板/steering/渲染升级  | REQ-5 组   | 4–6   |
| P4 | 分发打磨   | 三平台安装包+系统集成+i18n       | REQ-6/7 组 | 3–5   |
| P5 | 远期       | AG-UI 网关、远程 harness、成本统计 | 暂不展开 | —     |

---

## 7. 各期规格书

### 7.0 P0 · 技术验证（Spike）

**目的**：写 UI 之前先证明协议链路真实可通，fail fast。

**范围**：

1. Node 脚本（~50 行）spawn `omp`（ACP 模式），完成 `initialize` → `session/new` → `session/prompt`，打印全部事件
2. 报文存档 `docs/protocol-samples/`（每类事件 ≥1 条真实样例）
3. 受阻降级链：omp → claude-code-acp → pi-acp，选定 P1 主接入对象

**需求**：

| ID      | 需求                                        | 级别 |
| ------- | ------------------------------------------- | ---- |
| REQ-0-1 | 脚本完成 initialize 握手，protocolVersion=1 | M    |
| REQ-0-2 | 收到 ≥1 条 session/update 流式文本事件     | M    |
| REQ-0-3 | 触发并记录一次 request_permission 报文      | M    |
| REQ-0-4 | 触发并记录 fs/terminal 回调各一次           | M    |
| REQ-0-5 | 报文存档入 docs/protocol-samples/           | M    |
| REQ-0-6 | 明确 P1 主接入 harness 与启动命令           | M    |

**验收标准**（在干净环境执行，git tag `v0.0.1`）：

- **AC-P0-1**：执行 `ACP_ARGS="acp --model duo-king-6.6" node tools/spike/acp-probe.js`，脚本以退出码 0 结束，stdout 含 `initialize` 响应且 `protocolVersion` 为 1 → **已验证（2026-09-01）**
- **AC-P0-2**：同一运行中发送 prompt「say exactly: ACP-OK」，事件流中出现 `agent_message_chunk` 且最终拼出完整文本 `ACP-OK` → **已验证**
- **AC-P0-3**：`--approval-mode=always-ask` 下触发 `session/request_permission`，options 结构已存档（4 个选项，kind: allow_once/allow_always/reject_once/reject_always）→ **已验证**
- **AC-P0-4**：同一会话内触发 `fs/read_text_file` 与 `fs/write_text_file` 各一次并记录报文；`terminal/*` 未观察到（omp 在进程内执行 bash，见 P0 结论第 4 条）→ **已验证（含偏差记录）**
- **AC-P0-5**：`docs/protocol-samples/README.md` 列出每条样例的文件名、事件类型、触发命令 → **已验证**
- **AC-P0-6**：本节「P0 结论」小节已追加 → **已验证**

#### P0 结论（2026-09-01）

**主接入 harness**：omp（Oh My Pi v18.1.0），原生 ACP 服务器模式。

**启动命令**：

```bash
omp acp --model <model> [--approval-mode=always-ask]
```

**验证结论**：

1. ✅ 协议链路全通：initialize（protocolVersion=1）→ session/new → session/prompt → 流式 session/update → request_permission → fs 读写回调，全部按 ACP v1 规范往返
2. ✅ omp 原生 `omp acp` 子进程模式即标准 ACP 服务器，无需桥接器——P1 适配器配置零成本
3. ⚠️ **权限响应格式踩坑**：必须返回 `{outcome:{outcome:'selected', optionId:<options 里的 optionId>}}`；返回非标准结构（如 `{outcome:'rejected'}`）会导致 agent 报 "unknown option ID: undefined"——P1 状态机必须按此实现
4. ⚠️ **terminal/* 回调未出现**：omp 在自己进程内执行 bash（ACP client 的 terminal 能力未使用）。P1 的 `terminal/create` 等 Rust 代理降级为「按需实现、非阻塞验收项」；终端输出渲染从 `tool_call` 的 content 取
5. ⚠️ **模型前置条件**：omp 需在 `~/.omp/agent/models.yml` 配置自定义 provider（本机为自建 OpenAI 兼容网关，api 取值 `openai-completions`）才能调用模型；默认环境变量 OPENAI_API_BASE 不会被透传为 baseUrl
6. ✅ 消息流顺序已存档：`available_commands_update` → `session_info_update` → `agent_thought_chunk`×N → `tool_call` → `tool_call_update`×N → `agent_message_chunk`×N → `usage_update` → `session_info_update`

**P1 修订项**（写入 P1 实现要点）：

- 权限弹窗响应格式按踩坑记录第 3 条实现
- `terminal/*` Rust 代理从 M 降级为 S（非阻塞验收项）
- omp 适配器预置 `--approval-mode` 参数透传

---

### 7.1 P1 · MVP：端到端一条链路

**目标**：真实使用感——单 harness（P0 选定）完整对话，流式回复、权限审批、文件读写、命令执行、无残留进程。

#### 7.1.1 功能规格

**F-1-1 应用骨架**：Tauri 2 + React 脚手架，单窗口聊天界面：会话区 + 输入框 + 顶部 harness 选择（硬编码 P0 选定的 harness）。

**F-1-2 Rust 薄管道**：

- `agent_spawn` / `agent_send` / `agent_stop`，行缓冲解析，`agent-stdout/stderr/exit` 事件
- 关窗时 kill 进程树（macOS/Linux 进程组，Windows Job Object）

**F-1-3 ACP 状态机**（纯 TS）：请求 id 关联、事件分发、状态转换（§4.2.2）。

**F-1-4 权限审批**：弹窗展示请求详情，仅「允许一次 / 拒绝」。**永不对权限请求自动批准**。

**F-1-5 文件读写**：实现 `fs/read_text_file` / `fs/write_text_file` 的 Rust 代理。

**F-1-6 命令执行**：非交互 terminal 执行（spawn→收集输出→回传退出码），不做 PTY。

**F-1-7 容错**：协议边界的错误态全部可感知：命令不存在、子进程崩溃、断管 → 错误横幅+重启按钮，不白屏。

#### 7.1.2 已知技术风险与预防

- stdout 分片：Rust 按字节累积按 LF 切分（DEC-5）；单测覆盖「一行拆两 chunk」用例
- 未知 content type 容忍跳过
- 大流量时 UI 线程节流（P1 用简单缓冲合并）

#### 7.1.3 验收标准（git tag `v0.1.0`）

- **AC-P1-1**：`pnpm tauri dev` 一键启动，3 秒内出现聊天界面 → 通过
- **AC-P1-2**：发送「用一句话介绍你自己」，回复**逐字流式**出现（肉眼可见渐进，非一次性出现）→ 通过
- **AC-P1-3**：发送「在 /tmp/acp-p1/ 创建 hello.txt，内容 hi」→ 弹出权限框；点「允许」→ `/tmp/acp-p1/hello.txt` 存在且内容 hi；新会话重发同句点「拒绝」→ agent 收到拒绝后继续对话，会话未卡死 → 通过
- **AC-P1-4**：发送「读取 /etc/hostname 并复述」→ 对话流出现文件内容 → 通过
- **AC-P1-5**：发送「执行 ls -la 并报告结果」→ 折叠块展示输出，agent 复述退出码为 0 → 通过
- **AC-P1-6**：流式回复进行中点「停止」→ 流停止，随后可继续发新消息 → 通过
- **AC-P1-7**：对话中途关闭主窗口，2 秒内 `pgrep -f <harness-cmd>` 无输出 → 通过
- **AC-P1-8**：将适配器命令改为 `/nonexistent-cmd` 启动新会话 → 界面出现含命令名的错误提示，应用不崩溃不白屏 → 通过
- **AC-P1-9**：`cargo test` 全绿，其中含用例「一行 JSON 拆成 2 次 chunk 到达仍正确解析」→ 通过
- **AC-P1-10**：`pnpm test` 全绿，ACP 状态机用 `docs/protocol-samples/` 真实报文回放，断言状态转换与渲染分发正确 → 通过
- **AC-P1-11**：错误处理路径触发「子进程崩溃」→ 会话显示错误横幅，点重启后恢复可用 → 通过

#### 7.1.4 P1 完成后的用户能力

- 在一个窗口里和选定的 harness 完整对话：流式看回复
- agent 要写文件/跑命令时，由我批准或拒绝
- 中途叫停、重启、关闭，不留垃圾进程
- 这是「一个能用但只有一个 agent」的聊天客户端

---

### 7.2 P2 · 多 harness 与会话管理

**目标**：从「单 agent 聊天窗」升级为「多 agent 工作台」。

#### 7.2.1 功能规格

**F-2-1 适配器注册表**（M）：配置文件定义 harness `{id, name, command, args[]}`，位置 appConfigDir；设置页增删改查 + 可用性检测（which/版本探测）；预置 OMP/Pi/Claude Code/OpenCode 四条。

**F-2-2 会话管理**（M）：会话索引（appDataDir），记录 {sessionId, adapterId, 标题, mtime}；`session/load` 恢复；多 Tab 并行会话（每 Tab 独立子进程）。

**F-2-3 历史回填**（S）：恢复会话时回填历史消息（ACP 无标准拉取方法 → 解析 harness 本地会话文件，OMP/pi 的 JSONL 会话格式；Claude Code 读 `~/.claude/projects/`；OpenCode 存储目录。**逐 harness 调研，允许降级**为"仅显示上下文提示行"）。

**F-2-4 中断升级**（S）：关闭 Tab/应用退出时保证无残留进程（含 kill 树）；崩溃自动标记会话状态。

**F-2-5 agent 中途切换**（C）：会话内换 harness（fork 策略待定）。

#### 7.2.2 验收标准（git tag `v0.2.0`）

- **AC-P2-1**：设置页新增一条自定义适配器（command 指向 pi-acp 启动命令）→ 保存后新会话下拉框出现该项，**全程未改代码** → 通过
- **AC-P2-2**：OMP、Pi、Claude Code、OpenCode 四个 harness 各完成一次真实对话（其中一次含文件编辑+权限审批）→ 通过
- **AC-P2-3**：两个 Tab 分别运行 OMP 与 Pi 并同时对话 → 消息互不串扰（各自子进程独立）→ 通过
- **AC-P2-4**：会话中告知 agent 一个暗号（如 "banana-77"），退出应用（kill 窗口），重启后 `session/load` 该会话并询问暗号 → agent 能复述 → 通过
- **AC-P2-5**：运行中删除一个会话 Tab → 对应子进程 2 秒内消失 → 通过
- **AC-P2-6**：手工将适配器配置文件截断为非法 JSON → 应用启动不崩溃，提示配置损坏并引导修复 → 通过
- **AC-P2-7**：rust/TS 全部测试全绿 → 通过
- **AC-P2-8**（S 项允许延期）：恢复会话后历史消息可见（不含跨 harness 通用方案可降级为提示行）→ 通过或延期记录

#### 7.2.3 P2 完成后的用户能力

- 在设置里加任意 ACP 兼容 harness，立即在会话里使用
- 四个主流 harness 在同一界面并行使用、互相独立
- 昨天的会话今天续聊，agent 记得上下文
- 关闭应用永远不留僵尸进程

---

### 7.3 P3 · 开发者体验增强

**目标**：从「能用」到「好用」。

#### 7.3.1 功能规格

**F-3-1 diff 视图**（M）：`file_change` 渲染 unified diff（P3 内升级 side-by-side），Shiki 高亮，文件内多 hunk 折叠。
**F-3-2 终端面板**（M）：`terminal/*` 从折叠文本升级为流式滚动面板（自动跟随 + 手动锁定滚动）。
**F-3-3 Markdown 渲染升级**（M）：react-markdown + Shiki 代码高亮 + thinking 块折叠 + 工具调用分组（时间+耗时统计）。
**F-3-4 steering**（M）：agent 运行中插话：Enter=排队（当前工具完成后送达）/ Ctrl+Enter=打断重发（若 harness 支持 follow_up；不支持则降级为排队+提示）。
**F-3-5 性能**（M）：长会话虚拟列表；流式事件批处理（rAF 合并渲染）。
**F-3-6 主题**（S）：明暗主题切换。

#### 7.3.2 验收标准（git tag `v0.3.0`）

- **AC-P3-1**：发送「修改 src/app.ts 的第 10 行为注释」→ 界面出现 diff 视图，内容与 `git diff` 输出逐行一致 → 通过
- **AC-P3-2**：让 agent 执行 `for i in $(seq 1 20); do echo line-$i; sleep 0.5; done` → 终端面板逐条流式输出且不冻结 UI（交互期间界面可正常滚动/点按）→ 通过
- **AC-P3-3**：agent 输出含代码块的回复 → 代码高亮正确，块内一键复制可用，粘贴到编辑器格式无损 → 通过
- **AC-P3-4**：流式输出进行中发送「等等，改成先做 X」→ agent 在合理语义下响应插话（响应方式因 harness 而异，不要求跨 harness 一致）→ 通过
- **AC-P3-5**：导入 5000 条消息的测试会话 → 滚动流畅无肉眼可感卡顿（粗测 ≥30fps）→ 通过
- **AC-P3-6**：主题切换明暗 → 视觉正常，重启保持 → 通过
- **AC-P3-7**：全部测试绿 → 通过

#### 7.3.3 P3 完成后的用户能力

- 看见 agent 改了什么（diff 视图）
- 看见 agent 在终端里干了什么（流式面板）
- 跑一半时能插话改方向
- 长会话不再卡
- 聊天内容是真正的 Markdown 而不是纯文本

---

### 7.4 P4 · 打磨与分发

#### 7.4.1 功能规格

**F-4-1 三平台 CI 构建**（M）：GitHub Actions：macOS aarch64+x64、Ubuntu deb+AppImage、Windows NSIS。打 tag 触发 Release。
**F-4-2 系统集成**（M）：托盘（显示运行中会话数；退出时清理全部子进程）、agent 完成/等待权限时的系统通知（实时监听 `session/update` stopReason）、全局快捷键唤起。
**F-4-3 i18n**（S）：中/英，运行时切换。
**F-4-4 自动更新**（C）：tauri-plugin-updater。
**F-4-5 代码签名**（W）：暂不签（个人分发），文档说明各平台告警含义。

#### 7.4.2 验收标准（git tag `v1.0.0`）

- **AC-P4-1**：push tag `v1.0.0` → CI 产出三平台安装包（7 产物）并挂 Release → 通过
- **AC-P4-2**：在一台**未装开发环境**的干净机器（每平台各一）安装 → 启动 → 完成 AC-P1-2/3 的等价操作 → 通过
- **AC-P4-3**：应用切到后台，agent 完成长任务 → 收到系统通知；通知点击唤起窗口 → 通过
- **AC-P4-4**：托盘菜单退出 → 全部子进程 2 秒内清理 → 通过
- **AC-P4-5**：界面切换中文/英文 → 全 UI 无遗漏（构建时用脚本扫描硬编码字符串）→ 通过
- **AC-P4-7**：README 完整：安装、配置自定义适配器、故障排查 → 通过
- **AC-P4-8**：全部测试绿 + 三平台 smoke 测试通过 → 通过

---

#### 7.4.3 P4 完成后的用户能力

- 把安装包发给同事：三平台都能装能用
- 后台跑任务，完成时收到系统通知
- 中文界面
- v1.0.0 正式发布

## 8. 测试与验证策略

| 层        | 手段                         | 覆盖对象                        | Phase           |
| --------- | ---------------------------- | ------------------------------- | --------------- |
| 协议回归  | P0 报文存档回放测试          | ACP 状态机                      | P1 起每期       |
| Rust 单测 | cargo test                   | rpc.rs 行解析/装配、进程树 kill | P1 起每期       |
| TS 单测   | vitest                       | 状态机、配置读写                | P1 起每期       |
| E2E 手测  | 每期验收标准（本文件 §7）   | 用户路径                        | 每期 Latch 条件 |
| 性能      | 5000 条消息会话 + 长输出命令 | 渲染性能                        | P3              |
| 安装冒烟  | 干净虚拟机安装+首对话        | 分发产物                        | P4              |

**测试数据基线**：`docs/protocol-samples/` 的 P0 存档是协议层唯一回归基线，harness 升级导致样例漂移时须重录并记录偏差。

**验收流程**：每条 AC 由开发执行并留存证据（截图/命令输出）→ 项目所有者复验 → 双签记录入 `docs/acceptance/P<N>-<date>.md` → Latch，打 tag。

---

## 9. 需求追溯矩阵（摘要）

| 需求组  | 溯源          | 交付期 | 验证手段    |
| ------- | ------------- | ------ | ----------- |
| REQ-0-x | P0 spike 需求 | P0     | AC-P0-1…6  |
| REQ-1-x | F-1-1…F-1-7  | P1     | AC-P1-1…11 |
| REQ-2-x | F-2-1…F-2-5  | P2     | AC-P2-1…8  |
| REQ-3-x | F-3-1…F-3-6  | P3     | AC-P3-1…7  |
| REQ-4-x | F-4-1…F-4-5  | P4     | AC-P4-1…8  |

（需求组内编号见各期 §7.x.1；完整可追溯链：需求 → 功能项 F → 验收条目 AC → 测试证据，入 docs/acceptance/）

---

## 10. 术语表

| 术语 | 定义 |
| ---- | ---- |
| 方言（dialect） | 一个 agent 私有 RPC 协议的报文格式（如 pi 的 rpc 模式） |
| harness | coding agent 框架本体（OMP/Pi/Claude Code…），LLM 调用方 |
| ACP | Agent Client Protocol，Zed+JetBrains 维护的编辑器↔agent 开放协议（JSON-RPC over stdio，v1） |
| adapter（适配器） | 一条注册表配置：harness 的启动命令+参数 |
| bridge（桥接器） | 将私有 RPC 方言转译为 ACP 的外部小进程（如 pi-acp） |
| JSON-RPC 2.0 | ACP 的信封格式（method/params/id/result/error） |
| invoke / event | Tauri IPC 的请求与订阅原语 |
| sidecar | Tauri 打包随附的外部子进程模式 |
| agentId | ainone-ui 内部进程句柄（非 ACP sessionId） |
| Latch | 分期验收锁定：通过后状态不回退 |
| M/S/C/W | MoSCoW 需求分级 |
| MoSCoW | 功能优先级分级法（Must/Should/Could/Won't） |
| E2E | 端到端测试 |
| AC | 验收标准（Acceptance Criteria）条目 |
| F | 功能需求项 |
| REQ | 需求编号 |
| ADR | 架构决策记录 |
| i18n | 国际化 |
| PTY | 伪终端（交互式终端仿真） |

---

## 11. 开发环境与工具链

macOS 本机：rustup + Xcode CLT + Node 20+ + pnpm。cargo 镜像 rsproxy.cn、pnpm 镜像 npmmirror（国内网络）。CI 基础镜像三平台 runner。

---

## 12. 变更记录

| 日期       | 版本 | 变更                                                        | 决策人        |
| ---------- | ---- | ----------------------------------------------------------- | ------------- |
| 2026-09-01 | v1.0 | 初版创建：定位、范围、架构、P0–P4 规格与验收标准、追溯矩阵 | 所有者+Claude |

---

*本文档为 ainone-ui 开发基线。任何对范围、架构原则、验收标准的实质修改，须在 §11 登记新版本。*
