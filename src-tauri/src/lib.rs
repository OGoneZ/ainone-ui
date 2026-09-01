// ainone-ui：统一多 harness 的 ACP 桌面客户端
//
// UI 均为 React（src/）。这里（Rust 层）只做两件网页沙箱做不了的事：
//   1. ACP 的 fs/* 回调——读/写本地绝对路径文件
//   2. 进程管道——spawn harness 子进程并双向搬运 stdin/stdout 字节
//
// 注意：fd_write 是「本地用户确认后」的代理写盘。路径须由前端在权限审批
// 弹窗中向用户展示并确认后，才允许调用本命令。默认不做任何路径白名单，
// 把裁决权交给用户侧 UI。

#[tauri::command]
fn fd_read(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败 {}: {}", path, e))
}

#[tauri::command]
fn fd_write(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("写入失败 {}: {}", path, e))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![fd_read, fd_write, get_base_env])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
