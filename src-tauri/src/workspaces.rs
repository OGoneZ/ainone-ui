// 工作区实体：按工作目录归集会话的父级（plan-v2 F-5-1）。
//
// 只存储工作目录本身（不含子目录树），与 sessions 索引通过 workspace_id 关联。
// 持久化于 appDataDir/workspaces.json。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub cwd: String,
    /// Unix 时间戳（毫秒）
    pub created_ms: u64,
}

fn workspaces_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析数据目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir.join("workspaces.json"))
}

fn load_all(app: &tauri::AppHandle) -> Result<Vec<Workspace>, String> {
    let path = workspaces_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取工作区索引失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("工作区索引解析失败: {e}"))
}

fn save_all(app: &tauri::AppHandle, list: &[Workspace]) -> Result<(), String> {
    // 按 cwd 规范化去重（F-5-4）：路径重复的工作区只保留一条
    let mut seen: Vec<(String, String)> = Vec::new(); // (cwd_norm, id)
    let mut deduped: Vec<Workspace> = Vec::new();
    for w in list {
        let norm = normalize_path(&w.cwd);
        if seen.iter().any(|(n, _)| *n == norm) {
            continue;
        }
        seen.push((norm, w.id.clone()));
        deduped.push(w.clone());
    }
    let json = serde_json::to_string_pretty(&deduped).map_err(|e| format!("序列化工作区索引失败: {e}"))?;
    std::fs::write(workspaces_path(app)?, json).map_err(|e| format!("写入工作区索引失败: {e}"))
}

fn normalize_path(p: &str) -> String {
    // 轻量规范化：去尾部斜杠 + 小写比较（macOS 默认大小写不敏感）
    p.trim_end_matches('/').to_lowercase()
}

#[tauri::command]
pub fn workspaces_list(app: tauri::AppHandle) -> Result<Vec<Workspace>, String> {
    let mut list = load_all(&app)?;
    list.sort_by(|a, b| a.created_ms.cmp(&b.created_ms));
    Ok(list)
}

#[tauri::command]
pub fn workspaces_upsert(app: tauri::AppHandle, workspace: Workspace) -> Result<(), String> {
    let mut list = load_all(&app)?;
    if let Some(w) = list.iter_mut().find(|w| w.id == workspace.id) {
        *w = workspace;
    } else {
        list.push(workspace);
    }
    save_all(&app, &list)
}

#[tauri::command]
pub fn workspaces_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut list = load_all(&app)?;
    list.retain(|w| w.id != id);
    save_all(&app, &list)
}
