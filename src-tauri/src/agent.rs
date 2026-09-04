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
/// PATH 用增强 PATH 整体替换（env_path.rs：用户目录 + nvm + login shell + 进程 PATH）。
#[tauri::command]
pub fn get_base_env() -> std::collections::HashMap<String, String> {
    let keys = [
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
    env.insert("PATH".to_string(), crate::env_path::enhanced_path());
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
///
/// 两件关键事（leju 故障修复，见 plan）：
///   1. 程序名解析为绝对路径——unix 上 std::process::Command 查找程序用父进程
///      PATH（execvp 语义），只改子进程 env 不够；
///   2. 子进程 env PATH 注入增强 PATH——桌面应用进程 PATH 常缺用户目录
///      （~/.bun/bin 等），且系统目录旧版工具会遮蔽用户新版（/usr/local/bin/bun）。
pub fn spawn_inner(
    app: &AppHandle,
    agent_id: u64,
    program: &str,
    args: &[String],
    cwd: &str,
) -> Result<tauri::async_runtime::Receiver<CommandEvent>, String> {
    // Claude Code 连接器懒安装兜底：PATH 自装优先；没有则尝试应用管理的连接器
    //（bun <entry> 形式 spawn），连接器缺失时自动安装（connector.rs）。
    if program == "claude-agent-acp" && crate::env_path::find_program(program).is_none() {
        let connector = crate::connector::connector_install(app.to_owned())?;
        return spawn_connector(app, agent_id, &connector, args, cwd);
    }

    let hit = crate::env_path::find_program(program);
    let resolved = match &hit {
        Some(h) => h.path.clone(),
        None => {
            return Err(format!(
                "未找到程序 {program}：已搜索增强 PATH（~/.local/bin、~/.bun/bin、nvm、登录 shell PATH …）与进程 PATH。\
                 请确认已安装，或在设置中把 program 改为绝对路径。"
            ));
        }
    };
    log::info!(
        "[agent:{agent_id}] spawn {program} → {} (source={:?}) {:?} cwd={cwd}",
        resolved.display(),
        hit.as_ref().map(|h| &h.source),
        args
    );
    let mut cmd = app
        .shell()
        .command(&resolved)
        .args(args)
        .set_raw_out(true)
        .env("PATH", crate::env_path::enhanced_path())
        .envs(claude_env_inject());
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

/// spawn 应用管理的连接器：`bun <entry> <args>`（连接器纯 ESM JS，bun/node 均可跑）。
fn spawn_connector(
    app: &AppHandle,
    agent_id: u64,
    connector: &crate::connector::ResolvedConnector,
    args: &[String],
    cwd: &str,
) -> Result<tauri::async_runtime::Receiver<CommandEvent>, String> {
    let runtime = crate::env_path::find_program("bun")
        .map(|h| h.path)
        .or_else(|| crate::env_path::find_program("node").map(|h| h.path))
        .ok_or_else(|| "未找到 bun 或 node 运行时，无法启动 Claude Code 连接器".to_string())?;
    log::info!(
        "[agent:{agent_id}] spawn claude-agent-acp(managed v{}) → {} {} {:?} cwd={cwd}",
        connector.version,
        runtime.display(),
        connector.entry,
        args
    );
    let mut cmd = app
        .shell()
        .command(&runtime)
        .arg(&connector.entry)
        .args(args)
        .set_raw_out(true)
        .env("PATH", crate::env_path::enhanced_path())
        .envs(claude_env_inject());
    if !cwd.is_empty() {
        cmd = cmd.current_dir(cwd);
    }
    let (rx, child) = cmd
        .spawn()
        .map_err(|e| format!("spawn claude-agent-acp 失败: {e}"))?;
    app.state::<AgentStore>()
        .0
        .lock()
        .map_err(|_| "进程表锁中毒".to_string())?
        .insert(agent_id, child);
    Ok(rx)
}

/// Claude Code 连接器的 claude 二进制定位：注入 CLAUDE_CODE_EXECUTABLE
/// （acp-agent.js claudeCliPath() 的官方覆盖点）。用户没装 claude 时不注入，
/// 由连接器报清晰错误引导安装。
fn claude_env_inject() -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(hit) = crate::env_path::find_program("claude") {
        env.push((
            "CLAUDE_CODE_EXECUTABLE".to_string(),
            hit.path.to_string_lossy().into_owned(),
        ));
    }
    env
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
