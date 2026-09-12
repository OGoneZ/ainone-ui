// 登录 shell 环境：桌面应用不经 login shell，进程环境常缺用户工具目录与 rc 变量
// （leju 实测：~/.bun/bin、~/.local/bin、nvm 目录全部缺失，omp/claude 检测不到；
//  打包版更严重——launchd 拉起的进程只有 12 个变量，~/.zshrc 的 export 一个没有）。
//
// 本模块是「登录 shell 环境」的唯一事实源，消费点：
//   1. adapter_available / adapter_status —— 程序检测（adapters.rs）
//   2. terminal_spawn —— PTY 终端 env 注入（terminal.rs）
//   3. spawn_inner / spawn_bridge —— harness 子进程 env 注入（agent.rs）
//
// 策略（借鉴 DeepChat detectionEnv / AionUi fixPath / Tauri fix-path-env-rs）：
//   - 用户目录 + nvm/版本管理器展开 + 平台默认目录，存在才收，增强目录在前
//   - login shell 全量环境后台抓取一次并缓存（8s 超时、负缓存），命中才注入
//   - 非 unix 平台退化为仅进程环境（当前不支持 Windows，见 plan 不做清单）

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 程序命中的来源（UI 展示「找到于 …」用）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum PathSource {
    /// 用户目录（~/.local/bin、~/.bun/bin 等）
    Home,
    /// nvm 管理的 node 版本目录
    Nvm,
    /// 其他版本管理器（volta/fnm/asdf）
    VersionManager,
    /// 平台默认目录（/opt/homebrew/bin 等）
    PlatformDefault,
    /// login shell 抓取的 PATH（缓存命中后并入 enhanced_dirs，按位置归入对应来源）
    #[allow(dead_code)]
    LoginShell,
    /// 应用进程继承的 PATH
    ProcessPath,
}

/// find_program 的命中结果
#[derive(Debug, Clone)]
pub struct ProgramHit {
    pub path: PathBuf,
    pub source: PathSource,
}

/// 抓取用的哨兵（前后各一，取中段可屏蔽 rc 文件往 stdout 打的字）
const ENV_SENTINEL: &str = "___AINONE_ENV_SEP___";

/// 不属于用户配置、注入子进程会误导的会话态变量
const ENV_SKIP: [&str; 4] = ["PWD", "OLDPWD", "SHLVL", "_"];

/// 登录 shell 环境缓存：Some(有效变量表) / None（抓取失败或未就绪，负缓存）
static LOGIN_SHELL_ENV: OnceLock<Option<HashMap<String, String>>> = OnceLock::new();

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// 目录存在才收进列表
fn push_if_dir(out: &mut Vec<PathBuf>, p: PathBuf) {
    if p.is_dir() {
        out.push(p);
    }
}

/// 展开 nvm 的各 node 版本 bin 目录，按目录名（版本号）倒序取最新，cap 32
fn nvm_bins(out: &mut Vec<PathBuf>) {
    let root = std::env::var("NVM_DIR")
        .map(PathBuf::from)
        .ok()
        .filter(|p| p.is_dir())
        .or_else(|| home().map(|h| h.join(".nvm")).filter(|p| p.is_dir()));
    let Some(root) = root else { return };
    let versions = root.join("versions").join("node");
    let Ok(entries) = std::fs::read_dir(&versions) else { return };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort_by(|a, b| b.cmp(a)); // 倒序：v24 排在 v20 前
    for name in names.into_iter().take(32) {
        push_if_dir(out, versions.join(&name).join("bin"));
    }
}

/// 构造增强目录列表：增强目录在前、进程 PATH 在后（prepend 语义，
/// 解决 /usr/local/bin 旧版工具遮蔽 ~/.bun/bin 新版的问题）
pub fn enhanced_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let push = |out: &mut Vec<PathBuf>, p: PathBuf| {
        if !out.contains(&p) {
            push_if_dir(out, p);
        }
    };

    if let Some(h) = home() {
        for rel in ["bin", ".local/bin", ".bun/bin", ".cargo/bin", ".opencode/bin"] {
            push(&mut out, h.join(rel));
        }
        // nvm versions/*/bin
        let before = out.len();
        nvm_bins(&mut out);
        if out.len() > before {
            // nvm 命中后去重（nvm_bins 内部不去重）
            dedup_tail(&mut out, before);
        }
        // 其他版本管理器
        push(&mut out, h.join(".volta/bin"));
        push(&mut out, h.join(".local/share/fnm/aliases/default/bin"));
        push(&mut out, h.join(".asdf/shims"));
    }

    // 平台默认目录
    for p in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
    ] {
        push(&mut out, PathBuf::from(p));
    }

    // login shell 抓取结果（缓存命中才展开，绝不阻塞）
    if let Some(path) = login_shell_path_cached() {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            push(&mut out, PathBuf::from(dir));
        }
    }

    // 进程 PATH 放最后
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if dir.is_empty() {
                continue;
            }
            push(&mut out, PathBuf::from(dir));
        }
    }
    out
}

/// 从 from 下标起按首现顺序去重（nvm_bins 已 push 过的目录避免与后续重复）
fn dedup_tail(out: &mut Vec<PathBuf>, from: usize) {
    let mut seen: Vec<PathBuf> = out[..from].to_vec();
    let head = out[..from].to_vec();
    let tail: Vec<PathBuf> = out[from..]
        .iter()
        .filter(|p| {
            if seen.contains(p) {
                false
            } else {
                seen.push((*p).clone());
                true
            }
        })
        .cloned()
        .collect();
    out.clear();
    out.extend(head);
    out.extend(tail);
}

/// 增强目录列表串成 PATH 字符串（P2 spawn env 注入用）
#[allow(dead_code)]
pub fn enhanced_path() -> String {
    enhanced_dirs()
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(":")
}

/// 注入子进程的登录 shell 环境（terminal / harness spawn 共用）。
///
/// 过滤掉会污染子进程的键，再由调用方按优先级叠加自己的 env：
///   - PATH：增强 PATH 已并入 login shell PATH，且带 nvm 展开与平台默认目录，更全
///   - TERM / COLORTERM：终端能力由**终端模拟器**声明，不是 shell 环境的职责。
///     实测无 TERM 时登录取到的就是缺失（zsh 不自设 TERM）；但用户 rc 里若有
///     `export TERM=dumb` 一类硬编码，注入过去会直接废掉着色——一律不带，
///     由 terminal_capability_env 统一补。
pub fn login_shell_env_for_child() -> HashMap<String, String> {
    let mut out: HashMap<String, String> = login_shell_env_cached()
        .map(|env| {
            env.iter()
                .filter(|(k, _)| !matches!(k.as_str(), "PATH" | "TERM" | "COLORTERM"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    for (k, v) in terminal_capability_env() {
        out.insert(k, v);
    }
    out
}

/// 终端能力兜底：应用自身无 TERM 时声明 xterm-256color。
///
/// 打包版由 launchd 拉起，环境里没有 TERM；此时 zsh 查不到 terminfo，表现为
/// 不出彩色 + Backspace 退化成吐空格（实测：无 TERM 回显 `b' '`，有则 `b'\x08 \x08'`）。
/// 从终端跑 dev 时已继承真实 TERM，返回空——由用户的终端说了算，不覆盖。
/// 声明 xterm-256color 是准确的：渲染端就是 xterm.js 6，支持真彩色。
pub fn terminal_capability_env() -> Vec<(String, String)> {
    if std::env::var_os("TERM").is_some() {
        return Vec::new();
    }
    vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ]
}

/// 检查文件是否可执行（0o111 任一位置位）
fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// 在增强 PATH 上查找程序，返回绝对路径与命中来源。
/// 绝对/相对路径直接返回（用户在设置里填了明确路径）。
pub fn find_program(program: &str) -> Option<ProgramHit> {
    if program.contains('/') {
        let p = PathBuf::from(program);
        return is_executable(&p).then(|| ProgramHit { path: p, source: PathSource::ProcessPath });
    }
    // 相同文件名可在多个来源命中，按 enhanced_dirs 顺序取第一个（即增强优先级）
    for (idx, dir) in enhanced_dirs().iter().enumerate() {
        let candidate = dir.join(program);
        if is_executable(&candidate) {
            let source = source_at(idx, dir);
            return Some(ProgramHit { path: candidate, source });
        }
    }
    None
}

/// 按 enhanced_dirs 的下标区间粗分来源（展示用，够用即可）
fn source_at(idx: usize, dir: &Path) -> PathSource {
    let s = dir.to_string_lossy();
    if s.contains("/.nvm/") {
        PathSource::Nvm
    } else if s.contains("/.volta/") || s.contains("/fnm/") || s.contains("/.asdf/") {
        PathSource::VersionManager
    } else if idx == 0 && (s.starts_with("/opt/homebrew") || s.starts_with("/usr/local")) {
        PathSource::PlatformDefault
    } else {
        // 用户目录段在头部，login shell / 进程 PATH 段在尾部；粗略按位置判断
        if idx < 12 {
            PathSource::Home
        } else {
            PathSource::ProcessPath
        }
    }
}

/// 后台抓取 login shell 全量环境（启动时调用一次，永不阻塞）。
/// `$SHELL -l -i -c '<哨兵包裹的 env>'`，8s 超时 kill；见 fetch_login_shell_env。
pub fn fetch_login_shell_env_async() {
    std::thread::spawn(|| {
        let result = fetch_login_shell_env();
        let _ = LOGIN_SHELL_ENV.set(result);
    });
}

/// 读缓存：未就绪/抓取失败返回 None（调用方跳过，不触发抓取）
pub fn login_shell_env_cached() -> Option<&'static HashMap<String, String>> {
    LOGIN_SHELL_ENV.get().and_then(|o| o.as_ref())
}

/// 读缓存里的 PATH（未就绪/抓取失败/无 PATH 返回 None）
pub fn login_shell_path_cached() -> Option<&'static str> {
    login_shell_env_cached()?.get("PATH").map(String::as_str)
}

/// 抓取登录 shell 的全量环境变量。
///
/// 为什么抓全量而不是只抓 PATH：打包版（launchd 拉起的 .app）只继承 12 个变量，
/// `~/.zshrc` 的 export 一个都拿不到——终端里 Claude Code 不出彩色（无 TERM）、
/// Backspace 变空格（zsh ZLE 查不到 terminfo 退化成吐空格）、Skill 读不到
/// OPENAI_API_KEY 等，全是这一个根因。
///
/// 命令构造（三点都有实测依据）：
///   - `-l -i`：login 读 zprofile/profile，interactive 读 zshrc/bashrc
///   - 哨兵包裹：rc 里常有 echo，中段取值屏蔽污染
///   - 显式 source .bashrc：bash 只在**非**登录的交互 shell 读 bashrc，登录时读的是
///     .bash_profile（且它未必 source bashrc，实测此场景 bashrc 变量全丢）；
///     `[ -n "$BASH_VERSION" ]` 保证 zsh/sh 下短路，零影响
fn fetch_login_shell_env() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let script = format!(
        r#"[ -n "$BASH_VERSION" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc" >/dev/null 2>&1; echo -n "{s}"; env; echo -n "{s}""#,
        s = ENV_SENTINEL
    );
    let (tx, rx) = std::sync::mpsc::channel();
    let mut child = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        // 与 Tauri fix-path-env-rs 同样的保险：禁掉 Oh My Zsh 自动更新一类会卡住的东西
        .env("DISABLE_AUTO_UPDATE", "true")
        .spawn()
        .ok()?;
    let pid = child.id();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        if let Some(mut out) = child.stdout.take() {
            let _ = out.read_to_string(&mut buf);
        }
        let _ = child.wait();
        let _ = tx.send(buf);
    });
    let output = rx
        .recv_timeout(std::time::Duration::from_secs(8))
        .or_else(|_| {
            // 超时：杀掉子进程（不含孙进程，够用；zshrc 卡死场景已兜住）
            let _ = std::process::Command::new("kill")
                .arg(pid.to_string())
                .output();
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        })
        .ok()?;
    match parse_shell_env(&output) {
        Some(env) => Some(env),
        None => {
            log::warn!(
                "[env_path] login shell env 输出非法，忽略: {:?}",
                output.chars().take(80).collect::<String>()
            );
            None
        }
    }
}

/// 从哨兵包裹的 `env` 输出里解析变量表。
/// 哨兵缺失或段内无合法条目 → None（调用方记负缓存，不再重试）。
fn parse_shell_env(raw: &str) -> Option<HashMap<String, String>> {
    // 交互 shell 可能吐 ANSI 转义（提示符），先剥掉再找哨兵
    let cleaned = strip_ansi(raw);
    let mut parts = cleaned.split(ENV_SENTINEL);
    parts.next()?; // 前哨兵之前的引导内容（rc 的 echo 等）丢弃
    let body = parts.next()?;

    let env: HashMap<String, String> = body
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches(['\r', '\n']);
            let (key, value) = line.split_once('=')?;
            // 合法键名 + 非会话态变量
            let mut chars = key.chars();
            let head_ok = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
            let tail_ok = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !head_ok || !tail_ok || ENV_SKIP.contains(&key) {
                return None;
            }
            Some((key.to_string(), value.to_string()))
        })
        .collect();

    // 至少要有 PATH 才算抓成功（空的 env 输出说明 shell 根本没起来）
    if env.contains_key("PATH") {
        Some(env)
    } else {
        None
    }
}

/// 剥掉 ANSI 转义序列（CSI 与两字符 ESC 序列）。只服务本模块的解析，不做通用实现。
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI: ESC [ ... 终结于 0x40-0x7E
            Some('[') => {
                for n in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&n) {
                        break;
                    }
                }
            }
            // 其余两字符序列（如 ESC ( B）：吞掉紧随的一个字符
            Some(_) => {}
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_executable_and_find_by_path() {
        // /bin/sh 在 mac/linux 都存在且可执行
        let hit = find_program("/bin/sh").expect("/bin/sh 应可执行");
        assert_eq!(hit.path, PathBuf::from("/bin/sh"));
        // 目录不可执行
        assert!(find_program("/tmp").is_none() || Path::new("/tmp").is_file());
        assert!(find_program("/nonexistent/no-such-bin").is_none());
    }

    #[test]
    fn test_enhanced_dirs_includes_platform_defaults() {
        let dirs = enhanced_dirs();
        // 至少包含一个平台默认目录（mac: /opt/homebrew/bin 或 /usr/local/bin；linux CI: /usr/local/bin）
        assert!(
            dirs.iter().any(|d| d.ends_with("/usr/local/bin") || d.ends_with("/opt/homebrew/bin")),
            "dirs = {dirs:?}"
        );
    }

    #[test]
    fn test_enhanced_dirs_starts_with_home_dirs() {
        if home().is_none() {
            return; // CI 无 HOME 时跳过
        }
        let dirs = enhanced_dirs();
        assert!(dirs.iter().any(|d| d.ends_with(".local/bin") || d.ends_with(".bun/bin")));
    }

    #[test]
    fn test_enhanced_path_joins_with_colon() {
        let path = enhanced_path();
        assert!(!path.is_empty());
        assert!(path.contains(':'));
        assert!(!path.contains('\n'));
    }

    #[test]
    fn test_dedup_tail() {
        let mut v = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        v.push(PathBuf::from("/a"));
        v.push(PathBuf::from("/c"));
        dedup_tail(&mut v, 2);
        assert_eq!(v, vec![PathBuf::from("/a"), PathBuf::from("/b"), PathBuf::from("/c")]);
    }

    /// 造一段带哨兵的 shell 输出（模拟 `echo -n SEP; env; echo -n SEP`）
    fn wrapped(body: &str) -> String {
        format!("{ENV_SENTINEL}{body}{ENV_SENTINEL}")
    }

    #[test]
    fn test_parse_shell_env_normal() {
        let raw = wrapped("PATH=/usr/bin:/bin\nHOME=/Users/x\nOPENAI_API_KEY=sk-1\n");
        let env = parse_shell_env(&raw).expect("应解析成功");
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin:/bin"));
        assert_eq!(env.get("OPENAI_API_KEY").map(String::as_str), Some("sk-1"));
    }

    #[test]
    fn test_parse_shell_env_value_may_contain_equals() {
        // 值里含 '=' 不能被截断（split_once 语义）
        let raw = wrapped("PATH=/usr/bin\nBASE=https://x/v1?a=b\n");
        let env = parse_shell_env(&raw).expect("应解析成功");
        assert_eq!(env.get("BASE").map(String::as_str), Some("https://x/v1?a=b"));
    }

    #[test]
    fn test_parse_shell_env_filters_rc_noise() {
        // 哨兵之外是 rc 的输出（欢迎语、提示符），段内混入非 KEY=VALUE 行也要滤掉
        let raw = format!(
            "Welcome to zsh!\n[1m%~[0m{ENV_SENTINEL}PATH=/usr/bin\nnot-a-var\n\nalso bad =value\nZ=1\n{ENV_SENTINEL}bye\n"
        );
        let env = parse_shell_env(&raw).expect("应解析成功");
        assert_eq!(env.len(), 2, "只应留下 PATH 与 Z: {env:?}");
        assert!(env.contains_key("PATH") && env.contains_key("Z"));
    }

    #[test]
    fn test_parse_shell_env_strips_ansi() {
        // 交互 shell 的提示符转义不能干扰解析
        let raw = format!("\u{1b}[1m\u{1b}[7m%\u{1b}[27m{ENV_SENTINEL}PATH=/usr/bin\u{1b}[0m\nFOO=bar\n{ENV_SENTINEL}");
        let env = parse_shell_env(&raw).expect("应解析成功");
        assert_eq!(env.get("FOO").map(String::as_str), Some("bar"));
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
    }

    #[test]
    fn test_parse_shell_env_skips_session_vars() {
        // 会话态变量注入子进程会误导（PWD 指向应用启动目录等）
        let raw = wrapped("PATH=/usr/bin\nPWD=/somewhere\nOLDPWD=/old\nSHLVL=3\n_=/usr/bin/env\n");
        let env = parse_shell_env(&raw).expect("应解析成功");
        assert_eq!(env.len(), 1, "只应留下 PATH: {env:?}");
        for k in ENV_SKIP {
            assert!(!env.contains_key(k), "{k} 应被剔除");
        }
    }

    #[test]
    fn test_parse_shell_env_rejects_bad_output() {
        // 缺哨兵（shell 没起来 / 被 rc 卡死）→ None，调用方记负缓存
        assert!(parse_shell_env("PATH=/usr/bin\n").is_none());
        // 有哨兵但段内为空 → None
        assert!(parse_shell_env(&wrapped("")).is_none());
        // 有变量但没有 PATH → 视为无效（PATH 是抓取成功的最低标志）
        assert!(parse_shell_env(&wrapped("FOO=1\n")).is_none());
    }

    #[test]
    fn test_login_shell_env_for_child_excludes_terminal_caps() {
        // TERM/COLORTERM 由 terminal_capability_env 统一决定，不随 rc 透传
        // （用户 rc 里的 `export TERM=dumb` 会直接废掉子进程着色）
        let child = login_shell_env_for_child();
        assert!(!child.contains_key("PATH"), "PATH 由调用方的 enhanced_path 负责");
        assert!(!child.contains_key("TERM"));
        assert!(!child.contains_key("COLORTERM"));
        for k in ENV_SKIP {
            assert!(!child.contains_key(k), "{k} 应被剔除");
        }
    }

    #[test]
    fn test_terminal_capability_env_follows_process_term() {
        let caps = terminal_capability_env();
        if std::env::var_os("TERM").is_some() {
            // 进程已有 TERM（如从终端启动）→ 不覆盖，交还给真实终端
            assert!(caps.is_empty(), "进程有 TERM 时不应注入兜底");
        } else {
            let map: HashMap<_, _> = caps.into_iter().collect();
            assert_eq!(map.get("TERM").map(String::as_str), Some("xterm-256color"));
            assert_eq!(map.get("COLORTERM").map(String::as_str), Some("truecolor"));
        }
    }

    /// 端到端抓取冒烟：真起一次登录 shell，验证整条管线（命令构造 → 解析 → 过滤）。
    /// 用 `cargo test -- --ignored` 手动跑（会起交互 shell，不进 CI 默认集）。
    #[test]
    #[ignore = "起交互式登录 shell，耗时且依赖本机配置"]
    fn smoke_real_fetch() {
        let env = fetch_login_shell_env().expect("登录 shell 抓取应成功");
        println!("抓到 {} 个变量", env.len());
        for k in ["PATH", "OPENAI_API_KEY", "OPENAI_API_BASE", "BUN_INSTALL", "LANG"] {
            let shown = env.get(k).map(|s| s.chars().take(50).collect::<String>());
            println!("  {k} = {shown:?}");
        }
        assert!(env.contains_key("PATH"), "PATH 必须抓到");
        assert!(env.len() > 5, "只抓到 {} 个变量，明显偏少", env.len());
        for k in ENV_SKIP {
            assert!(!env.contains_key(k), "{k} 应被剔除");
        }
    }
}
