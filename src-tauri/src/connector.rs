// Claude Code 连接器懒安装（DeepChat 式，用户选定方案）：
//
// claude-agent-acp 桥接器不打进安装包（体积 + 用户轻量约束），首次使用时
// 自动 `bun add --omit=optional @agentclientprotocol/claude-agent-acp@<pin>`
// 到 appConfigDir/acp-connector/，claude 二进制用用户已装的（经
// CLAUDE_CODE_EXECUTABLE 注入，见 agent.rs spawn_inner）。
//
// 解析优先级：用户 PATH 自装的 claude-agent-acp > 应用管理的连接器。

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 连接器包版本 pin（应用升级时同步改这里，首次使用自动重装新版本）
pub const CONNECTOR_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";
pub const CONNECTOR_VERSION: &str = "0.73.0";

/// 安装目录：appConfigDir/acp-connector/（与 adapters.json 同级）
fn install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?
        .join("acp-connector");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建连接器目录失败: {e}"))?;
    Ok(dir)
}

fn marker_path(dir: &PathBuf) -> PathBuf {
    dir.join(format!("installed-{}", CONNECTOR_VERSION))
}

/// 连接器包的入口（dist/index.js）；存在 = 已安装
fn entry_path(dir: &PathBuf) -> PathBuf {
    dir.join("node_modules")
        .join("@agentclientprotocol")
        .join("claude-agent-acp")
        .join("dist")
        .join("index.js")
}

/// 当前连接器是否可用（PATH 自装优先，其次应用管理的安装目录）
pub fn resolve_managed(app: &AppHandle) -> Option<ResolvedConnector> {
    let dir = install_dir(app).ok()?;
    let entry = entry_path(&dir);
    if entry.is_file() && marker_path(&dir).exists() {
        return Some(ResolvedConnector {
            entry: entry.to_string_lossy().into_owned(),
            version: CONNECTOR_VERSION.into(),
        });
    }
    None
}

/// 已安装连接器的信息（spawn 时由 agent.rs 消费）
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedConnector {
    /// 连接器入口 JS 的绝对路径
    pub entry: String,
    pub version: String,
}

/// 安装状态（前端展示用）
#[derive(Debug, Serialize)]
pub struct ConnectorStatus {
    /// 用户 PATH 上有自装连接器
    user_installed: bool,
    /// 应用管理的连接器已安装
    managed_installed: bool,
    managed_version: Option<String>,
}

#[tauri::command]
pub fn connector_status(app: AppHandle) -> ConnectorStatus {
    ConnectorStatus {
        user_installed: crate::env_path::find_program("claude-agent-acp").is_some(),
        managed_installed: resolve_managed(&app).is_some(),
        managed_version: resolve_managed(&app).map(|c| c.version),
    }
}

/// 触发懒安装（同步执行，bun add 通常 <10s；前端经 invoke 等待结果）。
/// 失败时清掉半成品目录，下次重试自动重来。
#[tauri::command]
pub fn connector_install(app: AppHandle) -> Result<ResolvedConnector, String> {
    let dir = install_dir(&app)?;
    let entry = entry_path(&dir);
    let marker = marker_path(&dir);
    if entry.is_file() && marker.exists() {
        return Ok(ResolvedConnector { entry: entry.to_string_lossy().into_owned(), version: CONNECTOR_VERSION.into() });
    }

    // 运行时：bun 优先（连接器实测 bun 可直接跑），回退 node
    let runtime = crate::env_path::find_program("bun")
        .map(|h| h.path)
        .or_else(|| crate::env_path::find_program("node").map(|h| h.path))
        .ok_or_else(|| "未找到 bun 或 node 运行时，无法安装连接器。请先安装 bun（curl -fsSL https://bun.sh/install | bash）或 Node.js ≥22。".to_string())?;

    // package.json 是 bun add 的锚点（无它 bun 会向上级目录找）
    let pkg = dir.join("package.json");
    if !pkg.exists() {
        std::fs::write(&pkg, r#"{"name":"ainone-acp-connector","private":true}"#)
            .map_err(|e| format!("写入 package.json 失败: {e}"))?;
    }

    log::info!("[connector] 开始懒安装 {}@{} → {}", CONNECTOR_PACKAGE, CONNECTOR_VERSION, dir.display());
    let output = std::process::Command::new(&runtime)
        .args([
            "add",
            "--omit=optional", // 必须：省去 SDK 平台二进制（实测 245M→53M）
            &format!("{CONNECTOR_PACKAGE}@{CONNECTOR_VERSION}"),
        ])
        .current_dir(&dir)
        .env("PATH", crate::env_path::enhanced_path())
        .output()
        .map_err(|e| format!("启动安装命令失败: {e}"))?;

    if !output.status.success() {
        // 自愈：删半成品，下次重试从干净状态开始
        let _ = std::fs::remove_dir_all(&dir);
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "连接器安装失败（{}）。检查网络后重试。stderr: {}",
            output.status,
            stderr.chars().take(300).collect::<String>()
        ));
    }

    // 标记文件（版本 pin 升级后自动重装）
    std::fs::write(&marker, CONNECTOR_VERSION).map_err(|e| format!("写入安装标记失败: {e}"))?;
    log::info!("[connector] 懒安装完成 {}", entry.display());

    Ok(ResolvedConnector { entry: entry.to_string_lossy().into_owned(), version: CONNECTOR_VERSION.into() })
}
