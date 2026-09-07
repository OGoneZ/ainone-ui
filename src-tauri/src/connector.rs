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
    // codex 预留入口（懒装家族第三席）：@agentclientprotocol/codex-acp@1.10.0 已实测
    // --omit=optional 后 17M/19 包 + CODEX_PATH 指向用户 codex 握手通过；
    // 等官方桥形态探索定稿后取消注释即接入（其余机制零改动）。
    // BridgeSpec {
    //     program: "codex-acp",
    //     pkg: "@agentclientprotocol/codex-acp",
    //     version: "1.10.0",
    //     cli_program: "codex",
    //     cli_env: Some("CODEX_PATH"),
    //     legacy_flat: false,
    // },
];

/// 按适配器 program 名查桥登记（非懒装程序返回 None → 走普通 PATH 语义）。
pub fn bridge_spec(program: &str) -> Option<&'static BridgeSpec> {
    BRIDGES.iter().find(|s| s.program == program)
}

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

/// 安装运行时候选：bun 优先，失败回退 npm（node 无包管理器不算候选）。
fn install_runtime_candidates() -> Vec<(PathBuf, Vec<&'static str>)> {
    let mut out = Vec::new();
    if let Some(h) = crate::env_path::find_program("bun") {
        out.push((h.path, vec!["add", "--omit=optional"]));
    }
    if let Some(h) = crate::env_path::find_program("npm") {
        out.push((h.path, vec!["install", "--omit=optional", "--no-audit", "--no-fund"]));
    }
    out
}

/// 环境是否具备懒装条件（adapter_status 的 installable 判据之一）。
pub fn install_runtime_available() -> bool {
    crate::env_path::find_program("bun").is_some() || crate::env_path::find_program("npm").is_some()
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

    let candidates = install_runtime_candidates();
    if candidates.is_empty() {
        return Err("未找到 bun 或 npm，无法安装桥接器。请先安装 bun（curl -fsSL https://bun.sh/install | bash）或 Node.js ≥20。".into());
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
    for (idx, (runtime, base_args)) in candidates.iter().enumerate() {
        let is_last = idx + 1 == candidates.len();
        log::info!("[bridge] 安装 {} → {}（{}）", spec_arg, runtime.display(), dir.display());
        match run_install(runtime, base_args, &spec_arg, &dir, &on_event).await {
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
                log::warn!("[bridge] 运行时 {} 失败: {last_err}", runtime.display());
                if is_last {
                    // 自愈：删半成品，下次重试从干净状态开始
                    let _ = std::fs::remove_dir_all(&dir);
                }
            }
        }
    }
    Err(format!(
        "桥接器 {spec_arg} 安装失败：{last_err}。检查网络后重试。"
    ))
}

/// 跑一轮安装器，逐行转发输出；超时 kill。
async fn run_install(
    runtime: &Path,
    base_args: &[&'static str],
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
        // codex 预留未接入；omp/opencode 是原生 ACP 不入表
        assert!(bridge_spec("codex-acp").is_none());
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
}
