// 白屏自愈（P35）：WebKitWebProcess 崩溃（web-process-crashed 信号）时自动恢复。
//
// 背景：WebKitGTK 的 UI 全部跑在 WebKitWebProcess 里，它死亡后主窗口只剩白屏，
// 主进程与本地数据都完好。此前无人监听崩溃信号，一旦发生只能手动重启（2026-09-09
// 实机事故）。wry/Tauri 默认不接这个信号，这里在 setup 后经 with_webview 挂接。
//
// 策略（两个防回归点合一）：
//   1. 取证：崩溃即写 log::warn!，落 ainone-ui.log（此前只能确定"死了"，无法
//      确定"怎么死的"——时间线从此有了锚点，可对照 OOM/kill 等外部事件）。
//   2. 自愈：调 reload()（WebKitWebView 自身方法，主进程侧 GTK 调用，不依赖
//      已死的 web 进程）。连续崩溃保护：CRASH_WINDOW 滑动窗口内崩溃达到
//      CRASH_LIMIT 次只记日志不再重载，避免崩溃循环（页面本身有病时 reload
//      会无限复发）。
//
// 平台边界：仅 Linux（webkit2gtk）。macOS/Windows 的 web 进程崩溃模型不同
// （WKWebView / WebView2 各有原生 API），本模块不做跨平台。

#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

/// 滑动窗口长度：窗口内的崩溃都计入连续崩溃计数
#[cfg(target_os = "linux")]
pub(crate) const CRASH_WINDOW: Duration = Duration::from_secs(60);
/// 窗口内崩溃达到该次数 → 停止自动重载（只记日志，等用户手动处理）
#[cfg(target_os = "linux")]
pub(crate) const CRASH_LIMIT: usize = 3;

/// 连续崩溃保护的状态：崩溃时间戳的滑动窗口。
/// glib 信号回调与 with_webview 挂接同在主线程，Mutex 只为满足 Send/Sync。
#[cfg(target_os = "linux")]
#[derive(Default)]
pub struct CrashGuard {
    recent: Mutex<Vec<Instant>>,
}

#[cfg(target_os = "linux")]
impl CrashGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记录一次崩溃并判定是否允许自动重载。
    /// 窗口外的时间戳先剔除；窗口内崩溃数（含本次）≥ CRASH_LIMIT → 禁止。
    pub fn register_crash(&self, now: Instant) -> bool {
        let mut recent = self.recent.lock().unwrap();
        recent.retain(|t| now.duration_since(*t) < CRASH_WINDOW);
        recent.push(now);
        recent.len() < CRASH_LIMIT
    }
}

/// 给主 webview 挂 web-process-crashed 信号。setup 里调用一次。
/// 非 Linux（或主窗口不存在）为 no-op。
#[cfg(not(target_os = "linux"))]
pub fn install(_app: &tauri::AppHandle) {}

#[cfg(target_os = "linux")]
pub fn install(app: &tauri::AppHandle) {
    use tauri::Manager;
    // connect_web_process_crashed / reload 都来自 WebViewExt trait，必须在作用域内
    use webkit2gtk::WebViewExt;

    let Some(win) = app.get_webview_window("main") else {
        log::warn!("[webview] 未找到主窗口，白屏自愈未挂接");
        return;
    };
    // with_webview 回调在主线程执行，此时 GTK webview 已就绪可连信号
    if let Err(e) = win.with_webview(move |platform| {
        let webview = platform.inner();
        let guard = Arc::new(CrashGuard::new());
        let crashes = Arc::new(AtomicUsize::new(0));
        webview.connect_web_process_crashed(move |wv| {
            let n = crashes.fetch_add(1, Ordering::Relaxed) + 1;
            // 防回归点 2：取证落日志（tauri-plugin-log → ainone-ui.log）
            log::warn!("[webview] WebKitWebProcess 崩溃（第 {n} 次）——对照 OOM/信号取证");
            // 防回归点 1：自动重载自愈白屏；连续崩溃则只报不重载
            if guard.register_crash(Instant::now()) {
                log::info!("[webview] 崩溃自愈：触发 reload()");
                wv.reload();
            } else {
                log::error!(
                    "[webview] 60s 内连续崩溃 {n} 次，停止自动重载（请手动重启应用）"
                );
            }
            // true = 已处理（WebKit 继续默认收尾：清空 web 进程）
            true
        });
        log::info!("[webview] web-process-crashed 自愈已挂接");
    }) {
        log::warn!("[webview] with_webview 挂接失败（自愈降级为无）: {e}");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn crash_guard_allows_first_two() {
        // 连续崩溃保护：窗口内前 2 次允许重载
        let g = CrashGuard::new();
        let now = Instant::now();
        assert!(g.register_crash(now));
        assert!(g.register_crash(now));
    }

    #[test]
    fn crash_guard_blocks_third() {
        // 第 3 次（窗口内）→ 禁止重载，防止崩溃循环
        let g = CrashGuard::new();
        let now = Instant::now();
        g.register_crash(now);
        g.register_crash(now);
        assert!(!g.register_crash(now));
    }

    #[test]
    fn crash_guard_window_expires() {
        // 窗口过期（>60s）后计数清零，重新允许重载——偶发崩溃相隔较远互不影响
        let g = CrashGuard::new();
        let base = Instant::now();
        g.register_crash(base);
        g.register_crash(base);
        let later = base + CRASH_WINDOW + Duration::from_secs(1);
        assert!(g.register_crash(later));
    }
}
