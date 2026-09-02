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

/// 供 sessions.rs 迁移复用的工作区加载（读时迁移需要匹配 cwd）
pub(crate) fn load_workspaces(app: &tauri::AppHandle) -> Result<Vec<Workspace>, String> {
    load_all(app)
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

pub(crate) fn normalize_path(p: &str) -> String {
    // 轻量规范化：去尾部斜杠 + 小写比较（macOS 默认大小写不敏感）
    p.trim_end_matches('/').to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::normalize_path;

    #[test]
    fn normalize_path_strips_trailing_slash() {
        assert_eq!(normalize_path("/a/b/"), normalize_path("/a/b"));
    }

    #[test]
    fn normalize_path_is_case_insensitive() {
        assert_eq!(normalize_path("/Users/Dev"), normalize_path("/users/dev"));
    }

    #[test]
    fn normalize_path_distinct_paths_stay_distinct() {
        assert_ne!(normalize_path("/a/b"), normalize_path("/a/c"));
    }
}

#[tauri::command]
pub fn workspaces_list(app: tauri::AppHandle) -> Result<Vec<Workspace>, String> {
    let mut list = load_all(&app)?;
    list.sort_by(|a, b| a.created_ms.cmp(&b.created_ms));
    Ok(list)
}

#[tauri::command]
pub fn workspaces_upsert(app: tauri::AppHandle, workspace: Workspace) -> Result<String, String> {
    // 按 cwd「以新换旧」：同一目录只保留一个工作区。传入的 workspace 成为
    // 该目录的权威工作区（旧记录被替换丢弃），返回它的 id——保证前端拿到的 id
    // 一定在落盘文件里，不会因去重被丢弃而悬空。
    let list = load_all(&app)?;
    let norm = normalize_path(&workspace.cwd);
    let mut next: Vec<Workspace> = Vec::with_capacity(list.len() + 1);
    let mut replaced = false;
    for w in list {
        if normalize_path(&w.cwd) == norm {
            if !replaced {
                next.push(workspace.clone());
                replaced = true;
            }
            // 同 cwd 的其余旧记录丢弃
        } else {
            next.push(w);
        }
    }
    if !replaced {
        next.push(workspace.clone());
    }
    save_all(&app, &next)?;
    Ok(workspace.id)
}

#[tauri::command]
pub fn workspaces_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut list = load_all(&app)?;
    list.retain(|w| w.id != id);
    save_all(&app, &list)?;
    // F-5-3：移除工作区 → 其下会话移入「未归组」（数据不丢）
    crate::sessions::clear_workspace_id(&app, &id)
}
