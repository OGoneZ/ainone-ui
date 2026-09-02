// ainone-ui：统一多 harness 的 ACP 桌面客户端
//
// UI 均为 React（src/）。这里（Rust 层）只做两件网页沙箱做不了的事：
//   1. ACP 的 fs/* 回调——读/写本地绝对路径文件
//   2. 进程管道——spawn harness 子进程并双向搬运 stdin/stdout 字节
//
// 注意：fd_write 是「本地用户确认后」的代理写盘。路径须由前端在权限审批
// 弹窗中向用户展示并确认后，才允许调用本命令。默认不做任何路径白名单，
// 把裁决权交给用户侧 UI。

mod adapters;
mod agent;
mod quickask;
mod sessions;
mod workspaces;

use std::sync::atomic::{AtomicU64, Ordering};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

static NEXT_AGENT_ID: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
fn fd_read(path: String) -> Result<String, String> {
    let r = std::fs::read_to_string(&path);
    r.map_err(|e| {
        log::warn!("[fs_read] 读取失败 {path}: {e}");
        format!("读取失败 {}: {}", path, e)
    })
}

#[tauri::command]
fn fd_write(path: String, content: String) -> Result<(), String> {
    log::debug!("[fs_write] 写入 {path}（{} 字节）", content.len());
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    std::fs::write(&path, content).map_err(|e| {
        log::warn!("[fs_write] 写入失败 {path}: {e}");
        format!("写入失败 {}: {}", path, e)
    })
}

/// 返回给 harness 子进程的基础环境。
/// 插件 shell 的 spawn 若 `env` 为 None 会清空环境，故前端须显式传这份环境。
/// 这里把 `~/.bun/bin` 追加到 PATH 头部，保证后续夸大 omp 时能找到 bun 系列工具。
#[tauri::command]
fn get_base_env() -> std::collections::HashMap<String, String> {
    let keys = [
        "PATH",
        "HOME",
        "SHELL",
        "USER",
        "LOGNAME",
        "LANG",
        "TERM",
        "TMPDIR",
    ];
    let mut env: std::collections::HashMap<String, String> = keys
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect();

    if let Some(home) = std::env::var("HOME").ok() {
        let bun = format!("{}/.bun/bin", home);
        if let Some(path) = env.get_mut("PATH") {
            *path = format!("{}:{}", bun, path);
        }
    }
    env
}

/// spawn 一个 harness 子进程，返回 agentId；后续 stdout/stderr/退出经 onEvent 推给前端。
#[tauri::command]
fn agent_spawn(
    app: AppHandle,
    program: String,
    args: Vec<String>,
    cwd: String,
    on_event: Channel<agent::AgentEvent>,
) -> Result<u64, String> {
    let agent_id = NEXT_AGENT_ID.fetch_add(1, Ordering::SeqCst);
    let rx = agent::spawn_inner(&app, agent_id, &program, &args, &cwd)?;
    agent::pump_events(rx, on_event);
    Ok(agent_id)
}

/// 向指定 agent 的 stdin 写字节（喂 SDK 的 JSON-RPC 请求）。
#[tauri::command]
fn agent_stdin_write(app: AppHandle, agent_id: u64, data: Vec<u8>) -> Result<(), String> {
    let state: State<'_, agent::AgentStore> = app.state();
    let mut map = state.0.lock().map_err(|_| "进程表锁中毒".to_string())?;
    let child = map.get_mut(&agent_id).ok_or("agentId 不存在")?;
    child.write(&data).map_err(|e| format!("stdin 写入失败: {e}"))
}

/// kill 指定 agent 的进程。
#[tauri::command]
fn agent_kill(app: AppHandle, agent_id: u64) -> Result<(), String> {
    let state: State<'_, agent::AgentStore> = app.state();
    let mut map = state.0.lock().map_err(|_| "进程表锁中毒".to_string())?;
    if let Some(child) = map.remove(&agent_id) {
        log::info!("[agent:{agent_id}] 主动 kill");
        let _ = child.kill();
    } else {
        log::warn!("[agent:{agent_id}] kill 请求命中不存在的 agentId");
    }
    Ok(())
}

/// 空闲超时回收（P8 F-8-1）：kill 并带最后活动时间留痕。
#[tauri::command]
fn agent_kill_idle(app: AppHandle, agent_id: u64, last_activity_ms: f64) -> Result<(), String> {
    let state: State<'_, agent::AgentStore> = app.state();
    let mut map = state.0.lock().map_err(|_| "进程表锁中毒".to_string())?;
    if let Some(child) = map.remove(&agent_id) {
        log::info!(
            "[agent:{agent_id}] 空闲超时回收（最后活动 {} ms 前）",
            now_ms() - last_activity_ms
        );
        let _ = child.kill();
    } else {
        log::warn!("[agent:{agent_id}] 空闲回收命中不存在的 agentId");
    }
    Ok(())
}

/// 当前 Unix 毫秒时间戳（回收留痕用）。
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// 把可能是相对的路径解析成绝对路径（ACP 要求 cwd 为绝对路径）。
#[tauri::command]
fn abs_path(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if p.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(p))
            .map_err(|e| format!("解析当前目录失败: {e}"))?
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "路径含非法字符".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 日志：stdout（dev 终端）+ 日志目录（macOS ~/Library/Logs/com.zhubaoduo.ainone-ui/）
    // 到达 1MB 轮转并保留全部（KeepAll），级别过滤到 WARN 以上可用 level_for 单独调。
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("ainone-ui".into()),
                    }),
                ])
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            agent::init_state(app);
            log::info!("ainone-ui 启动完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fd_read,
            fd_write,
            get_base_env,
            adapters::adapters_list,
            adapters::adapters_save,
            adapters::adapter_available,
            adapters::default_cwd,
            agent_spawn,
            agent_stdin_write,
            agent_kill,
            agent_kill_idle,
            abs_path,
            sessions::sessions_list,
            sessions::sessions_upsert,
            sessions::sessions_remove,
            sessions::log_read,
            sessions::log_append,
            workspaces::workspaces_list,
            workspaces::workspaces_upsert,
            workspaces::workspaces_remove,
            quickask::quick_ask,
            quickask::quickask_config_get,
            quickask::quickask_config_save,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 应用退出时清理所有自管子进程
            agent::handle_run_event(app, event);
        });
}
