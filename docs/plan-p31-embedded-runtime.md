# P31 规格需求书：内嵌 bun 运行时——裸机全自动 + 安装链路全 pin

> 状态：**已确认**（用户 2026-09-08 拍板：内嵌 bun + 版本清单 + 三级解析 + npm 镜像回退；
> **CLI 本体安装不 pin**——CLI 是用户自治域，装 latest 与社区工具习惯一致）。
> 执行分支：`zhubaoduo/feat/p31_embedded_runtime`（基于 main @ 406a547）。
> 背景：全新裸机上 OpenCode 全自动可达，其余 4 harness 断在「缺 bun/npm」（装桥、跑桥、
> 装 codex/omp/pi CLI 三条链都依赖）。内嵌官方 bun 二进制作兜底运行时，DMG 9.3M → ~35M
> （预估，bun 61M 压缩后 ~25-30M），换取裸机 5/5 harness 全自动。

## 0. 背景与现状（探索结论）

### 依赖链路现状

| 环节 | 代码位置 | 现状 |
|---|---|---|
| 跑桥（spawn） | `agent.rs:spawn_bridge` | `find_program("bun")` → `find_program("node")` → 报错 |
| 装桥（懒装） | `connector.rs:install_runtime_candidates` | bun → npm 候选链，两者全缺则报错 |
| 装 codex/omp/pi CLI | `connector.rs:CLI_INSTALLERS` Package 候选 | 需 bun/npm 任一在 |
| 装 claude/opencode CLI | 同上 Script 候选 | 只需 curl+sh（系统自带），与本任务无关 |
| 四态判定 | `adapters.rs:cli_status` / `bridge_status` | `install_runtime_available()` = bun/npm 任一在 |

### 参照方案（本地四仓 + 社区调研，2026-09-08）

- **DeepChat**（最完整）：五源模型 bundled/managed/system/custom/unconfigured；
  `resources/runtime-versions.json` 单一 pin 源 + 包级 sha256 + 解压后可执行文件 sha256
  双重校验；版本兼容用区间 [min, max) 不接受 latest；npmmirror 镜像回退；demand 驱动按需装。
- **AionUi**：`aioncoreVersion` pin 在 package.json，CI `prepareAioncore.js` 下载 + 校验清单
  （缺一个文件整个构建 fail）；解析三级 env override → bundled → system PATH。
- **AgentTower**：零内嵌，但贡献关键坑——GUI 打包版 PATH 缺用户目录，shebang 脚本 spawn 会
  127 退出，须 `spawn(nodeBin, [script])` 显式执行。本仓 spawn_bridge 已是此形态。
- **社区共识**：所有「构建期自动下载的东西」精确 pin；版本升级收敛到发版流程；内嵌运行时
  但不内嵌业务 JS（保热修能力）；Claude Code 本身即 bun compile 分发，可靠性已验证。

### 关键决策（用户已拍板）

1. **内嵌 bun，不内嵌桥**：bun 打通「跑桥+装桥+装 codex/omp/pi CLI」三条断链；桥保持
   懒装（marker pin 热修能力保留，不用发应用版就能换桥版本）。
2. **CLI 本体安装不 pin**：`CLI_INSTALLERS` 的 Package 候选保持装 latest。理由：CLI 是
   用户自治域（与用户自己 `npm i -g` 等价），ACP 协议是稳定接口，本体版本漂移不破坏本仓。
3. **解析优先级**：custom（用户设置显式指定，本期不做 UI，仅留结构）> system PATH
   （尊重用户版本管理器）> bundled（包内兜底）。即用户自装 bun 在则用用户的，不在才用内嵌。
4. **npm 镜像回退**：官方 registry 安装失败后回退 npmmirror（中国网络刚需）。

### 范围外（明确不做）

- 不做 custom bun 路径的设置页 UI（解析结构留 custom 位，UI 后续任务）。
- 不内嵌桥 JS 包、不内嵌 node、不做 `bun build --compile` 单文件化。
- 不 pin CLI 本体版本（用户拍板排除）。
- 不动 harness 本体 CLI 的获取与升级（用户自治域）。
- Windows 分支的 unix 假设问题（env_path `:` 分隔符等）维持现状，另案处理。
- macOS 签名/公证未配置（CI secrets 未配），entitlements/重签名问题登记为发版前置任务，
  本期不实现。

---

## 任务一：bun 运行时解析三级化（Rust 核心）

### 目标

`spawn_bridge`（跑桥）与 `install_runtime_candidates`（装桥/装 CLI 的包管理器调用）在
system PATH 无 bun/npm 时，回落到应用内嵌的 bun；用户自装优先级仍最高。

### 方案

- 新模块 `src-tauri/src/embedded_runtime.rs`：
  - `pub fn resolve_bun(app: &AppHandle) -> Option<PathBuf>`：三级解析——
    1. `env_path::find_program("bun")`（system，命中即返回）；
    2. `app.path().resource_dir()/runtime/bun/bun`（bundled，存在且可执行才返回）。
  - `pub fn resolve_node(app: &AppHandle) -> Option<PathBuf>`：仅 system（node 不内嵌），
    即现有 `find_program("node")` 的包装。
  - `pub fn resolve_npm(app: &AppHandle) -> Option<(PathBuf, NpmSource)>`：npm 的解析带
    来源标签——
    1. system PATH 的 npm → `NpmSource::System`；
    2. system PATH 的 node 存在时，`node同级目录/npm`（node 自带 npm 不在 PATH 的边角）→
       `NpmSource::System`；
    3. **bundled bun 的包管理器等价物**：bun 本身可以当 npm 用（`bun add` 语义兼容），
       这一级不是 npm 而是内嵌 bun，返回 `(bun_path, NpmSource::BundledBun)`。
  - `pub fn runtime_version(path: &Path) -> Option<String>`：`<path> --version` 跑一次
    （5s 超时），返回首行 trim 结果；解析失败返回 None（不阻塞 spawn，仅诊断信息）。
- `agent.rs::spawn_bridge`：运行时解析改为
  `embedded_runtime::resolve_bun(app).or_else(|| embedded_runtime::resolve_node(app))`，
  命中 bundled bun 时日志标注 `source=bundled`。
- `connector.rs::install_runtime_candidates`：签名改为接收 `&AppHandle`（当前无参），
  候选链扩为：
  1. system bun（`bun add --omit=optional`）；
  2. system npm（`npm install --omit=optional --no-audit --no-fund`）；
  3. bundled bun（同 bun 参数）。
  `install_runtime_available()` 同步改为 `&AppHandle` 入参并纳入 bundled bun 判定——
  内嵌后该函数对预置桥恒真（bundled 兜底在），但保留函数供语义清晰。
- `connector.rs::run_argv`（CLI 安装执行层）与 `run_install`（桥安装执行层）：包管理器
  程序查找同样走 `resolve_npm` / `resolve_bun` 三级链。
- `adapters.rs::compute_status_inner` / `cli_status`：`install_runtime_available()` 调用点
  传入 app handle；`cli_installable` 判定从「bun 或 npm 在」升级为「bun 或 npm 或 bundled bun 在」。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 1.1 | system bun 在 → resolve_bun 返回 system 路径，bundled 不参与 | cargo test（注入 resource_dir 的单测） |
| 1.2 | system bun 缺、bundled 存在且可执行 → 返回 bundled 路径 | cargo test（临时目录伪造 resource_dir） |
| 1.3 | system 与 bundled 全缺 → None | cargo test |
| 1.4 | resolve_npm：system npm 在 → System；仅 node 在 → node 同级 npm；全缺 → BundledBun（bun 在时）| cargo test |
| 1.5 | spawn_bridge 用 bundled bun 起桥：进程成功拉起且 stdout 事件可达 | cargo test（集成，条件跑）+ 本机实测 |
| 1.6 | 装 CLI：bun/npm 全缺但 bundled bun 在 → codex/omp/pi 的 cli_installable = true | cargo test（compute_status 矩阵扩展） |
| 1.7 | `install_runtime_available` 带 bundled 判定后，预置桥 installable 判定不回归 | cargo test（bridge_state_matrix 扩展） |
| 1.8 | 前端四态 UI 无需改动即正确（Rust 判定变化自动透出）| 既有 vitest 全绿（SettingsModal 相关） |

## 任务二：runtime-versions.json 版本清单 + sha256 校验

### 目标

内嵌 bun 的版本与完整性有单一事实源；构建期校验（缺文件/哈希不符 = 打包失败）；
运行期首次使用时可选校验（诊断日志）。

### 方案

- 新文件 `src-tauri/resources/runtime-versions.json`（抄 DeepChat 结构精简版）：

```json
{
  "schemaVersion": 1,
  "bun": "1.3.x（以实际下载版本为准）",
  "bunArtifacts": {
    "darwin-arm64":  { "filename": "bun-darwin-aarch64.zip", "sha256": "…" },
    "darwin-x64":    { "filename": "bun-darwin-x64.zip",     "sha256": "…" },
    "linux-x64":     { "filename": "bun-linux-x64.zip",      "sha256": "…" },
    "windows-x64":   { "filename": "bun-windows-x64.zip",    "sha256": "…" }
  }
}
```

  linux-arm64 暂缺（CI 矩阵只有 ubuntu-22.04 x64）；后续加矩阵腿时同步补。
- Rust 侧解析：`embedded_runtime.rs` 增 `include_str!` 引入该 json（编译期内嵌，运行期
  无文件 IO），提供 `pub fn bundled_bun_sha256(target: &str) -> Option<&str>` 与
  `pub fn bundled_bun_version() -> &str`。resource_dir 下的 bun 实际文件与清单 sha256
  比对逻辑为 `verify_bundled(app) -> Result<(), String>`，**只在诊断命令里调用**（任务四），
  spawn 主链路不校验（61M 文件 sha256 一次 ~100ms，不值得每次 spawn 付）。
- 打包落地：bun 二进制放 `src-tauri/resources/runtime/{target_triple}/bun`，
  `tauri.conf.json` `bundle.resources` 增 `"resources/runtime/**"`。运行期
  `resource_dir()/runtime/{current_target_triple}/bun`。
- `.gitignore` 增 `src-tauri/resources/runtime/`（二进制不入库，CI 构建期下载）。
- dev 环境（`tauri dev`）无 resources 落盘到 target 目录的 guarantee——dev 下
  resource_dir 指向 `target/debug`，bun 二进制不在。**dev/单测下三级解析自然落到
  system bun，不阻塞开发**；提供 `AINONE_BUNDLED_BUN_DIR` 环境变量覆盖 resource 查找
  根（e2e 与手动验证内嵌链路用）。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 2.1 | 清单 json 解析纯函数：合法 → 版本+各 target sha256；缺 bun 字段/schemaVersion 错 → Err | cargo test |
| 2.2 | sha256 比对纯函数：文件哈希匹配/不匹配/文件缺失 三态正确 | cargo test（临时文件） |
| 2.3 | `tauri.conf.json` resources 声明存在且路径与 Rust 查找逻辑一致 | 代码走查 + 本地 `pnpm tauri:build` 后检查 .app 内文件落位 |
| 2.4 | `resources/runtime/` 不入库 | git status 干净（.gitignore 生效） |
| 2.5 | dev 下不装 bun 的机器行为：resolve 链落到 system，无 panic | cargo test + dev 冒烟 |

## 任务三：CLI 构建期脚本（下载 + sha256 校验）

### 目标

CI（及本地打包前）一键把对应平台的 bun 官方二进制按清单版本下载、校验、落位
`src-tauri/resources/runtime/{target}/bun`；校验失败即失败，绝不打包未验证的二进制。

### 方案

- 新脚本 `scripts/prepare-runtime.mjs`（Node 无依赖，CI 与本地通用）：
  1. 读 `runtime-versions.json`；
  2. 参数 `--target <triple>`（缺省 = 当前平台对应 triple）；
  3. 下载 `https://github.com/oven-sh/bun/releases/download/bun-v{ver}/{filename}` 到临时
     文件（跟随 redirect）；
  4. sha256 与清单比对（node:crypto），不符删除并 exit 1；
  5. 解压（zip；macOS/Linux 用 `unzip -o`，Windows 用 PowerShell Expand-Archive——
     两个平台 CI runner 自带，避免引入解压依赖）；
  6. 取出可执行文件重命名为 `bun`（Windows 为 `bun.exe`），落位
     `src-tauri/resources/runtime/{target}/`，`chmod +x`；
  7. 幂等：目标文件已存在且 sha256 匹配 → 跳过下载。
- `package.json` 增 script：`"prepare:runtime": "node scripts/prepare-runtime.mjs"`。
- `.github/workflows/release.yml`：build 作业在 `Build frontend` 前插一步
  `node scripts/prepare-runtime.mjs --target <matrix target triple>`（矩阵四腿各下各的）。
- 脚本不进 `beforeBuildCommand`（保持 `pnpm build` 纯前端语义；CI 显式调用 + 本地手动跑，
  意图清晰且不拖慢日常 dev）。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 3.1 | 本机跑 `pnpm prepare:runtime`：bun 落位 + sha256 匹配 + 可执行 | 本机实测 + `bun --version` 输出与清单一致 |
| 3.2 | 幂等：二次运行跳过下载（输出 skip 提示） | 本机实测 |
| 3.3 | 清单 sha256 改错一位 → 脚本 exit 1 且临时文件清理 | 本机实测（改临时副本） |
| 3.4 | `--target` 交叉参数：本机跑 `--target x86_64-unknown-linux-gnu` 能下载 linux 版并落位 | 本机实测 |
| 3.5 | release.yml 四腿各自调用正确 target | 代码走查 + 下次 tag 发版实测（本地 yml 语法自检） |

## 任务四：npm 镜像回退（中国网络刚需）

### 目标

npm registry 安装（桥 + CLI 的 Package 候选）失败时自动回退 npmmirror 重试一轮；
bun 安装同理（bun 走 `--registry` 参数）。

### 方案

- `connector.rs` 安装候选从「运行时维度」升级为「运行时 × registry 维度」：
  `install_runtime_candidates` 返回 `Vec<InstallCandidate>`，
  `InstallCandidate { program: PathBuf, args: Vec<String>, label: String }`：
  1. system bun + 官方源；
  2. system npm + 官方源；
  3. bundled bun + 官方源；
  4. system bun + npmmirror（`--registry https://registry.npmmirror.com`）；
  5. system npm + npmmirror；
  6. bundled bun + npmmirror。
  （顺序 = 运行时优先级优先于镜像回退；同一候选失败即试下一个。）
- `run_cli_candidate` 的 Package 分支同样接 registry 回退（bun add --global 与
  npm install --global 各自追加 `--registry`）。
- CLI 安装失败报错文案含「已尝试官方源与 npmmirror」提示。
- 不做用户可配置 registry（范围外，settings UI 后续任务）。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 4.1 | 候选生成纯函数：bun/npm/bundled 三态 × 双 registry = 正确候选序列 | cargo test |
| 4.2 | 官方源失败 → 依次回退到 npmmirror 候选（逐级，不跳级）| cargo test（mock 运行时注入） |
| 4.3 | 全部候选失败 → 报错文案含两个源都试过的信息 | cargo test + 代码走查 |
| 4.4 | `--registry` 只作用于安装参数，不污染 spawn 桥的 env | 代码走查 + 既有 spawn 测试 |

## 任务五：诊断命令（前端可见的内嵌状态）

### 目标

设置页能展示运行时解析结果（哪个 bun、什么版本、sha 是否通过），供用户排障与
未来「custom bun」UI 铺路。

### 方案

- Rust 新命令 `runtime_diagnostics(app) -> RuntimeDiagnostics`：

```rust
struct RuntimeDiagnostics {
  bun: Option<RuntimeInfo>,        // 解析结果 + source(system/bundled) + version
  npm: Option<RuntimeInfo>,
  bundled_dir_exists: bool,        // resource_dir/runtime 是否落位
  bundled_sha_verified: Option<bool>, // Some=已校验结果；None=文件缺失未校验
}
struct RuntimeInfo { path: String, source: String, version: Option<String> }
```

  sha 校验在这里才执行（诊断是低频路径，100ms 可接受）。
- 前端 `src/ipc/runtime.ts` 薄封装 + 设置页 Claude Code 卡片区不动——**本期只在
  设置页 harness 区块尾部加一行小字状态**（如「运行时：bun 1.3.4（内嵌）」或
  「运行时：bun 1.3.4（系统）」），点开显示 path。样式极简，不做独立设置项。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 5.1 | runtime_diagnostics 三态输出正确（system 在 / 仅 bundled / 全无）| cargo test（resource_dir 注入） |
| 5.2 | 前端封装与渲染：mock 三态快照 | vitest |
| 5.3 | 设置页小字状态在 dev（system bun）下正确显示 | 本机 dev 冒烟 |

## 任务六：CI 集成 + 文档

### 目标

release 四腿自动带上对应平台内嵌 bun；README/官网说明更新。

### 方案

- `release.yml`：build 矩阵增 `triple` 字段（aarch64-apple-darwin 等，args 里已有，
  抽出复用），`Prepare runtime` 步骤 `node scripts/prepare-runtime.mjs --target ${{ matrix.triple }}`。
- Rust 单测跑在无内嵌环境（CI 无 prepare 步骤的 test 作业？——本仓 CI 无独立 test 作业，
  cargo test 全在本地跑；CI build 作业带 prepare，不影响）。
- README「环境要求」小节：说明内嵌 bun 的存在与三级优先级；「支持的 harness」表
  更新备注列。
- latest.json / R2 上传逻辑不动（DMG 变大自动生效）。

### 验收标准

| # | 验收项 | 判定方式 |
|---|---|---|
| 6.1 | yml 矩阵 triple 与 args 一致，prepare 步骤语法正确 | 代码走查 + actionlint（本地有则跑） |
| 6.2 | README 更新后与实际行为一致 | 走查 |
| 6.3 | 本地全量构建 `pnpm tauri:build` 成功，DMG 体积记录进提交信息 | 本机实测 |

---

## 测试总盘

**Rust（cargo test）**：
- `embedded_runtime` 模块：解析三级矩阵（1.1-1.4）、清单解析（2.1）、sha 比对（2.2）、
  诊断三态（5.1）。resource_dir 依赖通过 `resolve_in(root: &Path, …)` 纯函数分层 +
  AppHandle 包装层薄到不可测（与 connector.rs resolve_in 同款手法）。
- `connector` 扩展：候选生成矩阵（4.1/4.2/4.3）、install_runtime_available bundled 判定
  （1.7）、compute_status 四态扩展（1.6）。
- 存量回归：105 条全绿。

**前端（vitest）**：
- `src/ipc/runtime.ts` 封装 + SettingsModal 运行时小字渲染（5.2）。
- 存量回归：530+ 全绿（SettingsModal 四态文案不受 Rust 判定变化影响——判定值变了
  但枚举与字段形状不变）。

**本地实测（不进 CI）**：
- 3.1/3.2/3.3/3.4 脚本实测；1.5 bundled bun 起桥实测（AINONE_BUNDLED_BUN_DIR 指向
  手工落位目录）；6.3 全量构建 + DMG 体积核对。

## 提交切分（预计 5-6 个 commit）

1. `feat(p31): embedded_runtime 模块——bun 三级解析 + 清单解析 + sha 校验（纯函数全测）`
2. `feat(p31): spawn/install 链路接入三级解析——跑桥/装桥/装 CLI 全走 resolve 链`
3. `feat(p31): npm 镜像回退——安装候选×registry 矩阵`
4. `feat(p31): prepare-runtime.mjs 构建脚本 + runtime-versions.json + gitignore`
5. `feat(p31): runtime_diagnostics 命令 + 设置页运行时状态行`
6. `ci(release): 矩阵腿接入 prepare-runtime + README 环境说明`

## 风险与回退

- **内嵌 bun 与 system bun 版本差**：三级解析保证 system 优先，bundled 只兜底缺失场景，
  版本差仅影响本来就无法工作的机器——风险低。
- **桥依赖 native 模块**：三桥 `--omit=optional` 后均纯 JS（connector.rs 注释实测），
  bun 运行无 ABI 问题。
- **DMG 体积**：预估 ~35M；超预期（>60M）时回退方案 = 从 bundle.resources 移除即回到
  懒装现状，代码路径全兼容（resolve 链自然落到 system-only）。
- **macOS Gatekeeper**：未签名分发现状下 spawn 子进程不触发双击校验；将来配签名时
  登记的 entitlements/重签名任务必须先落地（范围外已声明）。
