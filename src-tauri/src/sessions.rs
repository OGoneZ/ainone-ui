// 会话历史索引：记录 (sessionId, adapterId, 标题, cwd, mtime)，持久化在 appDataDir/sessions.json。
//
// 作用域（plan.md F-2-2）：本文件只做「索引」——记录哪些会话存在，供 UI 展示可恢复列表。
// 真正的会话上下文在 harness 侧（session/load 由 agent 恢复），这里不重复存储消息体。
// 历史消息回填（F-2-3）是 S 级可选，暂以「恢复后由 agent 提供上下文」为准。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEntry {
    pub session_id: String,
    pub adapter_id: String,
    pub title: String,
    pub cwd: String,
    /// Unix 时间戳（毫秒），用于排序
    pub mtime_ms: u64,
}

fn sessions_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析数据目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir.join("sessions.json"))
}

fn load_all(app: &tauri::AppHandle) -> Result<Vec<SessionEntry>, String> {
    let path = sessions_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取会话索引失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("会话索引解析失败: {e}"))
}

fn save_all(app: &tauri::AppHandle, entries: &[SessionEntry]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(entries).map_err(|e| format!("序列化会话索引失败: {e}"))?;
    std::fs::write(sessions_path(app)?, json).map_err(|e| format!("写入会话索引失败: {e}"))
}

#[tauri::command]
pub fn sessions_list(app: tauri::AppHandle) -> Result<Vec<SessionEntry>, String> {
    let mut list = load_all(&app)?;
    list.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    Ok(list)
}

#[tauri::command]
pub fn sessions_upsert(app: tauri::AppHandle, entry: SessionEntry) -> Result<(), String> {
    let mut list = load_all(&app)?;
    if let Some(e) = list.iter_mut().find(|e| e.session_id == entry.session_id) {
        *e = entry;
    } else {
        list.push(entry);
    }
    save_all(&app, &list)
}

#[tauri::command]
pub fn sessions_remove(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let mut list = load_all(&app)?;
    list.retain(|e| e.session_id != session_id);
    save_all(&app, &list)
}
