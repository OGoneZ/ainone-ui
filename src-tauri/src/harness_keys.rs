// P29 任务三：codex API key 的应用侧托管。
//
// Codex 官方机制：[model_providers.<id>] 的 env_key 指向一个环境变量名，
// Codex 运行时从进程环境取 Bearer token。key 明文不进 toml（官方亦不推荐
// experimental_bearer_token），故应用自管一份 key 存档（appConfigDir/harness-keys.json，
// 权限与同目录其他配置一致），spawn codex 时由 agent.rs 注入 env。
//
// 密钥纪律：key 不回传 WebView（无 get 明文命令，只有 store + spawn 注入）。

use std::path::PathBuf;
use tauri::Manager;

const CODEX_KEY_ENV: &str = "AINONE_CODEX_API_KEY";

fn keys_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("harness-keys.json"))
}

fn read_keys_text(path: &std::path::Path) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// 存储（或覆盖）codex key。
pub fn store_codex_key(app: &tauri::AppHandle, key: &str) -> Result<(), String> {
    let path = keys_path(app)?;
    store_codex_key_with(path.parent(), key)
}

/// 注入式实现（测试可传临时目录；生产传 keys.json 的父目录）。
pub fn store_codex_key_with(dir: Option<&std::path::Path>, key: &str) -> Result<(), String> {
    let Some(dir) = dir else { return Err("无配置目录".into()) };
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let path = dir.join("harness-keys.json");
    let mut v = read_keys_text(&path);
    if !v.is_object() {
        v = serde_json::json!({});
    }
    v["codex"] = serde_json::Value::String(key.to_string());
    std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default())
        .map_err(|e| format!("写入 keys 失败: {e}"))
}

/// 生产路径的 keys.json（由命令层经 AppHandle 解析；keys_path 即入口）。
/// spawn 侧注入走 codex_key_env（传 app_config_dir）。

/// spawn 时注入 codex key env（key 未存则不注入，由 Codex 报原生错误）。
pub fn codex_key_env(dir: Option<&std::path::Path>) -> Option<(String, String)> {
    let path = dir.map(|d| d.join("harness-keys.json"))?;
    let v = read_keys_text(&path);
    let key = v.get("codex").and_then(|k| k.as_str()).filter(|k| !k.trim().is_empty())?;
    Some((CODEX_KEY_ENV.into(), key.to_string()))
}

/// codex 权限开关状态的 spawn 注入（P36）。codex-acp 不读 config.toml 的
/// approval_policy（runTurn 每 turn 显式传 agentMode.approvalPolicy 覆盖），
/// 唯一持久入口是 INITIAL_AGENT_MODE env（官方 getInitialAgentMode 读取点）。
/// bypass=true → agent-full-access；false/未存 → 不注入（codex-acp 默认 agent 模式）。
pub fn codex_perm_env(dir: Option<&std::path::Path>) -> Option<(String, String)> {
    let path = dir.map(|d| d.join("harness-keys.json"))?;
    let v = read_keys_text(&path);
    let bypass = v.get("codexPermBypass")?.as_bool()?;
    bypass.then(|| ("INITIAL_AGENT_MODE".to_string(), "agent-full-access".to_string()))
}

/// 存储 codex 权限开关（bypass=true = 免确认 full-access）。
pub fn store_codex_perm_bypass(app: &tauri::AppHandle, bypass: bool) -> Result<(), String> {
    let path = keys_path(app)?;
    store_codex_perm_bypass_with(path.parent(), bypass)
}

/// 注入式实现（测试可传临时目录）。
pub fn store_codex_perm_bypass_with(dir: Option<&std::path::Path>, bypass: bool) -> Result<(), String> {
    let Some(dir) = dir else { return Err("无配置目录".into()) };
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let path = dir.join("harness-keys.json");
    let mut v = read_keys_text(&path);
    if !v.is_object() {
        v = serde_json::json!({});
    }
    v["codexPermBypass"] = serde_json::Value::Bool(bypass);
    std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default())
        .map_err(|e| format!("写入 keys 失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_key_store_and_inject_roundtrip() {
        let dir = std::env::temp_dir().join(format!("ainone-keys-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 未存 → 不注入
        assert!(codex_key_env(Some(&dir)).is_none());

        // 存 → 注入 env 名值对
        store_codex_key_with(Some(&dir), "sk-test").unwrap();
        let (name, value) = codex_key_env(Some(&dir)).unwrap();
        assert_eq!(name, "AINONE_CODEX_API_KEY");
        assert_eq!(value, "sk-test");

        // 覆盖存储
        store_codex_key_with(Some(&dir), "sk-rotated").unwrap();
        assert_eq!(codex_key_env(Some(&dir)).unwrap().1, "sk-rotated");

        // 损坏文件 → 不注入不 panic
        std::fs::write(dir.join("harness-keys.json"), "junk").unwrap();
        assert!(codex_key_env(Some(&dir)).is_none());

        // 空串 key → 不注入
        store_codex_key_with(Some(&dir), "  ").unwrap();
        assert!(codex_key_env(Some(&dir)).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_perm_bypass_store_and_inject() {
        let dir = std::env::temp_dir().join(format!("ainone-perm-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 未存 → 不注入（codex-acp 默认 agent 模式）
        assert!(codex_perm_env(Some(&dir)).is_none());

        // 存 false → 语义「确认模式」：不注入 env（区别于「未配置」也走默认，殊途同归）
        store_codex_perm_bypass_with(Some(&dir), false).unwrap();
        assert!(codex_perm_env(Some(&dir)).is_none());

        // 存 true → 注入 full-access
        store_codex_perm_bypass_with(Some(&dir), true).unwrap();
        let (name, value) = codex_perm_env(Some(&dir)).unwrap();
        assert_eq!(name, "INITIAL_AGENT_MODE");
        assert_eq!(value, "agent-full-access");

        // 与 codex key 互不干扰（同一文件两键）
        store_codex_key_with(Some(&dir), "sk-x").unwrap();
        assert_eq!(codex_key_env(Some(&dir)).unwrap().1, "sk-x");
        assert_eq!(codex_perm_env(Some(&dir)).unwrap().1, "agent-full-access");

        // 损坏文件 → 不注入不 panic
        std::fs::write(dir.join("harness-keys.json"), "junk").unwrap();
        assert!(codex_perm_env(Some(&dir)).is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
