// P33 F-32-2 系统托盘：图标常驻 + 运行中会话数 + 菜单退出（先清理后退出）。
//
// tauri 2 内建 tray-icon feature（无第三方插件）。Rust 保持薄——不反查业务状态，
// 运行中会话数由前端在 busy 集变化时经 tray_set_busy_count 推送。
// 退出语义复用既有清理链：app.exit(0) 触发 RunEvent::Exit → agent/terminal
// 的 on_exit_cleanup（负 pgid SIGKILL），与关窗退出等价（AC-P33-8）。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager,
};

/// 托盘「运行中会话数」行文案。0/1/N 三态（前端同构逻辑无须，Rust 菜单直用）。
pub fn busy_label(n: u32) -> String {
    match n {
        0 => "空闲中".into(),
        1 => "运行中 1 个会话".into(),
        n => format!("运行中 {n} 个会话"),
    }
}

/// 应用启动时创建托盘。菜单项 id：show / busy-count（禁用展示行）/ quit。
pub fn setup_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let busy = MenuItem::with_id(app, "busy-count", &busy_label(0), false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &busy, &quit])?;

    let icon = app.default_window_icon().cloned().ok_or_else(|| {
        tauri::Error::AssetNotFound("default window icon".into())
    })?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        // macOS：模板图标（monochrome）自适应深浅色——应用图标是彩色非模板，
        // 保持 as_template(false)（默认）即彩色显示，语义正确
        .tooltip("ainone-ui")
        .menu(&menu)
        .show_menu_on_left_click(false) // 左键本体 = 显示窗口；右键 = 菜单
        .on_menu_event(|app, event| {
            log::info!("[tray] 菜单动作: {}", event.id.0);
            match event.id.as_ref() {
                "show" => show_main_window(app),
                "quit" => {
                    log::info!("[tray] 托盘退出——app.exit(0) 触发 RunEvent::Exit 清理链");
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击图标本体 = 显示主窗口（菜单由右键唤起）
            if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 前端推送运行中会话数（busy 集变化时调用）。更新菜单 busy-count 行 + tooltip。
#[tauri::command]
pub fn tray_set_busy_count(app: AppHandle, count: u32) {
    let label = busy_label(count);
    log::debug!("[tray] busy count -> {count}");
    if let Some(tray) = app.tray_by_id("main-tray") {
        // tooltip 同步（macOS 悬停可见）
        let _ = tray.set_tooltip(Some(format!("ainone-ui · {label}")));
    }
    // 菜单项文本更新：按 id 找菜单项（Menu 挂在托盘上）
    if let Some(item) = app.menu().and_then(|m| m.get("busy-count")) {
        if let tauri::menu::MenuItemKind::MenuItem(mi) = item {
            let _ = mi.set_text(label);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::busy_label;

    #[test]
    fn busy_label_three_states() {
        assert_eq!(busy_label(0), "空闲中");
        assert_eq!(busy_label(1), "运行中 1 个会话");
        assert_eq!(busy_label(3), "运行中 3 个会话");
    }
}
