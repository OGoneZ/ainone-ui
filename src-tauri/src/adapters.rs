// 适配器注册表：harness 的启动配置，持久化在 appConfigDir/adapters.json。
//
// 一条适配器 = 一个可经 ACP 驱动的 harness。新增 harness 只需在这里加配置，
// 不改前端逻辑（见 plan.md DEC-4 / F-2-1）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Adapter {
    pub id: String,
    pub name: String,
    /// 可执行程序名（如 "omp"，须已在 capability 的 shell scope 中注册）
    pub program: String,
    /// 启动参数
    pub args: Vec<String>,
    /// 默认工作目录占位（真实 cwd 由前端在会话创建时覆盖为会话目录）
    pub cwd: String,
    /// 头像品牌色（hex，如 "#7c3aed"）。None = 用灰色首字母占位（plan-v2 F-4-1）
    #[serde(default)]
    pub logo: Option<String>,
}

/// 预置适配器：OMP / Pi / Claude Code / Codex / OpenCode。
/// Pi / Claude Code / Codex 走懒装桥（connector.rs BRIDGES 表，首次使用自动装）；
/// omp / opencode 原生 ACP，需本机自装。
/// 注意：参数不得含机器相关的模型名（历史上 omp 硬编码 duo-king-6.6 导致
/// 换机器必现「No model selected」，见 P28 修复），模型交给 harness 自身配置。
pub fn defaults() -> Vec<Adapter> {
    vec![
        Adapter {
            id: "omp".into(),
            name: "Oh My Pi".into(),
            program: "omp".into(),
            args: vec!["acp".into()],
            cwd: ".".into(),
            logo: Some("#7c3aed".into()),
        },
        Adapter {
            id: "pi".into(),
            name: "Pi".into(),
            program: "pi-acp".into(),
            args: Vec::new(),
            cwd: ".".into(),
            logo: Some("#2563eb".into()),
        },
        Adapter {
            id: "claude-code".into(),
            name: "Claude Code".into(),
            program: "claude-agent-acp".into(),
            args: Vec::new(),
            cwd: ".".into(),
            logo: Some("#d97706".into()),
        },
        Adapter {
            id: "codex".into(),
            name: "Codex".into(),
            program: "codex-acp".into(),
            args: Vec::new(),
            cwd: ".".into(),
            logo: Some("#16a34a".into()),
        },
        Adapter {
            id: "opencode".into(),
            name: "OpenCode".into(),
            program: "opencode".into(),
            args: vec!["acp".into()],
            cwd: ".".into(),
            logo: Some("#dc2626".into()),
        },
    ]
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("adapters.json"))
}

/// 读取适配器列表；文件缺失时返回预置默认值并尝试落盘。
#[tauri::command]
pub fn adapters_list(app: tauri::AppHandle) -> Result<Vec<Adapter>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        let d = defaults();
        save_to(&path, &d)?;
        return Ok(d);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取适配器配置失败: {e}"))?;
    let mut list: Vec<Adapter> =
        serde_json::from_str(&raw).map_err(|e| {
            log::warn!("[adapters] 配置 JSON 损坏: {e}");
            format!("适配器配置解析失败（JSON 损坏）: {e}")
        })?;
    migrate_in_place(&mut list);
    log::debug!("[adapters] 读取 {} 条适配器", list.len());
    Ok(list)
}

/// 旧配置轻量迁移（纯函数，可单测）。
pub fn migrate_in_place(list: &mut Vec<Adapter>) {
    for preset in defaults() {
        if let Some(e) = list.iter_mut().find(|e| e.id == preset.id) {
            // v0.3.x 无 logo 字段 → 用 defaults 补齐
            if e.logo.is_none() {
                e.logo = preset.logo;
            }
            // P28：老预置 omp 带着机器相关的 --model duo-king-6.6（换机必挂），
            // 检测到这一精确旧值即重置为当前预置参数；用户自己改过的不动。
            if e.id == "omp" && e.args.windows(2).any(|w| w == ["--model", "duo-king-6.6"]) {
                e.args = preset.args.clone();
            }
        }
    }
}

/// 覆盖保存全部适配器。
#[tauri::command]
pub fn adapters_save(app: tauri::AppHandle, adapters: Vec<Adapter>) -> Result<(), String> {
    let path = config_path(&app)?;
    save_to(&path, &adapters)
}

fn save_to(path: &PathBuf, adapters: &[Adapter]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(adapters).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("写入适配器配置失败: {e}"))
}

/// 检测某程序是否可用（增强 PATH 命中 或 懒装桥已装，见 connector.rs）。
#[tauri::command]
pub fn adapter_available(app: tauri::AppHandle, program: String) -> bool {
    let managed = crate::connector::bridge_spec(&program)
        .and_then(|s| crate::connector::resolve_managed(&app, s));
    compute_status_inner(&program, managed.as_ref(), runtime_ok(&app)).state
        == AdapterState::Ready
}

/// P31：真机运行时可用性（bun/npm/bundled bun 任一在）。
/// 调 install_runtime_candidates 空跑组装一次（纯内存查文件，无进程拉起，微秒级）。
fn runtime_ok(app: &tauri::AppHandle) -> bool {
    crate::connector::install_runtime_available(app)
}

/// 四态（P29 扩展）：已可用 / 可懒装桥 / **CLI 可一键装（新增）** / 真未装。
/// 判定纯逻辑见 compute_status。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterState {
    Ready,
    Installable,
    CliInstallable,
    Absent,
}

/// 懒装桥的元信息（installable/absent 的成因透出给前端组文案；非桥程序为 null）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub pkg: String,
    pub version: String,
    /// harness 本体 CLI 程序名（absent 文案点名「先装 X」用）
    pub cli_program: String,
    /// harness 本体 CLI 是否在增强 PATH（缺 → 装桥也没用）
    pub cli_available: bool,
    /// bun/npm 安装运行时是否在（缺 → 装不了桥）
    pub runtime_available: bool,
}

/// CLI 安装元信息（cli_installable/absent 的成因透出给前端组文案；非登记程序为 None）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInstallInfo {
    /// 显示名（错误文案点名用）
    pub display: String,
    /// 存在可用安装候选（bun/npm 缺失时 false → 按钮禁用 + 文案点名）
    pub installable: bool,
}

// ---------------------------------------------------------------------------
// 认证态探测（P29 任务二）：只读文件、不回传密钥。三态：
//   Subscription = 订阅登录（OAuth 凭据）；Api = API key 配置；None = 未配置。
// 探测失败（文件缺失/损坏/读不了）一律 None，不报错——认证态是尽力而为的信息。
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthState {
    Subscription,
    Api,
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthInfo {
    pub state: AuthState,
    /// 文案细节（如「已登录订阅」「API 已配置」；None 时为空）
    pub detail: String,
}

impl AuthInfo {
    fn none() -> AuthInfo {
        AuthInfo { state: AuthState::None, detail: String::new() }
    }
}

/// 从 Claude credentials 文本探测订阅登录态（OAuth 凭据文件，含 oauth 字段才算）。
pub fn claude_credentials_text(raw: &str) -> bool {
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
    v.get("claudeAiOauth").is_some()
        || v.get("oauthAccount").is_some()
        || v.get("access_token").is_some()
        || v.get("tokens").is_some()
}

/// 从 Claude settings 文本探测 API 配置态（env 里有 AUTH_TOKEN / API_KEY）。
pub fn claude_settings_has_api(raw: &str) -> bool {
    let v: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
    let env = v.get("env");
    ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
        .iter()
        .any(|k| {
            env.and_then(|e| e.get(k))
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.trim().is_empty())
        })
}

/// 从 Codex auth.json 文本探测：tokens = 订阅；OPENAI_API_KEY = API。
pub fn codex_auth_text(raw: &str) -> AuthState {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return AuthState::None;
    };
    if v.get("tokens").map(|t| !t.is_null()).unwrap_or(false) {
        return AuthState::Subscription;
    }
    let key = v
        .get("OPENAI_API_KEY")
        .or_else(|| v.get("openai_api_key"))
        .and_then(|k| k.as_str());
    if key.is_some_and(|k| !k.trim().is_empty()) {
        return AuthState::Api;
    }
    AuthState::None
}

/// 通用「auth.json 非空对象 = 已配置」探测（pi / opencode 用）。
pub fn auth_json_nonempty(raw: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    v.as_object().is_some_and(|o| !o.is_empty())
}

/// 按预置 harness id 探测认证态（home 注入便于单测；生产传 None 用 dirs::home_dir）。
pub fn probe_auth(adapter_id: &str, home: Option<&std::path::Path>) -> AuthInfo {
    let Some(home) = home.map(|h| h.to_path_buf()).or_else(dirs::home_dir) else {
        return AuthInfo::none();
    };
    match adapter_id {
        "claude-code" => {
            let creds = std::fs::read_to_string(home.join(".claude/.credentials.json"))
                .ok()
                .map(|raw| claude_credentials_text(&raw))
                .unwrap_or(false);
            if creds {
                return AuthInfo { state: AuthState::Subscription, detail: "已登录订阅".into() };
            }
            let api = std::fs::read_to_string(home.join(".claude/settings.json"))
                .ok()
                .map(|raw| claude_settings_has_api(&raw))
                .unwrap_or(false);
            if api {
                AuthInfo { state: AuthState::Api, detail: "API 已配置".into() }
            } else {
                AuthInfo::none()
            }
        }
        "codex" => {
            match std::fs::read_to_string(home.join(".codex/auth.json")) {
                Ok(raw) => match codex_auth_text(&raw) {
                    AuthState::Subscription => {
                        AuthInfo { state: AuthState::Subscription, detail: "已登录 ChatGPT 订阅".into() }
                    }
                    AuthState::Api => AuthInfo { state: AuthState::Api, detail: "API 已配置".into() },
                    AuthState::None => AuthInfo::none(),
                },
                Err(_) => AuthInfo::none(),
            }
        }
        "pi" | "omp" => {
            // pi / omp 同属 pi 体系，共用 ~/.pi/agent/auth.json
            match std::fs::read_to_string(home.join(".pi/agent/auth.json")) {
                Ok(raw) if auth_json_nonempty(&raw) => {
                    AuthInfo { state: AuthState::Api, detail: "已配置".into() }
                }
                _ => AuthInfo::none(),
            }
        }
        "opencode" => {
            let p = home.join(".local/share/opencode/auth.json");
            match std::fs::read_to_string(&p) {
                Ok(raw) if auth_json_nonempty(&raw) => {
                    AuthInfo { state: AuthState::Api, detail: "已配置".into() }
                }
                _ => AuthInfo::none(),
            }
        }
        _ => AuthInfo::none(),
    }
}

/// 检测结果详情：四态 + 绝对路径与命中来源 + CLI 安装信息 + 认证态（UI 展示与一键装用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStatus {
    /// 兼容字段：state == ready（前端旧代码与测试仍读它）
    pub available: bool,
    pub state: AdapterState,
    pub resolved_path: Option<String>,
    pub source: Option<String>,
    pub bridge: Option<BridgeInfo>,
    /// P29：CLI 一键安装元信息（CLI 已在或非登记程序为 None）
    pub cli: Option<CliInstallInfo>,
    /// P29：认证态（订阅登录 / API 配置 / 未配置）
    pub auth: AuthInfo,
}

#[tauri::command]
pub fn adapter_status(app: tauri::AppHandle, program: String) -> AdapterStatus {
    let managed = crate::connector::bridge_spec(&program)
        .and_then(|s| crate::connector::resolve_managed(&app, s));
    compute_status_inner(&program, managed.as_ref(), runtime_ok(&app))
}

/// 四态判定核心（PATH 检索走 env_path 真机；桥/CLI 分支的可用性输入由调用方注入
/// → 逻辑本体在 bridge_status / cli_status，纯函数可单测）：
///   1. PATH 命中                    → ready（source 记命中目录类别）
///   2. 懒装桥托管目录已装           → ready（source = ManagedBridge）
///   3. 懒装桥 + 本体 CLI 在 + 运行时在 → installable
///   4. CLI 未装 + 登记在 CLI_INSTALLERS + 有可用候选 → cli_installable（P29）
///   5. 其余                         → absent（bridge/cli 元信息解释缺哪块）
/// P31：runtime_ok 参数注入（bun/npm/bundled bun 任一在 = true），
/// 纯函数不依赖 AppHandle，真机判定由调用方算好传入。
pub fn compute_status_inner(
    program: &str,
    managed: Option<&crate::connector::ResolvedBridge>,
    runtime_ok: bool,
) -> AdapterStatus {
    if let Some(hit) = crate::env_path::find_program(program) {
        return AdapterStatus {
            available: true,
            state: AdapterState::Ready,
            resolved_path: Some(hit.path.to_string_lossy().into_owned()),
            source: Some(
                serde_json::to_value(&hit.source)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_default(),
            ),
            bridge: None,
            cli: None,
            auth: probe_auth_by_program(program),
        };
    }
    // CLI 已在但桥不在 → bridge_status 分支（installable / absent）
    // CLI 不在 → cli_status 分支（cli_installable / absent）
    match crate::connector::bridge_spec(program) {
        Some(s) => {
            let cli_hit = crate::env_path::find_program(s.cli_program);
            match cli_hit {
                Some(_) => bridge_status(s, managed, true, runtime_ok),
                None => cli_status(program, runtime_ok),
            }
        }
        None => cli_status(program, runtime_ok),
    }
}

/// CLI 未装前提下的状态归类（纯逻辑层——cli 分支不涉及桥）。
/// P31：runtime_ok = bun/npm/bundled bun 任一可用（真机判定由调用方注入）。
fn cli_status(program: &str, runtime_ok: bool) -> AdapterStatus {
    let cli = crate::connector::cli_spec(program).map(|s| CliInstallInfo {
        display: s.display.into(),
        installable: runtime_ok
            && crate::connector::cli_installable(s, true, true),
    });
    let installable = cli.as_ref().is_some_and(|c| c.installable);
    AdapterStatus {
        available: false,
        state: if installable { AdapterState::CliInstallable } else { AdapterState::Absent },
        resolved_path: None,
        source: None,
        bridge: None,
        cli,
        auth: probe_auth_by_program(program),
    }
}

/// program 名 → adapter id 映射（probe_auth 按预置 id 分派；程序名与 id 不同名时经此转换）。
fn probe_auth_by_program(program: &str) -> AuthInfo {
    let id = match program {
        "claude-agent-acp" => "claude-code",
        "pi-acp" => "pi",
        other => other,
    };
    probe_auth(id, None)
}

/// 桥程序在「本体 CLI 已在」前提下的状态归类（纯函数）。
pub fn bridge_status(
    spec: &crate::connector::BridgeSpec,
    managed: Option<&crate::connector::ResolvedBridge>,
    cli_available: bool,
    runtime_available: bool,
) -> AdapterStatus {
    if let Some(b) = managed {
        return AdapterStatus {
            available: true,
            state: AdapterState::Ready,
            resolved_path: Some(b.entry.clone()),
            source: Some("ManagedBridge".into()),
            bridge: None,
            cli: None,
            auth: probe_auth_by_program(spec.cli_program),
        };
    }
    let bridge = BridgeInfo {
        pkg: spec.pkg.into(),
        version: spec.version.into(),
        cli_program: spec.cli_program.into(),
        cli_available,
        runtime_available,
    };
    let installable = cli_available && runtime_available;
    AdapterStatus {
        available: false,
        state: if installable { AdapterState::Installable } else { AdapterState::Absent },
        resolved_path: None,
        source: None,
        bridge: Some(bridge),
        cli: None,
        auth: probe_auth_by_program(spec.cli_program),
    }
}

/// 解析 $SHELL 的默认工作目录（前端下拉「打开目录」时的回退值）
#[tauri::command]
pub fn default_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(id: &str, args: Vec<&str>, logo: Option<&str>) -> Adapter {
        Adapter {
            id: id.into(),
            name: id.into(),
            program: id.into(),
            args: args.into_iter().map(String::from).collect(),
            cwd: ".".into(),
            logo: logo.map(String::from),
        }
    }

    #[test]
    fn defaults_have_no_machine_specific_model() {
        // P28 回归护栏：预置参数不得再出现任何 --model 硬编码（换机必挂的根因）
        for a in defaults() {
            assert!(
                !a.args.iter().any(|x| x == "--model"),
                "预置适配器 {} 又塞了 --model: {:?}",
                a.id,
                a.args
            );
        }
        let omp = defaults().into_iter().find(|a| a.id == "omp").unwrap();
        assert_eq!(omp.args, vec!["acp".to_string()]);
    }

    #[test]
    fn migrate_resets_legacy_omp_model_flag() {
        // 老预置带 duo-king-6.6（机器相关模型名，换机必挂）→ 重置为当前预置
        let mut list = vec![adapter("omp", vec!["acp", "--model", "duo-king-6.6"], Some("#7c3aed"))];
        migrate_in_place(&mut list);
        assert_eq!(list[0].args, vec!["acp".to_string()]);
    }

    #[test]
    fn migrate_keeps_user_customized_omp_args() {
        // 用户自选的模型 ≠ duo-king-6.6 → 不动（迁移只针对精确旧预置值）
        let mut list = vec![adapter("omp", vec!["acp", "--model", "my-model"], None)];
        migrate_in_place(&mut list);
        assert_eq!(list[0].args, vec!["acp", "--model", "my-model"]);
    }

    #[test]
    fn migrate_backfills_logo() {
        let mut list = vec![adapter("pi", vec![], None)];
        migrate_in_place(&mut list);
        assert_eq!(list[0].logo.as_deref(), Some("#2563eb"));
    }

    #[test]
    fn bridge_state_matrix() {
        let spec = crate::connector::bridge_spec("pi-acp").unwrap();
        let managed = Some(crate::connector::ResolvedBridge {
            entry: "/x/index.js".into(),
            version: spec.version.into(),
        });
        // 托管已装 → ready（哪怕 CLI/运行时都不在——装都装好了）
        let s = bridge_status(spec, managed.as_ref(), false, false);
        assert_eq!(s.state, AdapterState::Ready);
        assert!(s.available);
        assert_eq!(s.source.as_deref(), Some("ManagedBridge"));
        // 未装 + CLI 在 + 运行时在 → installable（P28 核心：不再误报未安装）
        let s = bridge_status(spec, None, true, true);
        assert_eq!(s.state, AdapterState::Installable);
        assert!(!s.available);
        let b = s.bridge.unwrap();
        assert_eq!(b.pkg, "pi-acp");
        assert!(b.cli_available && b.runtime_available);
        // CLI 本体缺 → absent（装桥没用，先装 harness）
        let s = bridge_status(spec, None, false, true);
        assert_eq!(s.state, AdapterState::Absent);
        assert!(!s.bridge.as_ref().unwrap().cli_available);
        // 运行时缺 → absent
        let s = bridge_status(spec, None, true, false);
        assert_eq!(s.state, AdapterState::Absent);
        assert!(!s.bridge.as_ref().unwrap().runtime_available);
    }

    #[test]
    fn state_serializes_four_states() {
        // 前端按字面量判别：ready/installable/cli_installable/absent
        assert_eq!(serde_json::to_string(&AdapterState::Ready).unwrap(), "\"ready\"");
        assert_eq!(serde_json::to_string(&AdapterState::Installable).unwrap(), "\"installable\"");
        assert_eq!(
            serde_json::to_string(&AdapterState::CliInstallable).unwrap(),
            "\"cli_installable\""
        );
        assert_eq!(serde_json::to_string(&AdapterState::Absent).unwrap(), "\"absent\"");
    }

    #[test]
    fn cli_status_branch_reports_installable_and_absent() {
        // runtime_ok=true → 登记程序 cli_installable（claude 只有脚本候选恒可装）
        let s = cli_status("claude", true);
        assert_eq!(s.state, AdapterState::CliInstallable);
        assert!(!s.available);
        let c = s.cli.expect("claude 应有 CliInstallInfo");
        assert_eq!(c.display, "Claude Code");
        // 未登记程序 → absent 且 cli=None（文案点名「未知程序」由前端兜底）
        let s = cli_status("my-unknown-agent", true);
        assert_eq!(s.state, AdapterState::Absent);
        assert!(s.cli.is_none());
        // P31 矩阵：runtime_ok=false → 登记程序也 absent（装不了）
        let s = cli_status("claude", false);
        assert_eq!(s.state, AdapterState::Absent);
        assert!(!s.cli.unwrap().installable);
        // P31 矩阵：runtime_ok=true 但只有 Package 候选的程序照常判定
        let s = cli_status("codex", true);
        assert_eq!(s.state, AdapterState::CliInstallable);
    }

    #[test]
    fn cli_in_bridge_program_falls_to_cli_status() {
        // pi-acp（桥程序）但 pi 本体不在：compute_status_inner 走 cli 分支
        // （真正可移植的断言：桥 spec 命中且 CLI 不在时返回值携带 cli 字段而非 bridge 字段）
        let s = cli_status("pi", true);
        if s.state == AdapterState::CliInstallable {
            assert!(s.cli.is_some());
            assert!(s.bridge.is_none());
        }
    }

    // ---------------- P29 任务二：认证态探测 ----------------

    #[test]
    fn claude_credentials_detects_oauth_shapes() {
        // 各种可能的 OAuth 凭据形态（官方结构演进过）都算订阅
        assert!(claude_credentials_text(r#"{"claudeAiOauth":{"accessToken":"x"}}"#));
        assert!(claude_credentials_text(r#"{"oauthAccount":{"emailAddress":"a@b.c"}}"#));
        assert!(claude_credentials_text(r#"{"access_token":"x","refresh_token":"y"}"#));
        // API key 形态 / 空对象 / 损坏 → 非订阅
        assert!(!claude_credentials_text(r#"{"apiKey":"sk"}"#));
        assert!(!claude_credentials_text("{}"));
        assert!(!claude_credentials_text("not json"));
    }

    #[test]
    fn claude_settings_api_detection() {
        assert!(claude_settings_has_api(
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://x","ANTHROPIC_AUTH_TOKEN":"sk"}}"#
        ));
        assert!(claude_settings_has_api(r#"{"env":{"ANTHROPIC_API_KEY":"sk"}}"#));
        // 空串不算配置
        assert!(!claude_settings_has_api(r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"  "}}"#));
        assert!(!claude_settings_has_api(r#"{"model":"opus"}"#));
        assert!(!claude_settings_has_api("not json"));
    }

    #[test]
    fn codex_auth_three_states() {
        // 订阅：tokens 字段（ChatGPT 登录形态）
        assert_eq!(
            codex_auth_text(r#"{"tokens":{"id_token":"x","access_token":"y"}}"#),
            AuthState::Subscription
        );
        // API：OPENAI_API_KEY（两种大小写历史形态）
        assert_eq!(codex_auth_text(r#"{"OPENAI_API_KEY":"sk"}"#), AuthState::Api);
        assert_eq!(codex_auth_text(r#"{"openai_api_key":"sk"}"#), AuthState::Api);
        // 空串 key 不算
        assert_eq!(codex_auth_text(r#"{"OPENAI_API_KEY":""}"#), AuthState::None);
        assert_eq!(codex_auth_text("{}"), AuthState::None);
        assert_eq!(codex_auth_text("broken"), AuthState::None);
    }

    #[test]
    fn nonempty_auth_json_matrix() {
        assert!(auth_json_nonempty(r#"{"provider":{"type":"api","key":"sk"}}"#));
        assert!(!auth_json_nonempty("{}"));
        assert!(!auth_json_nonempty("[]"));
        assert!(!auth_json_nonempty("junk"));
    }

    #[test]
    fn probe_auth_home_injection_matrix() {
        let dir = std::env::temp_dir().join(format!("ainone-auth-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::create_dir_all(dir.join(".codex")).unwrap();
        std::fs::create_dir_all(dir.join(".pi/agent")).unwrap();

        // 全空 → 全 None
        assert_eq!(probe_auth("claude-code", Some(&dir)).state, AuthState::None);
        assert_eq!(probe_auth("codex", Some(&dir)).state, AuthState::None);
        assert_eq!(probe_auth("pi", Some(&dir)).state, AuthState::None);
        assert_eq!(probe_auth("omp", Some(&dir)).state, AuthState::None);
        assert_eq!(probe_auth("opencode", Some(&dir)).state, AuthState::None);
        // 未登记 id → None 不报错
        assert_eq!(probe_auth("custom-x", Some(&dir)).state, AuthState::None);

        // claude：订阅凭据优先于 API
        std::fs::write(dir.join(".claude/.credentials.json"), r#"{"claudeAiOauth":{}}"#).unwrap();
        let a = probe_auth("claude-code", Some(&dir));
        assert_eq!(a.state, AuthState::Subscription);
        std::fs::remove_file(dir.join(".claude/.credentials.json")).unwrap();
        std::fs::write(
            dir.join(".claude/settings.json"),
            r#"{"env":{"ANTHROPIC_AUTH_TOKEN":"sk"}}"#,
        )
        .unwrap();
        assert_eq!(probe_auth("claude-code", Some(&dir)).state, AuthState::Api);

        // codex：tokens = 订阅
        std::fs::write(dir.join(".codex/auth.json"), r#"{"tokens":{}}"#).unwrap();
        assert_eq!(probe_auth("codex", Some(&dir)).state, AuthState::Subscription);

        // pi / omp：非空 auth.json = Api
        std::fs::write(dir.join(".pi/agent/auth.json"), r#"{"openai":{"key":"k"}}"#).unwrap();
        assert_eq!(probe_auth("pi", Some(&dir)).state, AuthState::Api);
        assert_eq!(probe_auth("omp", Some(&dir)).state, AuthState::Api);

        // home 不存在（None 且无 HOME 环境）→ None 不 panic 由 dirs 兜底
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod real_machine_tests {
    // P29 验收 2.2 实机快照：本机 claude（env TOKEN）→ Api；codex（OPENAI_API_KEY）→ Api。
    // 该测试依赖真机环境，任何断言失败都意味着探测规则或本机配置结构变化，需要人工核对。
    use super::*;

    #[test]
    fn real_machine_auth_snapshot() {
        let claude = probe_auth("claude-code", None);
        println!("claude-code auth: {:?}", claude.state);
        assert_eq!(claude.state, AuthState::Api, "本机 claude 应为 API 配置态");

        let codex = probe_auth("codex", None);
        println!("codex auth: {:?}", codex.state);
        assert_eq!(codex.state, AuthState::Api, "本机 codex 应为 API 配置态");
    }
}
