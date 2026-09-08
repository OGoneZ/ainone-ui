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
    /// 所属工作区 id（F-5-4）；None = 未归组（旧数据迁移而来或移除工作区后）
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// 条目种类（P23）：Some("terminal") = 本地终端；None = harness 会话（旧索引无字段，兼容）
    #[serde(default)]
    pub kind: Option<String>,
    /// 回收站标记：Some(删除时刻 Unix 毫秒) = 已软删除（侧栏不显示，回收站可恢复）；
    /// None = 正常。旧索引无字段（serde default 兼容）。
    #[serde(default)]
    pub deleted_at_ms: Option<u64>,
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
    serde_json::from_str(&raw).map_err(|e| {
        log::warn!("[sessions] 索引 JSON 损坏: {e}");
        format!("会话索引解析失败: {e}")
    })
}

fn save_all(app: &tauri::AppHandle, entries: &[SessionEntry]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(entries).map_err(|e| format!("序列化会话索引失败: {e}"))?;
    std::fs::write(sessions_path(app)?, json)
        .map_err(|e| format!("写入会话索引失败: {e}"))
}

/// F-5-4 迁移匹配（纯函数）：按 cwd 规范化给会话找所属工作区 id。
/// 返回 None = 未归组（cwd 为空或无匹配）。
pub(crate) fn match_workspace(
    session_cwd: &str,
    workspaces: &[crate::workspaces::Workspace],
) -> Option<String> {
    if session_cwd.is_empty() {
        return None;
    }
    let norm = crate::workspaces::normalize_path(session_cwd);
    workspaces
        .iter()
        .find(|w| crate::workspaces::normalize_path(&w.cwd) == norm)
        .map(|w| w.id.clone())
}

#[tauri::command]
pub fn sessions_list(app: tauri::AppHandle) -> Result<Vec<SessionEntry>, String> {
    sessions_list_inner(app, false)
}

/// 回收站列表：只返回已软删除的条目（按删除时间倒序）。
#[tauri::command]
pub fn sessions_deleted_list(app: tauri::AppHandle) -> Result<Vec<SessionEntry>, String> {
    sessions_list_inner(app, true)
}

fn sessions_list_inner(app: tauri::AppHandle, deleted_only: bool) -> Result<Vec<SessionEntry>, String> {
    let mut list = load_all(&app)?;
    // 软删除过滤：默认列表不含已删条目；回收站列表只含已删条目
    list.retain(|e| e.deleted_at_ms.is_some() == deleted_only);
    // F-5-4 读时迁移 + 悬空自愈：
    //   - workspace_id 为 None → 按 cwd **精确相等**匹配已有工作区（子目录不会归到父目录）
    //   - workspace_id 悬空（指向已删除/被去重丢弃的工作区）→ 同一套精确匹配重新绑定；
    //     仍匹配不到才归「未归组」
    // 幂等：只有发生变更才落盘。
    let mut changed = false;
    if let Ok(workspaces) = crate::workspaces::load_workspaces(&app) {
        let valid_ids: std::collections::HashSet<&str> =
            workspaces.iter().map(|w| w.id.as_str()).collect();
        for e in list.iter_mut() {
            let dangling = match &e.workspace_id {
                Some(id) => !valid_ids.contains(id.as_str()),
                None => true,
            };
            if !dangling {
                continue;
            }
            if let Some(wid) = match_workspace(&e.cwd, &workspaces) {
                e.workspace_id = Some(wid);
                changed = true;
            } else if e.workspace_id.is_some() {
                // 悬空且 cwd 匹配不到任何工作区 → 归未归组
                e.workspace_id = None;
                changed = true;
            }
        }
    }
    if changed {
        save_all(&app, &list)?;
    }
    if deleted_only {
        // 回收站：最近删的在前
        list.sort_by(|a, b| b.deleted_at_ms.cmp(&a.deleted_at_ms));
    } else {
        list.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    }
    Ok(list)
}

#[tauri::command]
pub fn sessions_upsert(app: tauri::AppHandle, entry: SessionEntry) -> Result<(), String> {
    let mut list = load_all(&app)?;
    if let Some(e) = list.iter_mut().find(|e| e.session_id == entry.session_id) {
        // 覆盖时保留软删除标记：对回收站中条目的 upsert（如同名会话重建）不应
        // 静默「复活」条目——恢复必须走 sessions_restore 的显式用户动作
        let deleted = e.deleted_at_ms;
        *e = entry;
        e.deleted_at_ms = deleted;
    } else {
        list.push(entry);
    }
    save_all(&app, &list)
}

/// 删除会话 = 软删除（打 deleted_at_ms 标记，侧栏不显示）：JSONL 日志与 harness
/// transcript 全部保留，回收站可恢复。只有 sessions_list（默认）过滤已删条目。
#[tauri::command]
pub fn sessions_remove(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let mut list = load_all(&app)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut hit = false;
    for e in list.iter_mut() {
        if e.session_id == session_id {
            e.deleted_at_ms = Some(now);
            hit = true;
        }
    }
    if hit {
        save_all(&app, &list)?;
    }
    Ok(())
}

/// 回收站恢复：清除 deleted_at_ms 标记，条目回到侧栏。
#[tauri::command]
pub fn sessions_restore(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let mut list = load_all(&app)?;
    let mut hit = false;
    for e in list.iter_mut() {
        if e.session_id == session_id && e.deleted_at_ms.is_some() {
            e.deleted_at_ms = None;
            e.mtime_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(e.mtime_ms);
            hit = true;
        }
    }
    if hit {
        save_all(&app, &list)?;
    }
    Ok(())
}

/// 回收站永久删除：从索引移除条目（JSONL 日志文件保留不动——日志非索引管辖）。
#[tauri::command]
pub fn sessions_purge(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let mut list = load_all(&app)?;
    list.retain(|e| !(e.session_id == session_id && e.deleted_at_ms.is_some()));
    save_all(&app, &list)
}

/// 移除工作区时调用（F-5-3）：把该工作区下会话的 workspace_id 清空（移入未归组，数据不丢）。
pub(crate) fn clear_workspace_id(app: &tauri::AppHandle, workspace_id: &str) -> Result<(), String> {
    let mut list = load_all(app)?;
    let mut changed = false;
    for e in list.iter_mut() {
        if e.workspace_id.as_deref() == Some(workspace_id) {
            e.workspace_id = None;
            changed = true;
        }
    }
    if changed {
        save_all(app, &list)?;
    }
    Ok(())
}

// —— 本地消息日志（plan-v2 F-4-3）——
// 每会话一份 JSONL 存于 appDataDir/sessions/<sessionId>.jsonl，按序记录全部消息。
// 本地日志是「单一真源」：恢复会话时读日志回填 UI（agent 上下文另由 session/load 恢复）。
// 追加写由 Rust 命令承担，与 fd_read/fd_write 同层（见 lib.rs 注释）。

fn log_path(app: &tauri::AppHandle, session_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析数据目录失败: {e}"))?;
    let sub = dir.join("sessions");
    std::fs::create_dir_all(&sub).map_err(|e| format!("创建日志目录失败: {e}"))?;
    Ok(sub.join(format!("{session_id}.jsonl")))
}

/// 读回某会话的日志全量文本；文件不存在返回空串。
#[tauri::command]
pub fn log_read(app: tauri::AppHandle, session_id: String) -> Result<String, String> {
    let path = log_path(&app, &session_id)?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取会话日志失败: {e}"))
}

/// 追加多行（每行已序列化、不含换行符）到某会话日志末尾。
#[tauri::command]
pub fn log_append(app: tauri::AppHandle, session_id: String, lines: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    let path = log_path(&app, &session_id)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开会话日志失败: {e}"))?;
    for line in lines {
        writeln!(file, "{}", line).map_err(|e| format!("追加会话日志失败: {e}"))?;
    }
    Ok(())
}

/// F-8-6 消息回溯：把会话日志截断到前 N 行（之后消息丢弃）。
/// 回填阶段读回再走 parseLog，损坏行会安全跳过，故按「消息条数」截断。
#[tauri::command]
pub fn log_truncate(app: tauri::AppHandle, session_id: String, keep_lines: usize) -> Result<(), String> {
    let path = log_path(&app, &session_id)?;
    if !path.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取会话日志失败: {e}"))?;
    let lines: Vec<&str> = raw.lines().collect();
    let kept: String = lines
        .iter()
        .take(keep_lines)
        .map(|l| format!("{l}\n"))
        .collect();
    log::warn!("[log_truncate] 截断会话日志 {session_id}：{} → {keep_lines} 行", lines.len());
    std::fs::write(&path, kept).map_err(|e| format!("写入会话日志失败: {e}"))
}

/// F-11-5 会话分叉：把父会话日志复制为新 sessionId 的日志（目标已存在则覆盖）。
/// 分叉自动跳转后，新 Tab 靠这份副本回填 UI 历史（agent 上下文另由 session/load 恢复）。
#[tauri::command]
pub fn log_copy(app: tauri::AppHandle, from_session_id: String, to_session_id: String) -> Result<(), String> {
    let from = log_path(&app, &from_session_id)?;
    let to = log_path(&app, &to_session_id)?;
    if !from.exists() {
        // 源无日志（父会话从未落盘）→ 目标也置空，语义等价
        std::fs::write(&to, "").map_err(|e| format!("写入会话日志失败: {e}"))?;
        log::warn!("[log_copy] 源日志不存在 {from_session_id} → {to_session_id}（置空）");
        return Ok(());
    }
    std::fs::copy(&from, &to).map_err(|e| format!("复制会话日志失败: {e}"))?;
    let size = std::fs::metadata(&to).map(|m| m.len()).unwrap_or(0);
    log::info!("[log_copy] {from_session_id} → {to_session_id}（{size} 字节）");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::match_workspace;
    use crate::workspaces::Workspace;

    fn ws(id: &str, cwd: &str) -> Workspace {
        Workspace { id: id.into(), name: id.into(), cwd: cwd.into(), created_ms: 1 }
    }

    #[test]
    fn match_workspace_hits_normalized_cwd() {
        let ws_list = vec![ws("w1", "/a/b")];
        assert_eq!(match_workspace("/a/b", &ws_list), Some("w1".into()));
        assert_eq!(match_workspace("/a/b/", &ws_list), Some("w1".into())); // 尾斜杠
    }

    #[test]
    fn match_workspace_miss_returns_none() {
        let ws_list = vec![ws("w1", "/a/b")];
        assert_eq!(match_workspace("/a/c", &ws_list), None);
    }

    #[test]
    fn match_workspace_subdir_does_not_match_parent() {
        // 子目录 /a/b/c 不能归到父级工作区 /a/b（用户明确要求）
        let ws_list = vec![ws("w1", "/a/b")];
        assert_eq!(match_workspace("/a/b/c", &ws_list), None);
    }

    #[test]
    fn match_workspace_empty_cwd_returns_none() {
        let ws_list = vec![ws("w1", "/a/b")];
        assert_eq!(match_workspace("", &ws_list), None);
    }

    // ---------------- P30 回收站（软删除）纯逻辑 ----------------

    use super::SessionEntry;

    fn entry(id: &str, deleted: Option<u64>) -> SessionEntry {
        SessionEntry {
            session_id: id.into(),
            adapter_id: "omp".into(),
            title: "t".into(),
            cwd: String::new(),
            workspace_id: None,
            kind: None,
            deleted_at_ms: deleted,
            mtime_ms: 1,
        }
    }

    #[test]
    fn soft_delete_filter_partitions_list() {
        // 默认列表只含未删条目；回收站列表只含已删条目（sessions_list_inner 的过滤语义）
        let list = vec![
            entry("live", None),
            entry("gone", Some(1000)),
        ];
        let live: Vec<&SessionEntry> = list.iter().filter(|e| e.deleted_at_ms.is_none()).collect();
        let deleted: Vec<&SessionEntry> = list.iter().filter(|e| e.deleted_at_ms.is_some()).collect();
        assert_eq!(live.iter().map(|e| e.session_id.as_str()).collect::<Vec<_>>(), ["live"]);
        assert_eq!(deleted.iter().map(|e| e.session_id.as_str()).collect::<Vec<_>>(), ["gone"]);
    }

    #[test]
    fn upsert_preserves_soft_delete_marker() {
        // sessions_upsert 覆盖已删条目时不许清掉 deleted_at_ms（复活必须走显式 restore）
        let mut existing = vec![entry("s1", Some(999))];
        let incoming = entry("s1", None);
        // 模拟 upsert 的保留逻辑
        if let Some(e) = existing.iter_mut().find(|e| e.session_id == incoming.session_id) {
            let deleted = e.deleted_at_ms;
            *e = incoming.clone();
            e.deleted_at_ms = deleted;
        }
        assert_eq!(existing[0].deleted_at_ms, Some(999), "覆盖后软删除标记应保留");
    }
}
