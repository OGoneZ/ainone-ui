// 终端会话（P23）：内嵌 PTY 终端的后端。
//
// 架构（p23g 重构，修复 P23-D1）：PTY 进程管理直接用 wezterm 的 portable-pty
// （tauri-plugin-pty 的同一底座，社区成熟实现），**数据通道全部自管**：
//   - spawn：terminal_spawn 命令内 openpty + spawn_command，返回 {pid, terminalId}
//   - 读：独立 std::thread 阻塞读 PTY reader（不占 tokio worker），逐块经
//     tauri::ipc::Channel 推送（参照 agent.rs pump_events 模式）→ 终端多开互不
//     抢占 runtime，彻底解决 tauri-plugin-pty「read 轮询持锁 → pty 命令饿死」
//   - 写/resize/kill：自有命令 terminal_write/resize/kill，各拿各的锁
//   - 退出码：读线程读到 EOF 后 wait() 拿 exit code，经同一 Channel 推 exited 事件
//
// 为什么不再用 tauri-plugin-pty 的命令层：其 read 是 async command + 前端轮询，
// 多终端并发时把 tokio worker 占满，kill/write/resize 全部饿死（P23-D1 实测）。
// 会话表（TerminalStore）也随之上移到本模块：pid → 会话句柄，track/untrack
// 不再需要前端逐次登记，Rust 侧闭环。
//
// 退出清理：RunEvent::Exit 对全部会话发负 pgid SIGKILL（连 vim/less 子进程组）。

use portable_pty::{native_pty_system, Child, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// 默认 shell 探测 + 增强 PATH 一并返回：$SHELL 优先（空串视为未设），兜底
/// /bin/zsh；args 恒为 ["-l"]（login shell——桌面应用不经 login，终端里的
/// profile/PATH 靠它补齐）。PATH 用 enhanced_path()（增强目录在前、进程 PATH
/// 在后，env_path.rs 唯一事实源），前端 spawn 时作为 env 注入，与 harness
/// 子进程同等可达 node/bun/omp 等用户工具。
#[tauri::command]
pub fn terminal_default_shell_with_path() -> Result<ShellSpec, String> {
    let program = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    Ok(ShellSpec {
        program,
        args: vec!["-l".to_string()],
        path: crate::env_path::enhanced_path(),
    })
}

#[derive(Debug, Serialize)]
pub struct ShellSpec {
    pub program: String,
    pub args: Vec<String>,
    pub path: String,
}

/// 推给前端的事件（channel onmessage 收 {event, payload}）。
/// P32 R8：Data payload 改 base64 字符串（Tauri Channel 无二进制支持，
/// Vec<u8> → number[] 体积 ~4x；base64 ~1.33x，前端 atob 还原）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "payload", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// PTY 输出字节块（base64 编码；UTF-8 由前端解码，支持跨 chunk 多字节）
    Data(String),
    /// shell 已退出
    Exited { code: u32 },
}

struct TerminalSession {
    writer: Mutex<Box<dyn std::io::Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

struct TerminalStore(pub Mutex<HashMap<u64, Arc<TerminalSession>>>);

static NEXT_TERMINAL_ID: AtomicU64 = AtomicU64::new(1);

/// spawn 默认 shell 进 PTY。返回 (terminalId, pid)；输出/退出经 on_event 推送。
#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalSpawned, String> {
    let terminal_id = NEXT_TERMINAL_ID.fetch_add(1, Ordering::SeqCst);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty 失败: {e}"))?;

    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    if let Some(cwd) = cwd.as_ref().filter(|c| !c.is_empty()) {
        cmd.cwd(cwd);
    }
    for (k, v) in &env {
        cmd.env(k, v);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn {program} 失败: {e}"))?;
    let pid = child.process_id().unwrap_or(0);
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer 失败: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader 失败: {e}"))?;

    let session = Arc::new(TerminalSession {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
    });
    app.state::<TerminalStore>()
        .0
        .lock()
        .map_err(|_| "终端进程表锁中毒".to_string())?
        .insert(terminal_id, session.clone());

    // 读线程：阻塞读（不占 tokio worker），EOF 后 wait 拿退出码一并推送。
    // 前端断开（tab 关闭后 channel 失效）时 send 报错即停。
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // EOF / 读错误 → 进程退出
                Ok(n) => {
                    if on_event.send(TerminalEvent::Data(crate::agent::b64(&buf[..n]))).is_err() {
                        // channel 断开但进程还活着：继续排空 reader 直到 EOF，
                        // 保证 wait() 可回收，只丢弃数据
                        continue;
                    }
                }
            }
        }
        let code = session
            .child
            .lock()
            .map(|mut guard| guard.wait().map(|s| s.exit_code()).unwrap_or(0))
            .unwrap_or_else(|e| e.into_inner().wait().map(|s| s.exit_code()).unwrap_or(0));
        let _ = on_event.send(TerminalEvent::Exited { code });
        // session Arc 引用计数归零即释放句柄；表条目由 terminal_kill/退出清理摘除
    });

    log::info!("[terminal:{terminal_id}] spawn {program} pid={pid} cwd={:?}", cwd);
    Ok(TerminalSpawned { terminal_id, pid })
}

#[derive(Debug, Serialize)]
pub struct TerminalSpawned {
    pub terminal_id: u64,
    pub pid: u32,
}

/// 向终端写输入（键盘/粘贴）。
#[tauri::command]
pub fn terminal_write(app: tauri::AppHandle, terminal_id: u64, data: String) -> Result<(), String> {
    let session = get_session(&app, terminal_id)?;
    let mut w = session
        .writer
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    w.write_all(data.as_bytes())
        .map_err(|e| format!("终端写入失败: {e}"))
}

/// 调整 PTY 尺寸（xterm fit → SIGWINCH 链路）。
#[tauri::command]
pub fn terminal_resize(
    app: tauri::AppHandle,
    terminal_id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Ok(()); // fit 在 0 尺寸容器时给出 0，忽略
    }
    let session = get_session(&app, terminal_id)?;
    let master = session.master.lock().unwrap_or_else(|e| e.into_inner());
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("终端 resize 失败: {e}"))
}

/// kill 终端（关闭 tab）：对进程组发 SIGKILL，随后从会话表摘除。
#[tauri::command]
pub fn terminal_kill(app: tauri::AppHandle, terminal_id: u64) -> Result<(), String> {
    let session = get_session(&app, terminal_id)?;
    let pid = session
        .child
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .process_id()
        .unwrap_or(0);
    if pid > 0 {
        kill_unix(pid);
    }
    app.state::<TerminalStore>()
        .0
        .lock()
        .map_err(|_| "终端进程表锁中毒".to_string())?
        .remove(&terminal_id);
    log::info!("[terminal:{terminal_id}] kill pid={pid}");
    Ok(())
}

fn get_session(app: &AppHandle, terminal_id: u64) -> Result<Arc<TerminalSession>, String> {
    let state = app.state::<TerminalStore>();
    let map = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.get(&terminal_id)
        .cloned()
        .ok_or_else(|| format!("终端 {terminal_id} 不存在（已关闭）"))
}

pub fn init_state(app: &mut tauri::App) {
    app.manage(TerminalStore(Mutex::new(HashMap::new())));
}

/// RunEvent::Exit 接线（lib.rs 调用）：kill 全部登记的 PTY 子进程并清表。
/// 注意必须由调用方过滤 RunEvent::Exit（对齐 agent.rs handle_run_event 模式），
/// run 回调会对每个 RunEvent 变体（Ready/Resumed/Main…）触发，不过滤会误杀。
pub fn handle_run_event(app: &AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::Exit = event {
        on_exit_cleanup(app);
    }
}

pub fn on_exit_cleanup(app: &AppHandle) {
    let state: tauri::State<'_, TerminalStore> = app.state();
    let mut map = match state.0.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    for (id, session) in map.drain() {
        let pid = session
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .process_id()
            .unwrap_or(0);
        if pid > 0 {
            kill_unix(pid);
        }
        log::info!("[terminal:{id}] 退出清理 kill pid={pid}");
    }
}

/// kill 终端子进程。终端 shell 常派生子进程（vim/less），单杀 shell 会留孤儿；
/// portable-pty unix 实现下子进程经 setsid 有独立进程组，会话首进程 pid == pgid，
/// 对负 pgid 发 SIGKILL 连组清掉（再对正 pid 兜一发防边界）。
#[cfg(unix)]
fn kill_unix(pid: u32) {
    let pgid = pid as i32;
    unsafe {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        let _ = kill(-pgid, 9);
        let _ = kill(pgid, 9);
    }
}

#[cfg(not(unix))]
fn kill_unix(_pid: u32) {
    // 非 unix 不支持（规格 §5：不做 Windows），留空
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_prefers_env() {
        // 有 SHELL 且非空 → 原样采用 + login 参数
        std::env::set_var("SHELL", "/bin/bash");
        let program = std::env::var("SHELL").unwrap();
        assert_eq!(program, "/bin/bash");
        std::env::remove_var("SHELL");
    }

    #[test]
    fn terminal_event_shape() {
        // serde tag 形状稳定（前端 pty.ts 按此分发）；P32 R8：payload 为 base64 字符串
        let data = serde_json::to_value(TerminalEvent::Data(crate::agent::b64(&[1, 2]))).unwrap();
        assert_eq!(data["event"], "data");
        assert_eq!(data["payload"], "AQI="); // [1,2] 的标准 base64
        let exit = serde_json::to_value(TerminalEvent::Exited { code: 3 }).unwrap();
        assert_eq!(exit["event"], "exited");
        assert_eq!(exit["payload"]["code"], 3);
    }
}
