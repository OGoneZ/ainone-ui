// ainone-ui：统一多 harness 的 ACP 桌面客户端
//
// UI 均为 React（src/）。这里（Rust 层）只做两件网页沙箱做不了的事：
//   1. ACP 的 fs/* 回调——读/写本地绝对路径文件（fs.rs）
//   2. 进程管道——spawn harness 子进程并双向搬运 stdin/stdout 字节（agent.rs）
//
// 本文件只做模块声明 + 应用组装（Builder/插件/命令注册/退出清理），
// 各命令实现在对应职责模块内。

mod adapters;
mod agent;
mod asr;
mod connector;
mod env_path;
mod fs;
mod fslist;
mod gitmeta;
mod harness_probe;
mod quickask;
mod sessions;
mod terminal;
mod workspaces;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 日志：stdout（dev 终端）+ 日志目录（macOS ~/Library/Logs/com.zhubaoduo.ainone-ui/）
    // 到达 1MB 轮转并保留全部（KeepAll），级别过滤到 WARN 以上可用 level_for 单独调。
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init());
    // 内嵌终端 PTY（P23，p23g 重构）：portable-pty + 自管读线程 + Channel 推送，
    // 命令 terminal_spawn/write/resize/kill 由 terminal.rs 注册（不再用
    // tauri-plugin-pty 的命令层——read 轮询持锁会饿死 pty 命令，P23-D1）。
    // 前端调试桥（P19c，仅 dev 且带 webdriver feature）：W3C WebDriver 服务内嵌
    // 在应用里，AI agent 可经 HTTP 直接驱动 WebView（执行 JS / 截图 / 查元素）。
    // dev：tauri.conf.json build.features 含 "webdriver"；打包用 tauri.dist.conf.json
    // 覆盖（features 空）→ release 完全不含。README「前端调试」。
    #[cfg(all(debug_assertions, feature = "webdriver"))]
    let builder = builder.plugin(tauri_plugin_webdriver::init());
    builder
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
            terminal::init_state(app);
            // 启动即后台抓取 login shell PATH（8s 超时，永不阻塞 UI）
            env_path::fetch_login_shell_path_async();
            log::info!("ainone-ui 启动完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs::fd_read,
            fs::fd_write,
            fs::abs_path,
            adapters::adapters_list,
            adapters::adapters_save,
            adapters::adapter_available,
            adapters::adapter_status,
            adapters::default_cwd,
            connector::connector_status,
            connector::connector_install,
            agent::agent_spawn,
            agent::agent_stdin_write,
            agent::agent_kill,
            agent::agent_kill_idle,
            agent::get_base_env,
            sessions::sessions_list,
            sessions::sessions_upsert,
            sessions::sessions_remove,
            sessions::log_read,
            sessions::log_append,
            sessions::log_truncate,
            sessions::log_copy,
            workspaces::workspaces_list,
            workspaces::workspaces_upsert,
            workspaces::workspaces_remove,
            fslist::workspace_list_dir,
            gitmeta::git_current_branch,
            quickask::quick_ask,
            quickask::quickask_config_get,
            quickask::quickask_config_save,
            asr::asr_transcribe,
            asr::asr_config_get,
            asr::asr_config_save,
            terminal::terminal_default_shell_with_path,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 应用退出时清理所有自管子进程（harness agent + 终端 PTY）
            agent::handle_run_event(app, event);
            terminal::on_exit_cleanup(app);
        });
}
