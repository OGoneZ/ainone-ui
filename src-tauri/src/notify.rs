// P33 F-32-1 系统通知：turn 完成 / 权限等待时提醒（窗口失焦才发——决策在前端
// shouldNotify 纯函数，这里只负责发送）。
//
// 插件事实（2.4.0 desktop 源码核实）：notify-rust 桌面端 show() 无点击回调 API，
// 通知点击唤起窗口在桌面端不可用（无 on_notification action）。降级语义：通知
// 提示「回到应用查看」；macOS 用户点 Dock 图标、Windows 用户点任务栏即回应用
// ——唤起动作交给平台原生交互，不自研通知中心 hook。
//
// 发送走 Rust 统一路径（插件 Rust API），不在 WebView 里直调 JS 端插件：
// 权限归 capabilities 统一管、日志归 Rust log。

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// 发一条系统通知。title/body 由前端组装（含 adapter 名与摘要）。
/// 发送失败（系统未授权/无通知服务）静默 warn，不打扰 UI（R-32-5）。
#[tauri::command]
pub fn notify_send(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| {
            log::warn!("[notify] 发送失败（系统可能未授权通知）: {e}");
            e.to_string()
        })
}
