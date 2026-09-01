// 进程管理：自管 harness 子进程（数据 + 逻辑，命令入口在 lib.rs）。
//
// 为什么不用前端 plugin-shell 的 JS API（plugin:shell|spawn）？
//   它受 capability scope 限制，只允许 spawn 预注册的程序。而适配器是「配置驱动」的，
//   新增任意 harness 不该逐个改 capability。故此处改走 Rust 侧 ShellExt::shell().command()
//   （不经过 scope），自行维护 agentId → 子进程映射。
//
// 注意：Tauri 的 #[tauri::command] 若定义在子模块再经 generate_handler! 路径引用，
//   会碰到宏可见性限制（__cmd__* 私有）。故命令函数统一放 lib.rs，本模块只放
//   无宏的底层支撑。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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
                CommandEvent::Error(e) => AgentEvent::Error(e),
                CommandEvent::Terminated(p) => AgentEvent::Terminated { code: p.code },
                _ => continue,
            };
            if on_event.send(js).is_err() {
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
