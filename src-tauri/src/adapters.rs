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
    compute_status_inner(&program, managed.as_ref()).state == AdapterState::Ready
}

/// 三态：已可用（PATH 命中或托管桥已装）/ 可懒装（桥未装但本体与环境就绪）/
/// 真未装。判定纯逻辑见 compute_status。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AdapterState {
    Ready,
    Installable,
    Absent,
}

/// 懒装桥的元信息（installable/absent 的成因透出给前端组文案；非桥程序为 null）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub pkg: String,
    pub version: String,
    /// harness 本体 CLI 是否在增强 PATH（缺 → 装桥也没用）
    pub cli_available: bool,
    /// bun/npm 安装运行时是否在（缺 → 装不了桥）
    pub runtime_available: bool,
}

/// 检测结果详情：三态 + 绝对路径与命中来源（UI 展示「找到于 …」用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterStatus {
    /// 兼容字段：state == ready（前端旧代码与测试仍读它）
    pub available: bool,
    pub state: AdapterState,
    pub resolved_path: Option<String>,
    pub source: Option<String>,
    pub bridge: Option<BridgeInfo>,
}

#[tauri::command]
pub fn adapter_status(app: tauri::AppHandle, program: String) -> AdapterStatus {
    let managed = crate::connector::bridge_spec(&program)
        .and_then(|s| crate::connector::resolve_managed(&app, s));
    compute_status_inner(&program, managed.as_ref())
}

/// 三态判定核心（PATH 检索走 env_path 真机；桥分支的可用性输入由调用方注入
/// → 逻辑本体在 bridge_status，纯函数可单测）：
///   1. PATH 命中                    → ready（source 记命中目录类别）
///   2. 懒装桥托管目录已装           → ready（source = ManagedBridge）
///   3. 懒装桥 + 本体 CLI 在 + 运行时在 → installable
///   4. 其余                         → absent（bridge 元信息解释缺哪块）
pub fn compute_status_inner(
    program: &str,
    managed: Option<&crate::connector::ResolvedBridge>,
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
        };
    }
    match crate::connector::bridge_spec(program) {
        Some(s) => bridge_status(
            s,
            managed,
            crate::env_path::find_program(s.cli_program).is_some(),
            crate::connector::install_runtime_available(),
        ),
        None => AdapterStatus {
            available: false,
            state: AdapterState::Absent,
            resolved_path: None,
            source: None,
            bridge: None,
        },
    }
}

/// 桥程序在「PATH 未命中」前提下的状态归类（纯函数）。
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
        };
    }
    let bridge = BridgeInfo {
        pkg: spec.pkg.into(),
        version: spec.version.into(),
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

    fn omp_with(model_args: Vec<String>) -> Adapter {
        Adapter {
            id: "omp".into(),
            name: "Oh My Pi".into(),
            program: "omp".into(),
            args: model_args,
            cwd: ".".into(),
            logo: Some("#7c3aed".into()),
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
    fn migrate_resets_legacy_duo_king_only() {
        // 老预置精确值 duo-king-6.6 → 重置为 ["acp"]
        let mut list = vec![omp_with(vec![
            "acp".into(),
            "--model".into(),
            "duo-king-6.6".into(),
        ])];
        migrate_in_place(&mut list);
        assert_eq!(list[0].args, vec!["acp".to_string()]);
    }

    #[test]
    fn migrate_keeps_user_customized_model() {
        // 用户自己改的模型名（非 legacy 值）→ 不碰
        let mut list = vec![omp_with(vec![
            "acp".into(),
            "--model".into(),
            "my-model".into(),
        ])];
        migrate_in_place(&mut list);
        assert_eq!(list[0].args, vec!["acp", "--model", "my-model"]);
        // 用户主动删掉参数的也保持
        let mut cleared = vec![omp_with(vec![])];
        migrate_in_place(&mut cleared);
        assert!(cleared[0].args.is_empty());
    }
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
    fn state_serializes_lowercase() {
        // 前端按 'ready'|'installable'|'absent' 字面量判别
        assert_eq!(
            serde_json::to_string(&AdapterState::Installable).unwrap(),
            "\"installable\""
        );
    }
}
