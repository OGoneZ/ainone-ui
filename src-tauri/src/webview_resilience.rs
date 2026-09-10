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
//      已死的 web 进程）。连续重载保护：CRASH_WINDOW 滑动窗口内达到 CRASH_LIMIT
//      次只记日志不再重载，避免崩溃循环（页面本身有病时 reload 会无限复发）。
//
// P40 卡死看门狗（2026-09-10 实机事故，原生栈实证）：
//   崩溃信号覆盖不到**卡死**——WebKitWebProcess 的 libpas 分配器/scavenger 线程
//   进入病态空转时（11GB 堆 + 双线程 100% CPU，RSS 稳定、上下文切换近乎为零），
//   进程不崩也不响应，崩溃信号永不触发，表现为「永久白屏，只能手动重启」。
//   两条动作判据（任一连续 TRIGGER_STRIKES 轮命中即 reload）：
//     a) 心跳超时：前端可见时周期上报心跳（webview_heartbeat），空闲态超
//        HEARTBEAT_TIMEOUT 未上报即判死——这是**用户视角**的判据（页面确实
//        转不动了：JS 主线程被占死时定时器停摆，心跳自然断流）。
//     b) WebKit 官方判据：`is_web_process_responsive()` 返回 false。WebKit 内部
//        维护的「web 进程是否响应」标志，不依赖前端 JS（心跳断流时仍有独立信号）。
//   内存仅作留痕：RSS 超 MEMORY_LIMIT_BYTES 只记 warn（事故 11GB vs 正常 1GB
//   量级），**不单独触发动作**——大历史会话内存天然偏高，单凭内存易误杀。
//   忙时跳轮：前端自报 busy（turn 在跑/权限待答）时不判心跳（长 turn 本就稀疏），
//   仅保留 WebKit 判据（WebKit 自己知道自己在忙，不会因长计算误报不响应）。
//   自愈次数与崩溃自愈共用同一滑动窗口守卫——页面真有病时不会无限重载。
//
// 平台边界：仅 Linux（webkit2gtk）。macOS/Windows 的 web 进程崩溃模型不同
// （WKWebView / WebView2 各有原生 API），本模块不做跨平台。

#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

/// 滑动窗口长度：窗口内的自愈都计入连续计数
#[cfg(target_os = "linux")]
pub(crate) const CRASH_WINDOW: Duration = Duration::from_secs(60);
/// 窗口内达到该次数 → 停止自动重载（只记日志，等用户手动处理）
#[cfg(target_os = "linux")]
pub(crate) const CRASH_LIMIT: usize = 3;

/// 连续重载保护的状态：重载时间戳的滑动窗口。
/// glib 信号回调与看门狗线程共用同一实例（Mutex 满足 Send/Sync）。
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

    /// 记录一次重载并判定是否允许。
    /// 窗口外的时间戳先剔除；窗口内次数（含本次）≥ CRASH_LIMIT → 禁止。
    pub fn register_crash(&self, now: Instant) -> bool {
        let mut recent = self.recent.lock().unwrap();
        recent.retain(|t| now.duration_since(*t) < CRASH_WINDOW);
        recent.push(now);
        recent.len() < CRASH_LIMIT
    }
}

// ---------- P40：卡死看门狗（崩溃信号覆盖不到的场景） ----------

/// 采样周期
#[cfg(target_os = "linux")]
const WATCHDOG_INTERVAL: Duration = Duration::from_secs(5);
/// 内存留痕阈值（不触发动作）：事故 11GB vs 正常 1GB 量级
#[cfg(target_os = "linux")]
const MEMORY_LIMIT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// 心跳宽限期：空闲态超过该时长未收到心跳 → 判页面无响应（取样周期的整数倍）
#[cfg(target_os = "linux")]
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
/// 判定命中后连续多少轮才动作（防单次采样毛刺误杀）
#[cfg(target_os = "linux")]
const TRIGGER_STRIKES: u32 = 3;

/// 看门狗共享状态：心跳时间戳 + 忙碌标记（前端 turn 进行中/权限待答）。
/// 由 `webview_heartbeat` 命令更新，看门狗线程读取。
#[cfg(target_os = "linux")]
#[derive(Default)]
pub struct Watchdog {
    /// 最后一次心跳时刻（None = 前端从未上报）
    last_beat: Mutex<Option<Instant>>,
    /// 前端自报忙碌（长 turn 期间心跳稀疏属正常态）
    busy: AtomicBool,
}

#[cfg(target_os = "linux")]
impl Watchdog {
    /// 记录一次心跳。busy = 前端当前有 turn 在跑或权限待答。
    pub fn beat(&self, busy: bool) {
        self.busy.store(busy, Ordering::Relaxed);
        if let Ok(mut t) = self.last_beat.lock() {
            *t = Some(Instant::now());
        }
    }

    /// 纯判定：空闲态下心跳是否已超期。
    /// 忙碌态不判（长 turn 正常不跳帧）；从未上报过 → 不判（尚未建立基准）。
    pub fn heartbeat_expired(&self, now: Instant) -> bool {
        if self.busy.load(Ordering::Relaxed) {
            return false;
        }
        match self.last_beat.lock() {
            Ok(t) => match *t {
                Some(last) => now.duration_since(last) > HEARTBEAT_TIMEOUT,
                None => false,
            },
            Err(_) => false,
        }
    }
}

/// 全局看门狗单例（install 时注册；心跳命令与看门狗线程共用）。
#[cfg(target_os = "linux")]
static WATCHDOG: std::sync::OnceLock<Watchdog> = std::sync::OnceLock::new();

/// 读指定 pid 的 RSS（/proc/<pid>/status 的 VmRSS，kB → 字节）；取不到返回 None。
#[cfg(target_os = "linux")]
fn read_rss_bytes(pid: u32) -> Option<u64> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

/// 找本进程的 WebKit web 进程并读其 RSS。
/// web 进程是主进程的直接子进程（comm = WebKitWebProcess）：扫 /proc 匹配 PPid。
#[cfg(target_os = "linux")]
fn web_process_rss() -> Option<u64> {
    let me = std::process::id();
    for e in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        // comm 可能含空格/括号 → 取最后一个 ')' 之后的 state/ppid 字段
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        let Some((_, rest)) = stat.rsplit_once(')') else { continue };
        let mut it = rest.split_whitespace();
        let _state = it.next();
        let Some(ppid) = it.next().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if ppid != me {
            continue;
        }
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
        if comm.trim() == "WebKitWebProcess" {
            return read_rss_bytes(pid);
        }
    }
    None
}

/// 前端心跳上报（App 挂载后周期调用）。busy = 有 turn 在跑或权限待答。
/// 非 Linux 无看门狗，no-op。
#[tauri::command]
pub fn webview_heartbeat(busy: bool) {
    #[cfg(target_os = "linux")]
    if let Some(w) = WATCHDOG.get() {
        w.beat(busy);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = busy;
}

/// 给主 webview 挂 web-process-crashed 信号 + 启动卡死看门狗。setup 里调用一次。
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
    // 崩溃自愈与看门狗自愈共用同一连续重载守卫（合计 60s 内 ≤3 次）
    let guard = Arc::new(CrashGuard::new());
    let crash_guard = guard.clone();
    // with_webview 回调在主线程执行，此时 GTK webview 已就绪可连信号
    if let Err(e) = win.with_webview(move |platform| {
        let webview = platform.inner();
        let crashes = Arc::new(AtomicUsize::new(0));
        webview.connect_web_process_crashed(move |wv| {
            let n = crashes.fetch_add(1, Ordering::Relaxed) + 1;
            // 防回归点 2：取证落日志（tauri-plugin-log → ainone-ui.log）
            log::warn!("[webview] WebKitWebProcess 崩溃（第 {n} 次）——对照 OOM/信号取证");
            // 防回归点 1：自动重载自愈白屏；连续重载则只报不重载
            if crash_guard.register_crash(Instant::now()) {
                log::info!("[webview] 崩溃自愈：触发 reload()");
                wv.reload();
            } else {
                log::error!("[webview] {CRASH_WINDOW:?} 内连续重载达上限，停止自动重载（请手动重启应用）");
            }
            // true = 已处理（WebKit 继续默认收尾：清空 web 进程）
            true
        });
        log::info!("[webview] web-process-crashed 自愈已挂接");
    }) {
        log::warn!("[webview] with_webview 挂接失败（自愈降级为无）: {e}");
    }
    spawn_watchdog(app, guard);
}

/// P40：启动卡死看门狗线程（崩溃信号覆盖不到的场景，见模块头注释）。
#[cfg(target_os = "linux")]
fn spawn_watchdog(app: &tauri::AppHandle, guard: Arc<CrashGuard>) {
    use tauri::Manager;
    let wd = WATCHDOG.get_or_init(Watchdog::default);
    // 心跳基准：挂载即视为「刚活过」，避免前端首帧上报前误判超期
    wd.beat(false);
    // WebKit 响应性探针结果（with_webview 投递到主线程写、看门狗线程读）
    let responsive = Arc::new(AtomicBool::new(true));
    let app = app.clone();
    std::thread::Builder::new()
        .name("webview-watchdog".into())
        .spawn(move || {
            let mut strikes = 0u32;
            loop {
                std::thread::sleep(WATCHDOG_INTERVAL);
                let now = Instant::now();
                let Some(win) = app.get_webview_window("main") else {
                    continue;
                };
                // 窗口最小化/隐藏时不判：渲染已暂停、心跳可能被节流，属正常态
                if win.is_minimized().unwrap_or(false) || !win.is_visible().unwrap_or(true) {
                    strikes = 0;
                    continue;
                }
                // 内存留痕（不触发动作）：超阈每轮记一次，供事后对照事故曲线
                if let Some(rss) = web_process_rss() {
                    if rss > MEMORY_LIMIT_BYTES {
                        log::warn!(
                            "[webview] web 进程 RSS {} MB（超留痕阈值，不单独触发自愈）",
                            rss / 1024 / 1024
                        );
                    }
                }
                // 判据 a：心跳超期（纯计算，不阻塞）
                let mut reason: Option<&'static str> = None;
                if wd.heartbeat_expired(now) {
                    reason = Some("心跳超时");
                } else {
                    // 判据 b：问 WebKit「web 进程是否响应」。GTK 调用须在主线程，
                    // with_webview 即投递到主线程；主线程若也被占死这里会阻塞，
                    // 此时上面已由心跳判据覆盖（故心跳判在前）。
                    let flag = responsive.clone();
                    if win
                        .with_webview(move |platform| {
                            flag.store(
                                webkit2gtk::WebViewExt::is_web_process_responsive(&platform.inner()),
                                Ordering::Relaxed,
                            );
                        })
                        .is_ok()
                        && !responsive.load(Ordering::Relaxed)
                    {
                        reason = Some("WebKit 判不响应");
                    }
                }
                let Some(reason) = reason else {
                    strikes = 0;
                    continue;
                };
                strikes += 1;
                log::warn!(
                    "[webview] 看门狗命中（{reason}）连续 {strikes}/{TRIGGER_STRIKES}"
                );
                if strikes < TRIGGER_STRIKES {
                    continue;
                }
                if !guard.register_crash(Instant::now()) {
                    log::error!(
                        "[webview] 看门狗判定卡死，但 {CRASH_WINDOW:?} 内重载已达上限——停止自愈（请手动重启应用）"
                    );
                    break;
                }
                log::warn!("[webview] 判定卡死（{reason}），触发 reload() 自愈");
                if let Err(e) = win.reload() {
                    log::error!("[webview] 看门狗 reload 失败: {e}");
                }
                // 重载后重置基准，给新页面留出启动时间
                wd.beat(false);
                strikes = 0;
            }
        })
        .ok();
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn crash_guard_allows_first_two() {
        // 连续重载保护：窗口内前 2 次允许重载
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

    // —— P40 卡死看门狗 ——

    #[test]
    fn watchdog_flags_stale_heartbeat_when_idle() {
        // 空闲态心跳超期 → 判死（覆盖「页面活着但 JS 主线程被占死」）
        let wd = Watchdog::default();
        wd.beat(false);
        let now = Instant::now();
        assert!(!wd.heartbeat_expired(now));
        assert!(wd.heartbeat_expired(now + HEARTBEAT_TIMEOUT + Duration::from_secs(1)));
    }

    #[test]
    fn watchdog_ignores_stale_heartbeat_while_busy() {
        // 忙碌态（长 turn）心跳本就稀疏 → 不得因心跳判死
        let wd = Watchdog::default();
        wd.beat(true);
        assert!(!wd.heartbeat_expired(Instant::now() + HEARTBEAT_TIMEOUT * 10));
    }

    #[test]
    fn watchdog_no_judgement_before_first_beat() {
        // 前端尚未上报（冷启动窗口）→ 不判，避免误杀
        let wd = Watchdog::default();
        assert!(!wd.heartbeat_expired(Instant::now() + HEARTBEAT_TIMEOUT * 10));
    }

    #[test]
    fn heartbeat_refreshes_timer_and_clears_busy() {
        // 新心跳刷新基准：超期判定随之解除（转 idle 后重新计时）
        let wd = Watchdog::default();
        wd.beat(true);
        assert!(!wd.heartbeat_expired(Instant::now() + HEARTBEAT_TIMEOUT * 10));
        wd.beat(false);
        assert!(wd.heartbeat_expired(Instant::now() + HEARTBEAT_TIMEOUT + Duration::from_secs(1)));
    }
}
