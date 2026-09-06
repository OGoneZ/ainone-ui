// 终端会话（P23）：内嵌 PTY 终端的后端薄层。
//
// PTY 全部重活由社区插件 tauri-plugin-pty（底层 wezterm 的 portable-pty）承担：
// spawn/read/write/resize/kill/exitstatus/get_all_pids 七条命令由插件 init() 注册，
// 前端经 `plugin:pty|<cmd>` 直接 invoke（capability 放行 pty:default）。
//
// 本模块只补两件插件不管的事：
//   1. terminal_default_shell —— 默认 shell 探测（$SHELL，兜底 /bin/zsh），
//      供前端 spawn 入参；语义对齐 env_path.rs 的 login shell 用法。
//   2. 进程登记表 + 退出清理 —— 应用退出时 kill 全部 PTY 子进程，防 shell
//      残留（agent.rs on_exit_cleanup 的终端版）。插件不暴露其进程表，
//      故自建登记：前端 spawn 成功后 terminal_track 登记，kill/退出后 untrack。
//
// 为什么不空气回收：终端常驻属预期，无 harness 的 LLM 成本语义（规格 §5）。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// 默认 shell 探测：$SHELL 优先（空串视为未设），兜底 /bin/zsh。
/// args 恒为 ["-l"]（login shell——桌面应用不经 login，终端里的 PATH/profile
/// 靠它补齐；env PATH 另由前端 spawn 时注入增强 PATH）。
#[tauri::command]
pub fn terminal_default_shell() -> Result<ShellSpec, String> {
    let program = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    Ok(ShellSpec {
        program,
        args: vec!["-l".to_string()],
    })
}

#[derive(Debug, Serialize)]
pub struct ShellSpec {
    pub program: String,
    pub args: Vec<String>,
}

pub struct TerminalStore(pub Mutex<HashMap<u32, ()>>);

/// 前端 spawn 成功后登记 pid（退出清理的事实源）。
#[tauri::command]
pub fn terminal_track(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    let state: tauri::State<'_, TerminalStore> = app.state();
    state
        .0
        .lock()
        .map_err(|_| "终端进程表锁中毒".to_string())?
        .insert(pid, ());
    Ok(())
}

/// 终端关闭/退出后解除登记（kill 命令本身走插件）。
#[tauri::command]
pub fn terminal_untrack(app: tauri::AppHandle, pid: u32) -> Result<(), String> {
    let state: tauri::State<'_, TerminalStore> = app.state();
    state
        .0
        .lock()
        .map_err(|_| "终端进程表锁中毒".to_string())?
        .remove(&pid);
    Ok(())
}

pub fn init_state(app: &mut tauri::App) {
    app.manage(TerminalStore(Mutex::new(HashMap::new())));
}

/// RunEvent::Exit 接线（lib.rs 调用）：kill 全部登记的 PTY 子进程并清表。
pub fn on_exit_cleanup(app: &AppHandle) {
    use tauri::Manager;
    let state: tauri::State<'_, TerminalStore> = app.state();
    let mut map = match state.0.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    for pid in map.keys().copied().collect::<Vec<_>>() {
        kill_unix(pid);
        map.remove(&pid);
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
        let spec = terminal_default_shell().unwrap();
        assert_eq!(spec.program, "/bin/bash");
        assert_eq!(spec.args, vec!["-l".to_string()]);
        // 空串 → 兜底 zsh
        std::env::set_var("SHELL", "");
        let spec = terminal_default_shell().unwrap();
        assert_eq!(spec.program, "/bin/zsh");
        std::env::remove_var("SHELL");
    }

    #[test]
    fn default_shell_falls_back_to_zsh() {
        // SHELL 未设（上一个测试已 remove）→ 兜底
        std::env::remove_var("SHELL");
        let spec = terminal_default_shell().unwrap();
        assert_eq!(spec.program, "/bin/zsh");
    }
}
