// 进程管理：自管 harness 子进程（数据 + 逻辑 + 命令入口）。
//
// 为什么不用前端 plugin-shell 的 JS API（plugin:shell|spawn）？
//   它受 capability scope 限制，只允许 spawn 预注册的程序。而适配器是「配置驱动」的，
//   新增任意 harness 不该逐个改 capability。故此处改走 Rust 侧 ShellExt::shell().command()
//   （不经过 scope），自行维护 agentId → 子进程映射。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

static NEXT_AGENT_ID: AtomicU64 = AtomicU64::new(1);

/// spawn 一个 harness 子进程，返回 agentId；后续 stdout/stderr/退出经 onEvent 推给前端。
#[tauri::command]
pub fn agent_spawn(
    app: AppHandle,
    program: String,
    args: Vec<String>,
    cwd: String,
    on_event: Channel<AgentEvent>,
) -> Result<u64, String> {
    let agent_id = NEXT_AGENT_ID.fetch_add(1, Ordering::SeqCst);
    let rx = spawn_inner(&app, agent_id, &program, &args, &cwd)?;
    pump_events(rx, on_event);
    Ok(agent_id)
}

/// 向指定 agent 的 stdin 写字节（喂 SDK 的 JSON-RPC 请求）。
#[tauri::command]
pub fn agent_stdin_write(app: AppHandle, agent_id: u64, data: Vec<u8>) -> Result<(), String> {
    let state: State<'_, AgentStore> = app.state();
    let mut map = state.0.lock().map_err(|_| "进程表锁中毒".to_string())?;
    let child = map.get_mut(&agent_id).ok_or("agentId 不存在")?;
    child.write(&data).map_err(|e| format!("stdin 写入失败: {e}"))
}

/// kill 指定 agent 的进程。
#[tauri::command]
pub fn agent_kill(app: AppHandle, agent_id: u64) -> Result<(), String> {
    let state: State<'_, AgentStore> = app.state();
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
pub fn agent_kill_idle(app: AppHandle, agent_id: u64, last_activity_ms: f64) -> Result<(), String> {
    let state: State<'_, AgentStore> = app.state();
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

/// 返回给 harness 子进程的基础环境。
/// 插件 shell 的 spawn 若 `env` 为 None 会清空环境，故前端须显式传这份环境。
/// 这里把 `~/.bun/bin` 追加到 PATH 头部，保证后续夸大 omp 时能找到 bun 系列工具。
#[tauri::command]
pub fn get_base_env() -> std::collections::HashMap<String, String> {
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

/// 当前 Unix 毫秒时间戳（回收留痕用）。
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// 流到前端的事件（channel 的 onmessage 会收到 { event, payload }）
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "payload", rename_all = "camelCase")]
pub enum AgentEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Error(String),
    Terminated { code: Option<i32> },
}

pub struct AgentStore(pub Mutex<HashMap<u64, CommandChild>>);

/// spawn 子进程并登记进进程表，返回事件接收端。
pub fn spawn_inner(
    app: &AppHandle,
    agent_id: u64,
    program: &str,
    args: &[String],
    cwd: &str,
) -> Result<tauri::async_runtime::Receiver<CommandEvent>, String> {
    log::info!("[agent:{agent_id}] spawn {program} {:?} cwd={cwd}", args);
    let mut cmd = app.shell().command(program).args(args).set_raw_out(true);
    if !cwd.is_empty() {
        cmd = cmd.current_dir(cwd);
    }
    let (rx, child) = cmd.spawn().map_err(|e| format!("spawn {program} 失败: {e}"))?;
    app.state::<AgentStore>()
        .0
        .lock()
        .map_err(|_| "进程表锁中毒".to_string())?
        .insert(agent_id, child);
    Ok(rx)
}

/// 把事件接收端逐条转发到前端 Channel；前端断开则停止。
pub fn pump_events(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    on_event: Channel<AgentEvent>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let js = match event {
                CommandEvent::Stdout(b) => AgentEvent::Stdout(b),
                CommandEvent::Stderr(b) => AgentEvent::Stderr(b),
                CommandEvent::Error(e) => {
                    log::warn!("[agent] 进程错误: {e}");
                    AgentEvent::Error(e)
                }
                CommandEvent::Terminated(p) => {
                    log::info!("[agent] 进程退出 code={:?}", p.code);
                    AgentEvent::Terminated { code: p.code }
                }
                _ => continue,
            };
            if on_event.send(js).is_err() {
                log::warn!("[agent] 前端 channel 已断开，停止转发事件");
                break;
            }
        }
    });
}

/// 清空进程表（退出时兜底）。
pub fn on_exit_cleanup(app: &AppHandle) {
    let state = app.state::<AgentStore>();
    let mut map = match state.0.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    for (_, child) in map.drain() {
        let _ = child.kill();
    }
}

pub fn init_state(app: &mut tauri::App) {
    app.manage(AgentStore(Mutex::new(HashMap::new())));
}

/// 在 Builder 的 RunEvent::Exit 时调用（lib.rs 接线）。
pub fn handle_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::Exit = event {
        on_exit_cleanup(app);
    }
}
