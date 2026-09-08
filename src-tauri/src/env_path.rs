// 增强 PATH：桌面应用不经 login shell，进程 PATH 常缺用户工具目录
// （leju 实测：~/.bun/bin、~/.local/bin、nvm 目录全部缺失，omp/claude 检测不到）。
//
// 本模块是「增强 PATH」的唯一事实源，两处消费：
//   1. adapter_available / adapter_status —— 程序检测（adapters.rs）
//   2. spawn_inner —— 子进程 env PATH 注入（agent.rs）
//
// 策略（借鉴 DeepChat detectionEnv / AionUi fixPath）：
//   - 用户目录 + nvm/版本管理器展开 + 平台默认目录，存在才收，增强目录在前
//   - login shell PATH 后台抓取一次并缓存（8s 超时、负缓存），命中才并入
//   - 非 unix 平台退化为仅进程 PATH（当前不支持 Windows，见 plan 不做清单）

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

/// login shell PATH 缓存：Some(有效 PATH) / None（抓取失败或未就绪，负缓存）
static LOGIN_SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

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

/// 后台抓取 login shell 的 PATH（启动时调用一次，永不阻塞）。
/// `$SHELL -l -i -c 'printf %s "$PATH"'`，8s 超时 kill；输出须含 ':' 且无换行才接受。
pub fn fetch_login_shell_path_async() {
    std::thread::spawn(|| {
        let result = fetch_login_shell_path();
        let _ = LOGIN_SHELL_PATH.set(result);
    });
}

/// 读缓存：未就绪/抓取失败返回 None（调用方跳过，不触发抓取）
pub fn login_shell_path_cached() -> Option<&'static str> {
    LOGIN_SHELL_PATH.get().and_then(|o| o.as_deref())
}

fn fetch_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut child = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", "printf %s \"$PATH\""])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
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
    // 合法性：PATH 必含分隔符且不含换行（交互 shell 可能吐转义序列等垃圾）
    let trimmed = output.trim();
    if trimmed.contains(':') && !trimmed.contains('\n') && !trimmed.contains('\r') {
        Some(trimmed.to_string())
    } else {
        log::warn!("[env_path] login shell PATH 输出非法，忽略: {:?}", trimmed.chars().take(80).collect::<String>());
        None
    }
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
}
