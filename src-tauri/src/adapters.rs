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
}

/// 预置适配器：OMP / Pi / Claude Code / OpenCode。
/// Pi 与 Claude Code 需本机先装对应 ACP 桥接器（pi-acp / claude-code-acp）。
pub fn defaults() -> Vec<Adapter> {
    vec![
        Adapter {
            id: "omp".into(),
            name: "Oh My Pi".into(),
            program: "omp".into(),
            args: vec!["acp".into(), "--model".into(), "duo-king-6.6".into()],
            cwd: ".".into(),
        },
        Adapter {
            id: "pi".into(),
            name: "Pi".into(),
            program: "pi-acp".into(),
            args: Vec::new(),
            cwd: ".".into(),
        },
        Adapter {
            id: "claude-code".into(),
            name: "Claude Code".into(),
            program: "claude-code-acp".into(),
            args: Vec::new(),
            cwd: ".".into(),
        },
        Adapter {
            id: "opencode".into(),
            name: "OpenCode".into(),
            program: "opencode".into(),
            args: vec!["acp".into()],
            cwd: ".".into(),
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
    serde_json::from_str(&raw).map_err(|e| format!("适配器配置解析失败（JSON 损坏）: {e}"))
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

/// 检测某程序是否在 PATH 中可执行（用于「可用性」标记）。
#[tauri::command]
pub fn adapter_available(program: String) -> bool {
    let path_var = std::env::var("PATH").unwrap_or_default();
    for dir in path_var.split(':') {
        let candidate = std::path::Path::new(dir).join(&program);
        if candidate.is_file() {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&candidate) {
                if meta.permissions().mode() & 0o111 != 0 {
                    return true;
                }
            }
        }
    }
    false
}

/// 解析 $SHELL 的默认工作目录（前端下拉「打开目录」时的回退值）
#[tauri::command]
pub fn default_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string())
}
