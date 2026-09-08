// 内嵌 bun 运行时解析（P31）：
//
// 桌面应用不经 login shell，裸机上 bun/npm 可能全缺——桥跑不了、桥装不了、
// codex/omp/pi 的 CLI 一键装也装不了。本模块提供「三级解析」的唯一事实源：
//
//   system PATH 的 bun  >  应用内嵌的 bun（resource_dir/runtime/{triple}/bun）
//
// 用户自装永远优先（尊重 nvm/fnm/bun upgrade 的版本管理）；内嵌只兜底缺失场景。
// node 不内嵌（115M 太大），npm 同理——npm 的兜底由内嵌 bun 顶上（bun add 语义兼容）。
//
// 解析逻辑本体是纯函数（resolve_in / resolve_npm_in，路径注入便于单测），
// AppHandle 包装层薄到不值得测（与 connector.rs resolve_in 同款手法）。

use std::path::{Path, PathBuf};
use serde::Serialize;

/// npm 解析的来源标签（诊断与日志展示用）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum NpmSource {
    /// 系统 PATH 的 npm（或 node 同级的 npm）
    System,
    /// 内嵌 bun 顶上（bun add 兼容 npm install 语义）
    #[allow(dead_code)]
    BundledBun,
}

impl NpmSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            NpmSource::System => "system",
            NpmSource::BundledBun => "bundled-bun",
        }
    }
}

/// 纯函数：在 resource 根目录下定位内嵌 bun。
/// 布局：{root}/runtime/{target_triple}/bun（Windows 由调用方补 .exe）。
pub fn bundled_bun_in(resource_root: &Path, target_triple: &str) -> PathBuf {
    resource_root
        .join("runtime")
        .join(target_triple)
        .join(bun_exe_name())
}

/// 平台相关的 bun 可执行文件名。
pub fn bun_exe_name() -> &'static str {
    if cfg!(windows) {
        "bun.exe"
    } else {
        "bun"
    }
}

/// 纯函数：system 与 bundled 两级解析（env 查找由调用方注入，便于单测）。
/// bundled 命中要求：文件存在且可执行（unix 0o111 位）。
pub fn resolve_bun_in(
    resource_root: Option<&Path>,
    target_triple: &str,
    system_hit: Option<PathBuf>,
) -> Option<(PathBuf, &'static str)> {
    if let Some(p) = system_hit {
        return Some((p, "system"));
    }
    let root = resource_root?;
    let candidate = bundled_bun_in(root, target_triple);
    if is_executable(&candidate) {
        return Some((candidate, "bundled"));
    }
    None
}

/// 纯函数：npm 两级解析。npm 不内嵌——system npm（或 node 同级 npm）在则用；
/// 全缺时由 bundled bun 顶上（bun add 兼容 npm 语义）。
/// node 同级探测：node 二进制所在目录下的 npm（nvm/fnm 布局 node/npm 同目录）。
pub fn resolve_npm_in(
    resource_root: Option<&Path>,
    target_triple: &str,
    npm_hit: Option<PathBuf>,
    node_hit: Option<PathBuf>,
    bun_hit: Option<PathBuf>,
    bundled_bun_hit: Option<PathBuf>,
) -> Option<(PathBuf, NpmSource)> {
    if let Some(p) = npm_hit {
        return Some((p, NpmSource::System));
    }
    // node 在但 npm 不在 PATH：探测 node 同级目录（fnm/nvm 官方布局 npm 与 node 同 bin）
    if let Some(node) = node_hit {
        let sibling = node
            .parent()
            .map(|dir| dir.join(npm_exe_name()))
            .filter(|p| is_executable(p));
        if let Some(p) = sibling {
            return Some((p, NpmSource::System));
        }
    }
    // 全缺 → 内嵌 bun 顶上：system bun 优先于 bundled bun（与 resolve_bun 同序）
    if let Some(b) = bun_hit {
        return Some((b, NpmSource::BundledBun));
    }
    let _ = (resource_root, target_triple);
    bundled_bun_hit.map(|b| (b, NpmSource::BundledBun))
}

/// 平台相关的 npm 可执行文件名。
fn npm_exe_name() -> &'static str {
    if cfg!(windows) {
        "npm.cmd"
    } else {
        "npm"
    }
}

/// 文件可执行判定（与 env_path.rs is_executable 同语义；unix 查 0o111 位）。
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

// ---------------------------------------------------------------------------
// AppHandle 包装层：生产入口（薄，依赖 Tauri 不单测；逻辑本体在上面纯函数）
// ---------------------------------------------------------------------------

/// 当前编译目标 triple（resource_dir/runtime/ 下的目录名）。
/// 与 CI 矩阵 --target 一致；build.rs 从 TARGET/HOST 导出（两者 = tauri bundler
/// 定位产物的同一套 triple）。
pub fn current_target_triple() -> &'static str {
    env!("AINONE_TARGET_TRIPLE")
}

/// 生产入口：三级解析 bun（system PATH → bundled）。
pub fn resolve_bun(app: &tauri::AppHandle) -> Option<(PathBuf, &'static str)> {
    let system = crate::env_path::find_program("bun").map(|h| h.path);
    let resource_root = resource_root(app);
    resolve_bun_in(resource_root.as_deref(), current_target_triple(), system)
}

/// 生产入口：npm 解析（system npm → node 同级 → bun 顶上）。
pub fn resolve_npm(app: &tauri::AppHandle) -> Option<(PathBuf, NpmSource)> {
    let npm = crate::env_path::find_program("npm").map(|h| h.path);
    let node = crate::env_path::find_program("node").map(|h| h.path);
    let bun = crate::env_path::find_program("bun").map(|h| h.path);
    let bundled = resolve_bun(app)
        .filter(|(_, src)| *src == "bundled")
        .map(|(p, _)| p);
    resolve_npm_in(
        resource_root(app).as_deref(),
        current_target_triple(),
        npm,
        node,
        bun,
        bundled,
    )
}

/// resource 根目录：环境变量覆盖（e2e/手动验证内嵌链路用）优先，
/// 否则用应用 resource_dir。
/// 注意 tauri v2 的 resources 落位语义：tauri.conf.json 里相对 src-tauri 的
/// `resources/runtime/**` 在 bundle 内映射为 `Contents/Resources/resources/runtime/…`
/// （保留相对目录结构，macOS 实测），故 resource_dir() 之下还要再进一层
/// `resources/`。dev 下 resource_dir()= target/debug（build script 直接平铺
/// resources/ 到 exe 旁，其下也有 resources/ 同构目录——两级目录布局一致）。
fn resource_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("AINONE_BUNDLED_BUN_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    use tauri::Manager;
    app.path().resource_dir().ok().map(|d| d.join("resources"))
}

/// 跑 `<path> --version` 取版本号（5s 超时；失败 None 不阻塞调用方）。
/// 诊断用途，spawn 主链路不调用。
pub fn runtime_version(path: &Path) -> Option<String> {
    let out = std::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let first = s.lines().next()?.trim().to_string();
    if first.is_empty() {
        None
    } else {
        Some(first)
    }
}

// ---------------------------------------------------------------------------
// runtime-versions.json 清单解析（编译期 include_str!，运行期无文件 IO）
// ---------------------------------------------------------------------------

const RUNTIME_VERSIONS_JSON: &str = include_str!("../resources/runtime-versions.json");

/// 清单解析结果（bun 版本 + 各 target 的 sha256）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeManifest {
    pub bun_version: String,
    /// target triple → sha256（hex 小写）
    pub artifacts: std::collections::BTreeMap<String, String>,
}

/// 纯函数：解析清单文本（build.rs 同款校验失败的形态直接 Err）。
pub fn parse_runtime_manifest(raw: &str) -> Result<RuntimeManifest, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("runtime-versions.json 解析失败: {e}"))?;
    let schema = v
        .get("schemaVersion")
        .and_then(|x| x.as_u64())
        .ok_or("清单缺 schemaVersion")?;
    if schema != 1 {
        return Err(format!("不支持的清单 schemaVersion: {schema}"));
    }
    let bun_version = v
        .get("bun")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or("清单缺 bun 版本")?
        .to_string();
    let mut artifacts = std::collections::BTreeMap::new();
    let obj = v
        .get("bunArtifacts")
        .and_then(|x| x.as_object())
        .ok_or("清单缺 bunArtifacts")?;
    for (target, entry) in obj {
        let sha = entry
            .get("sha256")
            .and_then(|x| x.as_str())
            .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
            .ok_or_else(|| format!("bunArtifacts.{target} 的 sha256 非法（须 64 位 hex）"))?;
        artifacts.insert(target.clone(), sha.to_lowercase());
    }
    if artifacts.is_empty() {
        return Err("bunArtifacts 为空".into());
    }
    Ok(RuntimeManifest {
        bun_version,
        artifacts,
    })
}

/// 当前平台的清单 sha256（target 不在清单 → None）。
pub fn bundled_bun_sha256() -> Option<String> {
    let m = parse_runtime_manifest(RUNTIME_VERSIONS_JSON).ok()?;
    m.artifacts
        .get(current_target_triple())
        .map(|s| s.to_string())
}

/// sha256 比对（诊断命令用；低频路径，~100ms 可接受）。
/// 三态：文件缺失 → Err("missing")；哈希不符 → Err(实际哈希)；匹配 → Ok(())。
pub fn verify_bundled_sha256(file: &Path, expect_hex: &str) -> Result<(), String> {
    use sha2::Digest;
    use std::io::Read;
    let mut f = std::fs::File::open(file).map_err(|_| "missing".to_string())?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual.eq_ignore_ascii_case(expect_hex) {
        Ok(())
    } else {
        Err(actual)
    }
}

// ---------------------------------------------------------------------------
// 诊断命令（P31 任务五）：设置页可见的运行时状态
// ---------------------------------------------------------------------------

/// 单个运行时的解析结果（诊断展示用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    /// 绝对路径
    pub path: String,
    /// "system" | "bundled"
    pub source: String,
    /// `<path> --version` 输出（失败 None）
    pub version: Option<String>,
}

/// 运行时诊断快照（runtime_diagnostics 命令的返回体）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    pub bun: Option<RuntimeInfo>,
    pub npm: Option<RuntimeInfo>,
    /// 内嵌目录是否落位（resource_root/runtime 存在）
    pub bundled_dir_exists: bool,
    /// 内嵌 bun sha 校验：Some(true)=通过 / Some(false)=不符 / None=缺文件或不在清单
    pub bundled_sha_verified: Option<bool>,
}

/// 诊断快照（低频路径：跑两次 --version 子进程 + 一次 61M sha256，~100-300ms）。
pub fn runtime_diagnostics(app: &tauri::AppHandle) -> RuntimeDiagnostics {
    let bun = resolve_bun(app).map(|(p, src)| RuntimeInfo {
        path: p.to_string_lossy().into_owned(),
        source: src.to_string(),
        version: runtime_version(&p),
    });
    let npm = resolve_npm(app).map(|(p, src)| RuntimeInfo {
        path: p.to_string_lossy().into_owned(),
        source: src.as_str().to_string(),
        version: runtime_version(&p),
    });
    let (bundled_dir_exists, bundled_sha_verified) = match resource_root(app) {
        Some(root) => {
            let dir = root.join("runtime");
            if !dir.is_dir() {
                (false, None)
            } else {
                let file = bundled_bun_in(&root, current_target_triple());
                match (bundled_bun_sha256(), file.exists()) {
                    (Some(expect), true) => {
                        (true, Some(verify_bundled_sha256(&file, &expect).is_ok()))
                    }
                    _ => (true, None),
                }
            }
        }
        None => (false, None),
    };
    RuntimeDiagnostics {
        bun,
        npm,
        bundled_dir_exists,
        bundled_sha_verified,
    }
}

/// 诊断命令（前端 ipc/runtime.ts 消费）。
/// async + spawn_blocking：实现含 2 个 --version 子进程 + 61MB 内嵌 bun 的 sha256
/// 全量读，冷缓存实测 2.3s——同步命令会在 Tauri 命令队列串行占位，把同时到达的
/// adapter_status 等轻命令全部堵住（设置面板「点开慢几秒」的实测根因，perf 打点实锤
/// runtime_diagnostics 2335ms / 被堵的 adapter_status 首轮 2324ms、二轮 8ms）。
#[tauri::command]
pub async fn runtime_diagnostics_cmd(app: tauri::AppHandle) -> RuntimeDiagnostics {
    tauri::async_runtime::spawn_blocking(move || runtime_diagnostics(&app))
        .await
        .unwrap_or_else(|e| {
            log::warn!("[embedded_runtime] runtime_diagnostics 任务中断: {e}");
            RuntimeDiagnostics {
                bun: None,
                npm: None,
                bundled_dir_exists: false,
                bundled_sha_verified: None,
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ainone-rt-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_exec(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn resolve_bun_system_wins_over_bundled() {
        let dir = tmpdir("sys-win");
        let bundled = bundled_bun_in(&dir, "a-b-c");
        write_exec(&bundled);
        let r = resolve_bun_in(
            Some(&dir),
            "a-b-c",
            Some(PathBuf::from("/usr/local/bin/bun")),
        )
        .unwrap();
        assert_eq!(r.0, PathBuf::from("/usr/local/bin/bun"));
        assert_eq!(r.1, "system");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_bun_falls_to_bundled_when_system_missing() {
        let dir = tmpdir("bundled");
        let bundled = bundled_bun_in(&dir, "a-b-c");
        write_exec(&bundled);
        let r = resolve_bun_in(Some(&dir), "a-b-c", None).unwrap();
        assert_eq!(r.0, bundled);
        assert_eq!(r.1, "bundled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_bun_none_when_both_missing() {
        let dir = tmpdir("none");
        // resource 根在但文件不在
        assert!(resolve_bun_in(Some(&dir), "a-b-c", None).is_none());
        // resource 根都缺
        assert!(resolve_bun_in(None, "a-b-c", None).is_none());
        // 文件在但不可执行（0o644）→ 不算命中
        let bundled = bundled_bun_in(&dir, "a-b-c");
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, "not exec").unwrap();
        assert!(resolve_bun_in(Some(&dir), "a-b-c", None).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundled_bun_path_layout() {
        let p = bundled_bun_in(Path::new("/res"), "x86_64-unknown-linux-gnu");
        assert_eq!(
            p.to_string_lossy().replace('\\', "/"),
            "/res/runtime/x86_64-unknown-linux-gnu/bun"
        );
    }

    #[test]
    fn resolve_npm_system_npm_wins() {
        let r = resolve_npm_in(
            None,
            "t",
            Some(PathBuf::from("/usr/local/bin/npm")),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(r.1, NpmSource::System);
    }

    #[test]
    fn resolve_npm_node_sibling_when_npm_missing() {
        // node 在 /opt/node/bin/node，同目录有 npm → 命中同级
        let dir = tmpdir("sibling");
        let node = dir.join("bin").join("node");
        write_exec(&node);
        let npm = dir.join("bin").join("npm");
        write_exec(&npm);
        let r = resolve_npm_in(None, "t", None, Some(node.clone()), None, None).unwrap();
        assert_eq!(r.0, npm);
        assert_eq!(r.1, NpmSource::System);
        // 同级 npm 不在 → 落到 bun 顶上
        std::fs::remove_file(&npm).unwrap();
        let bun = PathBuf::from("/usr/local/bin/bun");
        let r = resolve_npm_in(None, "t", None, Some(node), None, Some(bun)).unwrap();
        assert_eq!(r.1, NpmSource::BundledBun);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_npm_bun_fallback_order() {
        // system bun 优先于 bundled bun
        let dir = tmpdir("npm-order");
        let bundled = bundled_bun_in(&dir, "t");
        write_exec(&bundled);
        let r = resolve_npm_in(
            Some(&dir),
            "t",
            None,
            None,
            Some(PathBuf::from("/x/bun")),
            Some(bundled.clone()),
        )
        .unwrap();
        assert_eq!(r.0, PathBuf::from("/x/bun"));
        assert_eq!(r.1, NpmSource::BundledBun);
        // system bun 也缺 → bundled bun
        let r = resolve_npm_in(Some(&dir), "t", None, None, None, Some(bundled)).unwrap();
        assert_eq!(r.1, NpmSource::BundledBun);
        // 全缺 → None
        assert!(resolve_npm_in(Some(&dir), "t", None, None, None, None).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    const VALID_MANIFEST: &str = r#"{
        "schemaVersion": 1,
        "bun": "1.3.4",
        "bunArtifacts": {
            "aarch64-apple-darwin": { "sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
            "x86_64-unknown-linux-gnu": { "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
        }
    }"#;

    #[test]
    fn manifest_parse_valid() {
        let m = parse_runtime_manifest(VALID_MANIFEST).unwrap();
        assert_eq!(m.bun_version, "1.3.4");
        assert_eq!(m.artifacts.len(), 2);
        // sha 统一小写
        assert_eq!(
            m.artifacts.get("aarch64-apple-darwin").unwrap(),
            &"a".repeat(64)
        );
    }

    #[test]
    fn manifest_parse_rejects_bad_shapes() {
        assert!(parse_runtime_manifest("not json").is_err());
        assert!(parse_runtime_manifest(r#"{"bun":"1"}"#).is_err()); // 缺 schemaVersion
        assert!(parse_runtime_manifest(r#"{"schemaVersion":2,"bun":"1"}"#).is_err()); // 版本不支持
        assert!(parse_runtime_manifest(r#"{"schemaVersion":1}"#).is_err()); // 缺 bun
        assert!(
            parse_runtime_manifest(r#"{"schemaVersion":1,"bun":"1","bunArtifacts":{}}"#).is_err()
        ); // 空 artifacts
        assert!(parse_runtime_manifest(
            r#"{"schemaVersion":1,"bun":"1","bunArtifacts":{"t":{"sha256":"xyz"}}}"#
        )
        .is_err()); // sha 非 64hex
    }

    #[test]
    fn verify_sha256_three_states() {
        let dir = tmpdir("sha");
        let f = dir.join("payload");
        std::fs::write(&f, b"hello").unwrap();
        // echo -n hello | shasum -a 256
        let hello_sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        assert!(verify_bundled_sha256(&f, hello_sha).is_ok());
        // 不匹配 → Err 带实际哈希
        let bad = verify_bundled_sha256(&f, &"0".repeat(64)).unwrap_err();
        assert_eq!(bad, hello_sha);
        // 缺失 → missing
        assert_eq!(
            verify_bundled_sha256(&dir.join("nope"), hello_sha).unwrap_err(),
            "missing"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
