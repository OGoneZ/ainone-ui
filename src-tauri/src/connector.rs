// ACP 桥接器懒安装（DeepChat 式，用户选定方案）：
//
// 桥（ACP ↔ 各家 CLI 的转接头，纯 JS npm 包）不打进安装包（安装包体积红线：
// 当前 DMG ~9.3M，claude+pi 两桥合并去重 63M/压缩包 8M，实测否决内嵌）。
// 首次使用（点「开始对话」或设置页「测试连接」）时自动
// `bun add --omit=optional <pkg>@<pin>` 到 appConfigDir/acp-connector/<program>/，
// harness 本体 CLI 用用户已装的（经 spec.cli_env 注入绝对路径，见 agent.rs）。
//
// --omit=optional 对三个桥都必要：claude 桥省去 SDK 平台二进制（245M→53M），
// codex 桥省去捆绑的 @openai/codex 平台子包（296M→17M），pi 桥无 optional 无害。
//
// 解析优先级：用户 PATH 自装的桥 > 应用管理的桥。
// 安装运行时：bun 优先，失败回退 npm（两者实测各有快慢场合）。

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// 一条懒装桥的登记项。新增桥 = 在 BRIDGES 加一行。
#[derive(Debug, Clone, Copy)]
pub struct BridgeSpec {
    /// 适配器 program 名（find_program / adapter_status 用它检索）
    pub program: &'static str,
    /// npm 包名
    pub pkg: &'static str,
    /// 版本 pin（应用升级时同步改，marker 失配自动重装）
    pub version: &'static str,
    /// 桥依赖的 harness 本体 CLI 程序名（决定 installable 判据 + 注入路径）
    pub cli_program: &'static str,
    /// 本体绝对路径注入的 env 名（各桥官方覆盖点；None = 桥自己走 PATH）
    pub cli_env: Option<&'static str>,
    /// 老布局兼容（v0.7.0 期 claude 桥装平铺在 acp-connector/ 根）
    pub legacy_flat: bool,
}

pub const BRIDGES: &[BridgeSpec] = &[
    BridgeSpec {
        program: "claude-agent-acp",
        pkg: "@agentclientprotocol/claude-agent-acp",
        version: "0.73.0",
        cli_program: "claude",
        cli_env: Some("CLAUDE_CODE_EXECUTABLE"), // acp-agent.js claudeCliPath() 官方覆盖点
        legacy_flat: true,
    },
    BridgeSpec {
        program: "pi-acp",
        pkg: "pi-acp",
        version: "0.0.33",
        cli_program: "pi",
        cli_env: Some("PI_ACP_PI_COMMAND"), // dist/index.js 的 pi 命令覆盖点
        legacy_flat: false,
    },
    // codex 接入（懒装家族第三席）：@agentclientprotocol/codex-acp@1.10.0 已实测
    // --omit=optional 后 17M/19 包 + CODEX_PATH 指向用户 codex 握手通过；
    // spawn 侧 bridge_env_inject 的 codex-acp 分支（AINONE_CODEX_API_KEY 注入）随本表生效。
    BridgeSpec {
        program: "codex-acp",
        pkg: "@agentclientprotocol/codex-acp",
        version: "1.10.0",
        cli_program: "codex",
        cli_env: Some("CODEX_PATH"),
        legacy_flat: false,
    },
];

/// 按适配器 program 名查桥登记（非懒装程序返回 None → 走普通 PATH 语义）。
pub fn bridge_spec(program: &str) -> Option<&'static BridgeSpec> {
    BRIDGES.iter().find(|s| s.program == program)
}

// ---------------------------------------------------------------------------
// CLI 一键安装（P29 任务一）：与桥安装解耦的两层补齐中的第一层。
// 装的是 harness 本体 CLI，全部免 sudo 用户级落点；装完由 find_program 真值
// 验证（CLI 无版本 marker）。失败不清理任何东西——CLI 装到系统用户目录，
// 保留已装部分，下次打开按真实状态判定，断点续补。
// ---------------------------------------------------------------------------

/// CLI 安装候选的类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliCandidateKind {
    /// 官方安装脚本：curl -fsSL <url> -o <tmp> && sh <tmp>（两步 argv，不跑 shell 管道）
    Script { url: &'static str },
    /// 包管理器全局安装（bun 优先 npm 回退，与桥安装同回退序）
    Package { runtime: Runtime, pkg: &'static str },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Runtime {
    Bun,
    Npm,
}

impl Runtime {
    fn program(self) -> &'static str {
        match self {
            Runtime::Bun => "bun",
            Runtime::Npm => "npm",
        }
    }
}

impl CliCandidateKind {
    /// 测试与文案用：Package 的包名（Script 无包名，返回 url）。
    pub fn pkg_name(&self) -> &'static str {
        match self {
            CliCandidateKind::Script { url } => url,
            CliCandidateKind::Package { pkg, .. } => pkg,
        }
    }
}

/// 一条 CLI 安装登记项。新增 harness 的 CLI 安装 = 在 CLI_INSTALLERS 加一行。
#[derive(Debug, Clone, Copy)]
pub struct CliSpec {
    /// find_program 检索名（装完验证用）
    pub program: &'static str,
    /// 错误/文案用显示名
    pub display: &'static str,
    /// 有序候选链：先脚本后包管理器（脚本无 node/bun 依赖）
    pub candidates: &'static [CliCandidateKind],
}

pub const CLI_INSTALLERS: &[CliSpec] = &[
    CliSpec {
        program: "claude",
        display: "Claude Code",
        candidates: &[CliCandidateKind::Script {
            url: "https://claude.ai/install.sh",
        }],
    },
    CliSpec {
        program: "opencode",
        display: "OpenCode",
        candidates: &[CliCandidateKind::Script {
            url: "https://opencode.ai/install",
        }],
    },
    CliSpec {
        program: "codex",
        display: "Codex",
        candidates: &[
            CliCandidateKind::Package { runtime: Runtime::Bun, pkg: "@openai/codex" },
            CliCandidateKind::Package { runtime: Runtime::Npm, pkg: "@openai/codex" },
        ],
    },
    CliSpec {
        program: "omp",
        display: "Oh My Pi",
        candidates: &[
            CliCandidateKind::Package { runtime: Runtime::Bun, pkg: "@oh-my-pi/pi-coding-agent" },
            CliCandidateKind::Package { runtime: Runtime::Npm, pkg: "@oh-my-pi/pi-coding-agent" },
        ],
    },
    CliSpec {
        program: "pi",
        display: "Pi",
        candidates: &[
            CliCandidateKind::Package { runtime: Runtime::Bun, pkg: "@mariozechner/pi-coding-agent" },
            CliCandidateKind::Package { runtime: Runtime::Npm, pkg: "@mariozechner/pi-coding-agent" },
        ],
    },
];

pub fn cli_spec(program: &str) -> Option<&'static CliSpec> {
    CLI_INSTALLERS.iter().find(|s| s.program == program)
}

/// 候选当前是否可用（Script 恒可用；Package 需对应 runtime 在）。
/// 纯函数——runtime 可用性由调用方注入，便于单测。
pub fn candidate_available(candidate: &CliCandidateKind, bun_in: bool, npm_in: bool) -> bool {
    match candidate {
        CliCandidateKind::Script { .. } => true,
        CliCandidateKind::Package { runtime, .. } => match runtime {
            Runtime::Bun => bun_in,
            Runtime::Npm => npm_in,
        },
    }
}

/// 纯函数：CLI 是否存在可用的安装候选（四态判定中 cli_installable 的判据）。
pub fn cli_installable(spec: &CliSpec, bun_in: bool, npm_in: bool) -> bool {
    spec.candidates
        .iter()
        .any(|c| candidate_available(c, bun_in, npm_in))
}

/// opencode 官方脚本支持 --no-modify-path（不写 shell profile），兑现「不替用户改配置」。
const OPENCODE_SCRIPT_ARGS: &[&str] = &["--no-modify-path"];

/// 已安装桥的信息（spawn 时由 agent.rs 消费）
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedBridge {
    /// 桥入口 JS 的绝对路径
    pub entry: String,
    pub version: String,
}

/// 安装进度事件（Channel 推送；错误走命令返回值，不在此列）
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "payload", rename_all = "camelCase")]
pub enum BridgeEvent {
    /// 安装器的一行输出（截断后），前端原样展示
    Progress(String),
    Done,
}

/// 桥安装根（acp-connector/）：新布局在其下按 program 分目录
fn bridges_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?
        .join("acp-connector");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建桥目录失败: {e}"))?;
    Ok(dir)
}

/// 纯函数：桥的 node_modules/<pkg> 路径（pkg 含 scope 时天然成两级目录）
pub fn pkg_dir(install_dir: &Path, pkg: &str) -> PathBuf {
    install_dir.join("node_modules").join(pkg)
}

/// 纯函数：桥入口 JS（三个桥 bin 统一指向 dist/index.js）
pub fn entry_path(install_dir: &Path, pkg: &str) -> PathBuf {
    pkg_dir(install_dir, pkg).join("dist").join("index.js")
}

fn marker_path(install_dir: &Path, version: &str) -> PathBuf {
    install_dir.join(format!("installed-{version}"))
}

fn installed_at(install_dir: &Path, pkg: &str, version: &str) -> bool {
    entry_path(install_dir, pkg).is_file() && marker_path(install_dir, version).exists()
}

/// 纯函数：在 appConfigDir 下解析已装桥（新布局 → 老平铺布局回退）。
/// AppHandle 版与单测版共用此逻辑。
pub fn resolve_in(config_dir: &Path, spec: &BridgeSpec) -> Option<ResolvedBridge> {
    let dir = config_dir.join("acp-connector").join(spec.program);
    if installed_at(&dir, spec.pkg, spec.version) {
        return Some(ResolvedBridge {
            entry: entry_path(&dir, spec.pkg).to_string_lossy().into_owned(),
            version: spec.version.into(),
        });
    }
    if spec.legacy_flat {
        // v0.7.0 期老布局：平铺在 acp-connector/ 根（pin 升级后自动走新布局重装）
        let legacy = config_dir.join("acp-connector");
        if installed_at(&legacy, spec.pkg, spec.version) {
            return Some(ResolvedBridge {
                entry: entry_path(&legacy, spec.pkg).to_string_lossy().into_owned(),
                version: spec.version.into(),
            });
        }
    }
    None
}

/// 已装桥解析（应用管理目录；PATH 自装优先由调用方先判）
pub fn resolve_managed(app: &AppHandle, spec: &BridgeSpec) -> Option<ResolvedBridge> {
    let config_dir = app.path().app_config_dir().ok()?;
    resolve_in(&config_dir, spec)
}

/// 一条安装候选：运行时 × registry 的组合（P31 镜像回退）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallCandidate {
    /// 包管理器可执行文件绝对路径
    pub program: PathBuf,
    /// 完整参数（含子命令；registry 回退时含 --registry）
    pub args: Vec<String>,
    /// 日志/文案标签（如 "bun (system)"、"bun (npmmirror)"）
    pub label: String,
}

/// npmmirror 镜像（中国网络官方源不稳的回退，DeepChat 同款策略）。
const NPM_MIRROR: &str = "https://registry.npmmirror.com";

/// 纯函数：把一组运行时命中组装成「官方源 → npmmirror」的候选序列。
/// 顺序 = 运行时优先级优先于镜像回退（同一运行时先官方后镜像，再换下一运行时）。
/// bun_args/npm_args 由调用方按场景给（桥装用 --omit=optional，CLI 装用 --global）。
pub fn build_install_candidates(
    buns: &[PathBuf],
    npms: &[PathBuf],
    bun_args: &[&str],
    npm_args: &[&str],
) -> Vec<InstallCandidate> {
    let mut out = Vec::new();
    for (paths, base_args, kind) in [
        (buns, bun_args, "bun"),
        (npms, npm_args, "npm"),
    ] {
        for path in paths {
            // 官方源
            out.push(InstallCandidate {
                program: path.clone(),
                args: base_args.iter().map(|s| s.to_string()).collect(),
                label: format!("{kind} (官方源)"),
            });
            // npmmirror 回退
            let mut mirror_args: Vec<String> = base_args.iter().map(|s| s.to_string()).collect();
            mirror_args.push("--registry".into());
            mirror_args.push(NPM_MIRROR.into());
            out.push(InstallCandidate {
                program: path.clone(),
                args: mirror_args,
                label: format!("{kind} (npmmirror)"),
            });
        }
    }
    out
}

/// 安装运行时候选（P31 三级运行时 × 双 registry）：
/// system bun → system npm → bundled bun，各自先官方源后 npmmirror。
fn install_runtime_candidates(app: &AppHandle) -> Vec<InstallCandidate> {
    let mut buns: Vec<PathBuf> = Vec::new();
    let mut npms: Vec<PathBuf> = Vec::new();
    // system bun
    if let Some(h) = crate::env_path::find_program("bun") {
        buns.push(h.path);
    }
    // system npm（resolve_npm 内含 node 同级探测；NpmSource::System 才算 npm 候选，
    // BundledBun 形态归入 bundled bun 候选避免重复）
    match crate::embedded_runtime::resolve_npm(app) {
        Some((p, crate::embedded_runtime::NpmSource::System)) => npms.push(p),
        _ => {}
    }
    // bundled bun（system bun 已在时 resolve_bun 返回 system，须单独取 bundled）
    if let Some((p, src)) = crate::embedded_runtime::resolve_bun(app) {
        if src == "bundled" {
            buns.push(p);
        }
    }
    build_install_candidates(
        &buns,
        &npms,
        &["add", "--omit=optional"],
        &["install", "--omit=optional", "--no-audit", "--no-fund"],
    )
}

/// 环境是否具备懒装条件（adapter_status 的 installable 判据之一）。
/// P31：内嵌 bun 兜底后预置桥恒可装（bundled 在则真），保留函数保语义清晰。
pub fn install_runtime_available(app: &AppHandle) -> bool {
    !install_runtime_candidates(app).is_empty()
}

/// 触发安装（幂等：已装直接返回）。bun→npm 依次尝试，逐行推进度；
/// 单轮 15 分钟超时（网络挂死的兜底），全败清半成品目录留待重试。
pub async fn install_bridge(
    app: &AppHandle,
    spec: &BridgeSpec,
    on_event: Option<Channel<BridgeEvent>>,
) -> Result<ResolvedBridge, String> {
    if let Some(b) = resolve_managed(app, spec) {
        return Ok(b);
    }
    // 串行化并发安装（同目录并发写 = ETXTBSY/半成品；向导+测试连接可能同刻点）
    let _guard = install_lock().lock().await;
    if let Some(b) = resolve_managed(app, spec) {
        return Ok(b); // 等锁期间别的调用装完了
    }

    let candidates = install_runtime_candidates(app);
    if candidates.is_empty() {
        return Err("未找到可用的包管理器（bun/npm/内嵌 bun 均不可用），无法安装桥接器。".into());
    }
    let dir = bridges_root(app)?.join(spec.program);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建桥目录失败: {e}"))?;
    // package.json 是安装器的锚点（无它会向上级目录找）
    let pkg_anchor = dir.join("package.json");
    if !pkg_anchor.exists() {
        std::fs::write(&pkg_anchor, r#"{"name":"ainone-acp-bridge","private":true}"#)
            .map_err(|e| format!("写入 package.json 失败: {e}"))?;
    }

    let spec_arg = format!("{}@{}", spec.pkg, spec.version);
    let mut last_err = String::new();
    for (idx, candidate) in candidates.iter().enumerate() {
        let is_last = idx + 1 == candidates.len();
        log::info!(
            "[bridge] 安装 {} → {} [{}]（{}）",
            spec_arg,
            candidate.program.display(),
            candidate.label,
            dir.display()
        );
        match run_install(&candidate.program, &candidate.args, &spec_arg, &dir, &on_event).await {
            Ok(()) => {
                std::fs::write(marker_path(&dir, spec.version), spec.version)
                    .map_err(|e| format!("写入安装标记失败: {e}"))?;
                log::info!("[bridge] {} 安装完成", spec.pkg);
                if let Some(ch) = &on_event {
                    let _ = ch.send(BridgeEvent::Done);
                }
                return resolve_managed(app, spec)
                    .ok_or_else(|| format!("安装成功但未找到入口 JS（{spec_arg}）"));
            }
            Err(e) => {
                last_err = e;
                log::warn!("[bridge] 候选 {} 失败: {last_err}", candidate.label);
                if is_last {
                    // 自愈：删半成品，下次重试从干净状态开始
                    let _ = std::fs::remove_dir_all(&dir);
                }
            }
        }
    }
    Err(format!(
        "桥接器 {spec_arg} 安装失败（已尝试官方源与 npmmirror 镜像）：{last_err}。检查网络后重试。"
    ))
}

/// 跑一轮安装器，逐行转发输出；超时 kill。
async fn run_install(
    runtime: &Path,
    base_args: &[String],
    spec_arg: &str,
    dir: &Path,
    on_event: &Option<Channel<BridgeEvent>>,
) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;

    let mut cmd = Command::new(runtime);
    cmd.args(base_args)
        .arg(spec_arg)
        .current_dir(dir)
        .env("PATH", crate::env_path::enhanced_path())
        .env("npm_config_progress", "false") // npm 进度条走 \r，关掉换成逐行日志
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("启动 {} 失败: {e}", runtime.display()))?;
    let stdout = child.stdout.take().ok_or("无法读取安装输出")?;
    let stderr = child.stderr.take().ok_or("无法读取安装错误输出")?;

    // stdout/stderr 各一线程逐行转发，之后 wait 收退出码
    async fn pump<R: tokio::io::AsyncRead + Unpin>(r: R, on_event: &Option<Channel<BridgeEvent>>) {
        use tokio::io::BufReader;
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            if let Some(ch) = &on_event {
                let clipped: String = t.chars().take(160).collect();
                let _ = ch.send(BridgeEvent::Progress(clipped));
            }
        }
    }
    let read_loop = async {
        tokio::join!(pump(stdout, on_event), pump(stderr, on_event));
        child.wait().await
    };
    let status = tokio::time::timeout(std::time::Duration::from_secs(900), read_loop)
        .await
        .map_err(|_| "安装超时（15 分钟）".to_string())?
        .map_err(|e| format!("等待安装进程失败: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("退出状态 {status}"))
    }
}

fn install_lock() -> &'static tokio::sync::Mutex<()> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::const_new(()))
}

/// 安装命令（前端进度流入口：Channel 收 Progress，命令 resolve = 成功）。
#[tauri::command]
pub async fn bridge_install(
    app: AppHandle,
    program: String,
    on_event: Channel<BridgeEvent>,
) -> Result<(), String> {
    let spec = bridge_spec(&program).ok_or_else(|| format!("{program} 不是懒装桥"))?;
    install_bridge(&app, spec, Some(on_event)).await.map(|_| ())
}

/// CLI 安装事件（与 BridgeEvent 同形：逐行输出 + 完成标记，前端可共用渲染）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "payload", rename_all = "camelCase")]
pub enum CliInstallEvent {
    Progress(String),
    Done,
}

/// CLI 安装命令（P29 任务一）。复用桥安装的锁/进度/超时机制；与装桥解耦——
/// 失败不清理（CLI 装到用户目录），装完以 find_program 真值验证。
#[tauri::command]
pub async fn cli_install(
    app: AppHandle,
    program: String,
    on_event: Channel<CliInstallEvent>,
) -> Result<(), String> {
    let spec = cli_spec(&program).ok_or_else(|| format!("{program} 没有 CLI 安装登记"))?;
    install_cli(&app, spec, Some(on_event)).await
}

/// 已装 CLI 就直接返回（幂等）；否则按候选链依次尝试。
/// 候选可用性前置判定：全不可用直接报缺失运行时，不空跑。
/// P31：bun 判定走三级解析（system → bundled），registry 镜像回退在候选执行层。
pub async fn install_cli(
    app: &AppHandle,
    spec: &CliSpec,
    on_event: Option<Channel<CliInstallEvent>>,
) -> Result<(), String> {
    if crate::env_path::find_program(spec.program).is_some() {
        return Ok(());
    }
    let bun_in = crate::embedded_runtime::resolve_bun(app).is_some();
    let npm_in = crate::embedded_runtime::resolve_npm(app).is_some();
    if !cli_installable(spec, bun_in, npm_in) {
        return Err(format!(
            "无法安装 {}：缺少 bun 或 npm（脚本安装候选不存在）。请先安装 bun（curl -fsSL https://bun.sh/install | bash）或 Node.js ≥20。",
            spec.display
        ));
    }

    // 串行化并发安装（与桥安装共用一把锁：两者都会起包管理器子进程，
    // 同刻并发会互相拖慢且日志交错；锁粒度粗一点换来行为可预期）
    let _guard = install_lock().lock().await;
    if crate::env_path::find_program(spec.program).is_some() {
        return Ok(()); // 等锁期间别的调用装完了
    }

    let mut last_err = String::new();
    let n = spec.candidates.len();
    for (idx, candidate) in spec.candidates.iter().enumerate() {
        if !candidate_available(candidate, bun_in, npm_in) {
            continue;
        }
        let is_last = idx + 1 == n;
        log::info!("[cli] 安装 {} 候选 {}/{}", spec.display, idx + 1, n);
        match run_cli_candidate(app, spec, candidate, &on_event).await {
            Ok(()) => {
                if let Some(ch) = &on_event {
                    let _ = ch.send(CliInstallEvent::Done);
                }
                return crate::env_path::find_program(spec.program)
                    .map(|_| ())
                    .ok_or_else(|| format!("安装流程结束但未找到 {} 命令（请检查安装输出）", spec.display));
            }
            Err(e) => {
                last_err = e;
                log::warn!("[cli] {} 候选失败: {last_err}", spec.display);
                // 不清理：CLI 装到用户目录，半成品由各安装器自管；
                // 已装部分保留，失败即停在该候选链尽头的报错。
            }
        }
        if !is_last {
            continue;
        }
    }
    Err(format!("{} CLI 安装失败：{last_err}", spec.display))
}

/// 跑一个安装候选：Script = curl 下载到临时文件后 sh 执行（两步 argv，
/// 不跑 shell 管道，URL 固定无注入面）；Package = bun/npm 全局安装。
async fn run_cli_candidate(
    app: &AppHandle,
    spec: &CliSpec,
    candidate: &CliCandidateKind,
    on_event: &Option<Channel<CliInstallEvent>>,
) -> Result<(), String> {
    match candidate {
        CliCandidateKind::Script { url } => {
            let tmp = std::env::temp_dir().join(format!("ainone-cli-install-{}-{}.sh", spec.program, std::process::id()));
            std::fs::remove_file(&tmp).ok();
            let curl = crate::env_path::find_program("curl")
                .map(|h| h.path)
                .ok_or("缺少 curl，无法下载安装脚本")?;
            let sh = crate::env_path::find_program("sh")
                .map(|h| h.path)
                .or_else(|| crate::env_path::find_program("bash").map(|h| h.path))
                .ok_or("缺少 sh/bash，无法执行安装脚本")?;
            let download = RunSpec {
                argv: vec![
                    curl.to_string_lossy().into_owned(),
                    "-fsSL".into(),
                    (*url).into(),
                    "-o".into(),
                    tmp.to_string_lossy().into_owned(),
                ],
            };
            progress_line(on_event, &format!("下载安装脚本 {url}…"));
            run_argv(app, &download, on_event).await.map_err(|e| format!("下载失败: {e}"))?;
            let mut script_argv = vec![sh.to_string_lossy().into_owned(), tmp.to_string_lossy().into_owned()];
            if spec.program == "opencode" {
                script_argv.extend(OPENCODE_SCRIPT_ARGS.iter().map(|s| s.to_string()));
            }
            let exec = RunSpec { argv: script_argv };
            let r = run_argv(app, &exec, on_event).await;
            std::fs::remove_file(&tmp).ok();
            r
        }
        CliCandidateKind::Package { runtime, pkg } => {
            // P31：运行时三级链 × registry 双源——bun 候选走 system→bundled bun，
            // npm 候选走 system npm；每级先官方源后 npmmirror（build_install_candidates）。
            let (buns, npms) = runtime_paths(app);
            let (bun_args, npm_args): (&[&str], &[&str]) = match runtime {
                Runtime::Bun => (&["add", "--global"], &[]),
                Runtime::Npm => (
                    &[],
                    &["install", "--global", "--no-audit", "--no-fund"],
                ),
            };
            let (paths, base, kind): (&[PathBuf], &[&str], &str) = match runtime {
                Runtime::Bun => (&buns, bun_args, "bun"),
                Runtime::Npm => (&npms, npm_args, "npm"),
            };
            let mut candidates = build_install_candidates(paths, &[], base, &[]);
            let _ = kind;
            // npmmirror 回退候选（官方源失败逐级补上）
            let mirrors = build_mirror_candidates(paths, base, kind_label(kind));
            candidates.extend(mirrors);
            if candidates.is_empty() {
                return Err(format!("未找到 {}（bun/npm/内嵌 bun 均不可用）", runtime.program()));
            }
            let mut last_err = String::new();
            for cand in &candidates {
                let mut argv = vec![cand.program.to_string_lossy().into_owned()];
                argv.extend(cand.args.iter().cloned());
                argv.push((*pkg).to_string());
                progress_line(on_event, &format!("尝试 {}…", cand.label));
                match run_argv(app, &RunSpec { argv }, on_event).await {
                    Ok(()) => return Ok(()),
                    Err(e) => {
                        last_err = e;
                        log::warn!("[cli] {} 候选失败: {last_err}", cand.label);
                    }
                }
            }
            Err(format!(
                "{} 安装失败（已尝试官方源与 npmmirror 镜像）：{last_err}",
                runtime.program()
            ))
        }
    }
}

/// 一次进程调用的参数（统一走 run_argv：增强 PATH env + 逐行进度 + 15min 超时）。
struct RunSpec {
    argv: Vec<String>,
}

/// 当前机器的 bun/npm 可执行路径集（P31 CLI Package 候选执行层用）：
/// buns = [system bun?, bundled bun?]；npms = [system npm?]。
fn runtime_paths(app: &AppHandle) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut buns = Vec::new();
    let mut npms = Vec::new();
    // system bun（resolve_bun 只回一个，bundled 被 system 遮蔽时单独补）
    let system_bun = crate::env_path::find_program("bun");
    if let Some(h) = &system_bun {
        buns.push(h.path.clone());
    }
    if system_bun.is_none() {
        if let Some((p, "bundled")) = crate::embedded_runtime::resolve_bun(app) {
            buns.push(p);
        }
    }
    if let Some((p, crate::embedded_runtime::NpmSource::System)) =
        crate::embedded_runtime::resolve_npm(app)
    {
        npms.push(p);
    }
    (buns, npms)
}

/// kind 标签（日志/进度文案用）。
fn kind_label(kind: &str) -> &'static str {
    match kind {
        "bun" => "bun",
        _ => "npm",
    }
}

/// 纯函数：镜像回退候选（官方源失败后逐个补上，--registry 追加在尾部）。
fn build_mirror_candidates(
    paths: &[PathBuf],
    base_args: &[&str],
    kind: &'static str,
) -> Vec<InstallCandidate> {
    paths
        .iter()
        .map(|path| {
            let mut args: Vec<String> = base_args.iter().map(|s| s.to_string()).collect();
            args.push("--registry".into());
            args.push(NPM_MIRROR.into());
            InstallCandidate {
                program: path.clone(),
                args,
                label: format!("{kind} (npmmirror)"),
            }
        })
        .collect()
}

fn progress_line(on_event: &Option<Channel<CliInstallEvent>>, line: &str) {
    if let Some(ch) = on_event {
        let clipped: String = line.chars().take(160).collect();
        let _ = ch.send(CliInstallEvent::Progress(clipped));
    }
}

/// 清洗安装器输出行（UI 尾迹展示用）：
/// 1) 剥离 ANSI 转义序列（\x1b[…m 颜色/样式、\x1b]…\x07 标题等）——脚本在
///    非 TTY 下也常打印颜色码，WebView 里渲染为乱码；
/// 2) 丢弃行首孤立 "-e " 前缀——脚本用 `echo -e`，dash/sh 不支持 -e 时把
///    "-e" 当字面量打出来（opencode 安装脚本实测出现）；
/// 3) 去掉 \r 前的旧内容（spinner/进度条行：`xxx\ryyy` 只留 yyy）。
fn sanitize_progress_line(line: &str) -> String {
    // \r 处理：取最后一个 \r 之后的内容（进度条刷新语义 = 覆盖前行）
    let line = match line.rfind('\r') {
        Some(i) => &line[i + 1..],
        None => line,
    };
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // CSI 序列：\x1b[ … 直到字母；OSC：\x1b] … 直到 \x07 或 \x1b\\
            if let Some(&n) = chars.peek() {
                if n == '[' {
                    for c2 in chars.by_ref() {
                        if c2.is_ascii_alphabetic() {
                            break;
                        }
                    }
                    continue;
                }
                if n == ']' {
                    for c2 in chars.by_ref() {
                        if c2 == '\x07' {
                            break;
                        }
                    }
                    continue;
                }
                continue; // 其他单字符转义（\x1b\\ 等）直接丢弃
            }
            continue;
        }
        out.push(c);
    }
    let t = out.trim();
    t.strip_prefix("-e ").unwrap_or(t).to_string()
}

/// 跑一轮安装进程：逐行转发输出（stdout/stderr 合流语义由安装器保证，
/// 这里两路各自转发），15 分钟超时 kill，退出码非零报错。
/// 与 run_install（桥安装）的差异：argv 直接给定、失败不清理、事件类型为 CliInstallEvent。
async fn run_argv(
    _app: &AppHandle,
    spec: &RunSpec,
    on_event: &Option<Channel<CliInstallEvent>>,
) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;

    let (program, args) = spec.argv.split_first().ok_or("空 argv")?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env("PATH", crate::env_path::enhanced_path())
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .env("npm_config_progress", "false")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("启动 {program} 失败: {e}"))?;
    let stdout = child.stdout.take().ok_or("无法读取安装输出")?;
    let stderr = child.stderr.take().ok_or("无法读取安装错误输出")?;

    async fn pump<R: tokio::io::AsyncRead + Unpin>(r: R, on_event: &Option<Channel<CliInstallEvent>>) {
        use tokio::io::BufReader;
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let t = sanitize_progress_line(&line);
            if t.is_empty() {
                continue;
            }
            progress_line(on_event, &t);
        }
    }
    let read_loop = async {
        tokio::join!(pump(stdout, on_event), pump(stderr, on_event));
        child.wait().await
    };
    let status = tokio::time::timeout(std::time::Duration::from_secs(900), read_loop)
        .await
        .map_err(|_| "安装超时（15 分钟）".to_string())?
        .map_err(|e| format!("等待安装进程失败: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("退出状态 {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_installed(dir: &Path, pkg: &str, version: &str) {
        std::fs::create_dir_all(entry_path(dir, pkg).parent().unwrap()).unwrap();
        std::fs::write(entry_path(dir, pkg), "// stub").unwrap();
        std::fs::write(marker_path(dir, version), version).unwrap();
    }

    #[test]
    fn bridge_spec_lookup() {
        assert!(bridge_spec("claude-agent-acp").is_some());
        assert_eq!(bridge_spec("pi-acp").unwrap().pkg, "pi-acp");
        // codex 已接入懒装家族：CODEX_PATH 注入 + 官方 env_key 机制（keys.json）
        let codex = bridge_spec("codex-acp").expect("codex-acp 应已登记");
        assert_eq!(codex.pkg, "@agentclientprotocol/codex-acp");
        assert_eq!(codex.version, "1.10.0");
        assert_eq!(codex.cli_program, "codex");
        assert_eq!(codex.cli_env, Some("CODEX_PATH"));
        // omp/opencode 是原生 ACP 不入表
        assert!(bridge_spec("omp").is_none());
    }

    #[test]
    fn scoped_pkg_path_nests_correctly() {
        let p = entry_path(Path::new("/base"), "@agentclientprotocol/claude-agent-acp");
        assert_eq!(
            p.to_string_lossy().replace('\\', "/"),
            "/base/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"
        );
    }

    #[test]
    fn resolve_in_new_layout_and_marker_required() {
        let base = std::env::temp_dir().join(format!("ainone-bridge-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let spec = bridge_spec("pi-acp").unwrap();
        let dir = base.join("acp-connector").join("pi-acp");

        // 空目录 → None
        assert!(resolve_in(&base, spec).is_none());
        // 只下载未标记（缺 marker）→ None（半成品不算装好）
        std::fs::create_dir_all(entry_path(&dir, spec.pkg).parent().unwrap()).unwrap();
        std::fs::write(entry_path(&dir, spec.pkg), "// stub").unwrap();
        assert!(resolve_in(&base, spec).is_none());
        // marker 到位 → Some，entry 绝对路径
        std::fs::write(marker_path(&dir, spec.version), spec.version).unwrap();
        let r = resolve_in(&base, spec).unwrap();
        assert_eq!(r.version, spec.version);
        assert!(r.entry.ends_with("node_modules/pi-acp/dist/index.js"));

        // 版本 pin 换 → 老 marker 失配 → None（触发重装）
        let mut bumped = *spec;
        bumped.version = "9.9.9";
        assert!(resolve_in(&base, &bumped).is_none());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resolve_in_legacy_flat_only_for_claude() {
        let base = std::env::temp_dir().join(format!("ainone-bridge-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let spec = bridge_spec("claude-agent-acp").unwrap();
        // 老平铺布局：acp-connector/ 根下直接 node_modules + marker
        write_installed(&base.join("acp-connector"), spec.pkg, spec.version);
        let r = resolve_in(&base, spec).expect("老布局应被回退命中");
        assert!(r.entry.contains("acp-connector/node_modules"));
        // 非 legacy 桥（pi-acp）即使同布局也不算
        assert!(resolve_in(&base, bridge_spec("pi-acp").unwrap()).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cli_spec_lookup() {
        assert!(cli_spec("claude").is_some());
        assert!(cli_spec("opencode").is_some());
        assert_eq!(cli_spec("codex").unwrap().candidates.len(), 2);
        assert_eq!(cli_spec("pi").unwrap().candidates[0].pkg_name(), "@mariozechner/pi-coding-agent");
        // 未登记程序（如自定义 harness 的 program）→ None
        assert!(cli_spec("my-agent").is_none());
    }

    #[test]
    fn candidate_availability_matrix() {
        // 脚本候选恒可用（curl/sh 由 run_cli_candidate 届时报，不在判定层）
        let script = CliCandidateKind::Script { url: "https://x/install" };
        assert!(candidate_available(&script, false, false));
        // 包候选按 runtime 在否
        let bun_pkg = CliCandidateKind::Package { runtime: Runtime::Bun, pkg: "p" };
        let npm_pkg = CliCandidateKind::Package { runtime: Runtime::Npm, pkg: "p" };
        assert!(candidate_available(&bun_pkg, true, false));
        assert!(!candidate_available(&bun_pkg, false, true));
        assert!(candidate_available(&npm_pkg, false, true));
        assert!(!candidate_available(&npm_pkg, true, false));
    }

    #[test]
    fn cli_installable_any_candidate_hits() {
        // codex：bun 或 npm 任一在即可装
        let codex = cli_spec("codex").unwrap();
        assert!(cli_installable(codex, true, false));
        assert!(cli_installable(codex, false, true));
        assert!(!cli_installable(codex, false, false));
        // claude 只有脚本候选 → 恒 installable（缺 curl/sh 由执行层报）
        let claude = cli_spec("claude").unwrap();
        assert!(cli_installable(claude, false, false));
    }

    #[test]
    fn sanitize_strips_ansi_and_e_prefix() {
        // 实机观察：opencode 安装脚本在非 TTY 下仍打印 ANSI 颜色 + `echo -e` 被
        // sh 当字面量打出 "-e " 前缀
        assert_eq!(
            sanitize_progress_line("\x1b[32m\x1b[0mInstalling opencode version: 1.18.29"),
            "Installing opencode version: 1.18.29"
        );
        // 行首 -e 前缀（echo -e 降级为字面量）
        assert_eq!(sanitize_progress_line("-e Installing opencode…"), "Installing opencode…");
        // 正常文本不受影响
        assert_eq!(sanitize_progress_line("bun add v1.3.14"), "bun add v1.3.14");
        // 纯转义行 → 空（上层过滤空行）
        assert_eq!(sanitize_progress_line("\x1b[36m\x1b[0m"), "");
        // \r 刷新语义：留最后一段
        assert_eq!(sanitize_progress_line("10%\r\n25%\r50%"), "50%");
        // OSC 标题序列
        assert_eq!(sanitize_progress_line("\x1b]0;title\x07done"), "done");
    }
}
