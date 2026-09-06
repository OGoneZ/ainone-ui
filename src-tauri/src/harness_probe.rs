// P22 快问模型自动探测：读本机 harness settings，哪份能取到用哪份。
//
// 探测顺序（plan-p22.md 任务三）：
//   1. ~/.claude/settings.json → env.ANTHROPIC_BASE_URL + env.ANTHROPIC_AUTH_TOKEN
//      + 模型（ANTHROPIC_DEFAULT_HAIKU_MODEL → SONNET → OPUS → model 字段去 [1m] 后缀）
//      → protocol = anthropic，来源 claude-code
//   2. ~/.codex/config.toml → model_providers.*.base_url + model；
//      ~/.codex/auth.json → OPENAI_API_KEY → protocol = openai，来源 codex
//   两份都在 → Claude Code 优先（快问走轻量模型语义）。
//   都取不到 → None（保持手动配置）。
//
// 密钥只在 Rust 侧流转，不回传 WebView（与 quickask.rs 密钥纪律一致）。

use serde::Deserialize;

/// 探测结果：足以填一份 QuickAskConfig。
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessProbe {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    /// "anthropic" | "openai"
    pub protocol: String,
    /// "claude-code" | "codex"
    pub source: String,
}

/// 纯函数：Claude model 字段去上下文后缀（"saver/glm-5.3-flash[1m]" → "saver/glm-5.3-flash"）。
pub fn strip_model_suffix(model: &str) -> String {
    model
        .trim()
        .strip_suffix("[1m]")
        .unwrap_or(model.trim())
        .to_string()
}

/// 纯函数：从 Claude settings 的 env 表挑快问模型（HAIKU → SONNET → OPUS → model）。
/// settings_model 为顶层 "model" 字段（可能含 [1m] 后缀）。
pub fn pick_claude_model(env: &serde_json::Value, settings_model: Option<&str>) -> String {
    const ORDER: [&str; 3] = [
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ];
    for key in ORDER {
        if let Some(m) = env.get(key).and_then(|v| v.as_str()) {
            if !m.trim().is_empty() {
                return strip_model_suffix(m);
            }
        }
    }
    settings_model.map(strip_model_suffix).unwrap_or_default()
}

/// 纯函数：归一化 Anthropic base（去尾斜杠；不带 /v1 则补）。
pub fn anthropic_messages_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/v1") {
        format!("{b}/messages")
    } else {
        format!("{b}/v1/messages")
    }
}

#[derive(Deserialize)]
struct ClaudeSettings {
    #[serde(default)]
    env: serde_json::Value,
    #[serde(default)]
    model: Option<String>,
}

/// 从 claude settings.json 文本探测（解析 + 组装）。
pub fn probe_claude_text(raw: &str) -> Option<HarnessProbe> {
    let s: ClaudeSettings = serde_json::from_str(raw).ok()?;
    let base = s.env.get("ANTHROPIC_BASE_URL").and_then(|v| v.as_str())?;
    let key = s.env.get("ANTHROPIC_AUTH_TOKEN").and_then(|v| v.as_str())?;
    if base.trim().is_empty() || key.trim().is_empty() {
        return None;
    }
    let model = pick_claude_model(&s.env, s.model.as_deref());
    if model.is_empty() {
        return None;
    }
    Some(HarnessProbe {
        base_url: base.trim().to_string(),
        api_key: key.trim().to_string(),
        model,
        protocol: "anthropic".into(),
        source: "claude-code".into(),
    })
}

#[derive(Deserialize)]
struct CodexAuth {
    #[serde(default)]
    openai_api_key: Option<String>,
    // auth.json 实际键名为大写 OPENAI_API_KEY；serde 默认区分大小写，双字段兼容两种写法
    #[serde(default, rename = "OPENAI_API_KEY")]
    openai_api_key_upper: Option<String>,
}

#[derive(Deserialize)]
struct CodexConfigToml {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    model_provider: Option<String>,
    #[serde(default)]
    model_providers: serde_json::Value,
}

/// 从 codex config.toml + auth.json 文本探测（两个都齐才算数）。
pub fn probe_codex_text(config_toml: &str, auth_json: &str) -> Option<HarnessProbe> {
    let cfg: CodexConfigToml = toml::from_str(config_toml).ok()?;
    // provider 名：显式 model_provider 或第一个 model_providers 键
    let provider_name = cfg.model_provider.clone().or_else(|| {
        cfg.model_providers
            .as_object()
            .and_then(|o| o.keys().next().cloned())
    })?;
    let base = cfg
        .model_providers
        .get(&provider_name)
        .and_then(|p| p.get("base_url"))
        .and_then(|v| v.as_str())?;
    if base.trim().is_empty() {
        return None;
    }
    let auth: CodexAuth = serde_json::from_str(auth_json).ok()?;
    let key = auth
        .openai_api_key
        .or(auth.openai_api_key_upper)
        .filter(|k| !k.trim().is_empty())?;
    let model = cfg.model.unwrap_or_default();
    if model.trim().is_empty() {
        return None;
    }
    Some(HarnessProbe {
        base_url: base.trim().trim_end_matches('/').to_string(),
        api_key: key.trim().to_string(),
        model: model.trim().to_string(),
        protocol: "openai".into(),
        source: "codex".into(),
    })
}

/// 按优先级读本机文件探测（claude-code 优先于 codex）。
/// home 参数注入便于测试；生产传 None 用 dirs::home_dir()。
pub fn probe_harness(home: Option<&std::path::Path>) -> Option<HarnessProbe> {
    let home = match home {
        Some(h) => h.to_path_buf(),
        None => dirs::home_dir()?,
    };
    let claude = std::fs::read_to_string(home.join(".claude/settings.json"))
        .ok()
        .and_then(|raw| probe_claude_text(&raw));
    if claude.is_some() {
        return claude;
    }
    let codex_cfg = std::fs::read_to_string(home.join(".codex/config.toml")).ok();
    let codex_auth = std::fs::read_to_string(home.join(".codex/auth.json")).ok();
    match (codex_cfg, codex_auth) {
        (Some(c), Some(a)) => probe_codex_text(&c, &a),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_JSON: &str = r#"{
        "env": {
            "ANTHROPIC_BASE_URL": "https://gw.example.com/",
            "ANTHROPIC_AUTH_TOKEN": "sk-test",
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "saver/opus",
            "ANTHROPIC_DEFAULT_SONNET_MODEL": "saver/sonnet",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "saver/haiku"
        },
        "model": "saver/glm-5.3-flash[1m]"
    }"#;

    #[test]
    fn claude_probe_picks_haiku_and_strips_suffix() {
        let p = probe_claude_text(CLAUDE_JSON).unwrap();
        assert_eq!(p.model, "saver/haiku");
        assert_eq!(p.protocol, "anthropic");
        assert_eq!(p.source, "claude-code");
        assert_eq!(p.base_url, "https://gw.example.com/");
    }

    #[test]
    fn claude_probe_falls_back_to_model_field() {
        let raw = r#"{"env":{"ANTHROPIC_BASE_URL":"https://x.com","ANTHROPIC_AUTH_TOKEN":"sk"},"model":"gpt[1m]"}"#;
        let p = probe_claude_text(raw).unwrap();
        assert_eq!(p.model, "gpt");
    }

    #[test]
    fn claude_probe_missing_key_returns_none() {
        let raw = r#"{"env":{"ANTHROPIC_BASE_URL":"https://x.com"}}"#;
        assert!(probe_claude_text(raw).is_none());
        assert!(probe_claude_text("not json").is_none());
    }

    #[test]
    fn anthropic_url_normalizes() {
        assert_eq!(anthropic_messages_url("https://gw.example.com/"), "https://gw.example.com/v1/messages");
        assert_eq!(anthropic_messages_url("https://gw.example.com/v1"), "https://gw.example.com/v1/messages");
        assert_eq!(anthropic_messages_url("https://gw.example.com"), "https://gw.example.com/v1/messages");
    }

    #[test]
    fn codex_probe_parses_toml_and_auth() {
        let toml_raw = r#"
model = "gpt-5.4"
model_provider = "codex"

[model_providers.codex]
name = "codex"
base_url = "https://codex.example.cn/v1"
"#;
        let auth_raw = r#"{"OPENAI_API_KEY":"sk-codex"}"#;
        let p = probe_codex_text(toml_raw, auth_raw).unwrap();
        assert_eq!(p.base_url, "https://codex.example.cn/v1");
        assert_eq!(p.model, "gpt-5.4");
        assert_eq!(p.api_key, "sk-codex");
        assert_eq!(p.protocol, "openai");
        assert_eq!(p.source, "codex");
    }

    #[test]
    fn codex_probe_missing_auth_returns_none() {
        let toml_raw = r#"
model = "gpt-5.4"
[model_providers.codex]
base_url = "https://x/v1"
"#;
        assert!(probe_codex_text(toml_raw, "{}").is_none());
        assert!(probe_codex_text(toml_raw, "not json").is_none());
    }

    #[test]
    fn probe_harness_prefers_claude() {
        let dir = std::env::temp_dir().join(format!("ainone-probe-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::create_dir_all(dir.join(".codex")).unwrap();
        std::fs::write(dir.join(".claude/settings.json"), CLAUDE_JSON).unwrap();
        std::fs::write(dir.join(".codex/config.toml"), "model = \"m\"\n[model_providers.c]\nbase_url = \"https://c/v1\"\n").unwrap();
        std::fs::write(dir.join(".codex/auth.json"), r#"{"OPENAI_API_KEY":"k"}"#).unwrap();

        let p = probe_harness(Some(&dir)).unwrap();
        assert_eq!(p.source, "claude-code");

        // 只有 codex → 回落 codex
        std::fs::remove_dir_all(dir.join(".claude")).unwrap();
        let p = probe_harness(Some(&dir)).unwrap();
        assert_eq!(p.source, "codex");

        // 都没有 → None
        std::fs::remove_dir_all(dir.join(".codex")).unwrap();
        assert!(probe_harness(Some(&dir)).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
