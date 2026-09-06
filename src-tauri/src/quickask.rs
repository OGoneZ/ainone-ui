// P8 · F-8-7 快问（Quick Ask）：独立轻量模型调用路径（DEC-20）。
//
// 边界（plan-p8.md DEC-20）：
//   - 仅供「快问」：不进 agent 主链路、不写会话日志、不走 harness。
//   - 密钥不暴露给 WebView：请求在 Rust 侧发起；config_get 不回传 apiKey 明文，
//     config_save 只在用户显式填入时覆盖，留空则保留既有密钥。
//   - OpenAI 兼容 chat/completions 格式；P22 起支持 anthropic 协议（自动取
//     Claude Code settings，见 harness_probe.rs）。
//
// 分四类结果（AC-P8-14 四级返回态）：成功 / 非 2xx / 超时 / 空响应。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

use crate::harness_probe;

fn default_timeout_ms() -> u64 {
    30_000
}

/// 调用协议：openai = /chat/completions；anthropic = /v1/messages。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QaProtocol {
    Openai,
    Anthropic,
}

impl Default for QaProtocol {
    fn default() -> Self {
        QaProtocol::Openai
    }
}

impl QaProtocol {
    fn as_str(&self) -> &'static str {
        match self {
            QaProtocol::Openai => "openai",
            QaProtocol::Anthropic => "anthropic",
        }
    }
}

/// 配置来源：manual = 用户手动保存；auto:<harness> = 从 harness settings 自动探测。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct QaSource(pub String);

impl QaSource {
    fn is_manual(&self) -> bool {
        self.0.is_empty() || self.0 == "manual"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickAskConfig {
    /// base_url：openai 协议下结尾可带或不带 /chat/completions；
    /// anthropic 协议下为网关 base（自动补 /v1/messages）
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub protocol: QaProtocol,
    /// 来源标记（空/“manual” = 手动；auto:claude-code / auto:codex = 自动探测）
    #[serde(default)]
    pub source: QaSource,
}

impl QuickAskConfig {
    fn empty() -> Self {
        QuickAskConfig {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            timeout_ms: default_timeout_ms(),
            protocol: QaProtocol::default(),
            source: QaSource::default(),
        }
    }
}

/// 回传前端的配置视图（apiKey 不回传明文，只给 has_api_key 标记）
#[derive(Debug, Clone, Serialize)]
pub struct QuickAskConfigView {
    pub base_url: String,
    pub model: String,
    pub timeout_ms: u64,
    pub has_api_key: bool,
    pub protocol: String,
    /// "" = 手动配置；"auto:claude-code" / "auto:codex" = 自动探测来源
    pub source: String,
}

/// 前端保存的配置（api_key 为 Option：None/空串 = 保留既有密钥）
#[derive(Debug, Clone, Deserialize)]
pub struct QuickAskConfigInput {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default)]
    pub api_key: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("quickask.json"))
}

fn load_config(app: &tauri::AppHandle) -> Result<QuickAskConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(QuickAskConfig::empty());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取快问配置失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| {
        log::warn!("[quickask] 配置 JSON 损坏: {e}");
        format!("快问配置解析失败: {e}")
    })
}

fn save_config(app: &tauri::AppHandle, cfg: &QuickAskConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(config_path(app)?, json).map_err(|e| format!("写入快问配置失败: {e}"))
}

#[tauri::command]
pub fn quickask_config_get(app: tauri::AppHandle) -> Result<QuickAskConfigView, String> {
    let mut c = load_config(&app)?;
    // P22 自动探测：从未手动配置（无手动来源标记）且配置为空时，读本机
    // harness settings 填默认值并落盘；此后读缓存结果，不再重复探测。
    if c.source.is_manual() && c.base_url.trim().is_empty() && c.model.trim().is_empty() {
        if let Some(p) = harness_probe::probe_harness(None) {
            log::info!(
                "[quickask] 自动采用 harness 配置：{}（{} 协议，模型 {}）",
                p.source,
                p.protocol,
                p.model
            );
            c.base_url = p.base_url;
            c.api_key = p.api_key;
            c.model = p.model;
            c.protocol = if p.protocol == "anthropic" {
                QaProtocol::Anthropic
            } else {
                QaProtocol::Openai
            };
            c.source = QaSource(format!("auto:{}", p.source));
            save_config(&app, &c)?;
        }
    }
    Ok(QuickAskConfigView {
        base_url: c.base_url,
        model: c.model,
        timeout_ms: c.timeout_ms,
        has_api_key: !c.api_key.is_empty(),
        protocol: c.protocol.as_str().to_string(),
        source: c.source.0,
    })
}

#[tauri::command]
pub fn quickask_config_save(app: tauri::AppHandle, input: QuickAskConfigInput) -> Result<(), String> {
    let mut c = load_config(&app)?;
    c.base_url = input.base_url.trim().to_string();
    c.model = input.model.trim().to_string();
    c.timeout_ms = if input.timeout_ms > 0 {
        input.timeout_ms
    } else {
        default_timeout_ms()
    };
    // 用户显式保存 → 手动来源（自动探测不再覆盖）
    c.source = QaSource("manual".to_string());
    // apiKey：仅显式填入时覆盖（留空 = 保留既有密钥）
    let key = input.api_key.trim().to_string();
    if !key.is_empty() {
        c.api_key = key;
    }
    save_config(&app, &c)
}

/// 纯函数：由 base_url 拼出 chat/completions 端点（兼容用户已写全路径）。
pub fn chat_completions_url(base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") || b.ends_with("/v1/chat/completions") {
        b.to_string()
    } else {
        format!("{b}/chat/completions")
    }
}

/// 纯函数：拼 OpenAI 兼容请求体。
pub fn build_chat_body(model: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": text }],
    })
}

/// 纯函数：把 (status, body) 归类成四级结果 —— 成功 / 非 2xx / 空响应。
/// （超时在 reqwest 层 `is_timeout()` 判定，见 call_quick_ask。）
pub fn classify_response(status: u16, body: &str) -> Result<String, String> {
    if !(200..300).contains(&status) {
        return Err(format!("非 2xx 状态码 {status}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("响应非 JSON: {e}"))?;
    let content = v["choices"][0]["message"]["content"].as_str();
    match content {
        Some(s) if !s.trim().is_empty() => Ok(s.to_string()),
        _ => Err("空响应（无 choices[0].message.content）".to_string()),
    }
}

/// 纯函数：拼 anthropic /v1/messages 请求体。
pub fn build_anthropic_body(model: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [{ "role": "user", "content": text }],
    })
}

/// 纯函数：解析 anthropic messages 响应（取 content[0].text）。
pub fn classify_anthropic_response(status: u16, body: &str) -> Result<String, String> {
    if !(200..300).contains(&status) {
        return Err(format!("非 2xx 状态码 {status}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("响应非 JSON: {e}"))?;
    let content = v["content"][0]["text"].as_str();
    match content {
        Some(s) if !s.trim().is_empty() => Ok(s.to_string()),
        _ => Err("空响应（无 content[0].text）".to_string()),
    }
}

/// 实际发起快问请求（Rust 侧 + 密钥不落 WebView）。按 protocol 分协议。
pub async fn call_quick_ask(cfg: &QuickAskConfig, text: &str) -> Result<String, String> {
    let (url, body) = match cfg.protocol {
        QaProtocol::Anthropic => (
            harness_probe::anthropic_messages_url(&cfg.base_url),
            build_anthropic_body(&cfg.model, text),
        ),
        QaProtocol::Openai => (
            chat_completions_url(&cfg.base_url),
            build_chat_body(&cfg.model, text),
        ),
    };
    log::info!(
        "[quickask] 请求 {} 模型 {} 协议 {}（{} 字符）",
        url,
        cfg.model,
        cfg.protocol.as_str(),
        text.len()
    );

    let start = std::time::Instant::now();
    let builder = reqwest::Client::builder().timeout(Duration::from_millis(cfg.timeout_ms));
    let mut req = builder
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?
        .post(&url)
        .json(&body);
    if !cfg.api_key.is_empty() {
        req = match cfg.protocol {
            // anthropic 网关：x-api-key 头（部分网关同时认 Authorization，双发兼容）
            QaProtocol::Anthropic => req
                .header("x-api-key", &cfg.api_key)
                .header("anthropic-version", "2023-06-01")
                .bearer_auth(&cfg.api_key),
            QaProtocol::Openai => req.bearer_auth(&cfg.api_key),
        };
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            if e.is_timeout() {
                log::warn!("[quickask] 超时 {url}（{}ms）", cfg.timeout_ms);
                return Err(format!("超时（>{0}ms）", cfg.timeout_ms));
            }
            log::warn!("[quickask] 请求失败 {url}: {e}");
            return Err(format!("请求失败: {e}"));
        }
    };
    let status = resp.status().as_u16();
    let text_resp = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    let elapsed = start.elapsed().as_millis();
    let result = match cfg.protocol {
        QaProtocol::Anthropic => classify_anthropic_response(status, &text_resp),
        QaProtocol::Openai => classify_response(status, &text_resp),
    };
    match result {
        Ok(out) => {
            log::info!("[quickask] 成功 {url} 耗时 {elapsed}ms");
            Ok(out)
        }
        Err(msg) => {
            log::warn!("[quickask] 失败 {url} {status} {msg}");
            Err(msg)
        }
    }
}

/// Tauri command：快问入口（前端传选中文本，返回解释文本）。
#[tauri::command]
pub async fn quick_ask(app: tauri::AppHandle, text: String) -> Result<String, String> {
    let cfg = load_config(&app)?;
    if cfg.base_url.trim().is_empty() {
        return Err("未配置快问模型（base_url 为空）".to_string());
    }
    call_quick_ask(&cfg, &text).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_appends_chat_completions() {
        assert_eq!(chat_completions_url("https://api.openai.com"), "https://api.openai.com/chat/completions");
        assert_eq!(chat_completions_url("https://x.com/v1"), "https://x.com/v1/chat/completions");
        assert_eq!(chat_completions_url("https://x.com/v1/"), "https://x.com/v1/chat/completions");
    }

    #[test]
    fn url_keeps_full_path() {
        assert_eq!(chat_completions_url("https://x.com/v1/chat/completions"), "https://x.com/v1/chat/completions");
    }

    #[test]
    fn classify_success() {
        let body = r#"{"choices":[{"message":{"content":"这是解释"}}]}"#;
        assert_eq!(classify_response(200, body).unwrap(), "这是解释");
    }

    #[test]
    fn classify_non_2xx() {
        assert!(classify_response(500, "oops").unwrap_err().contains("500"));
    }

    #[test]
    fn classify_empty_response() {
        let ok_struct = r#"{"choices":[{"message":{"content":""}}]}"#;
        assert!(classify_response(200, ok_struct).unwrap_err().contains("空响应"));
        let no_choices = r#"{}"#;
        assert!(classify_response(200, no_choices).unwrap_err().contains("空响应"));
    }

    // —— P22 anthropic 协议 ——
    #[test]
    fn anthropic_body_shape() {
        let b = build_anthropic_body("m1", "hi");
        assert_eq!(b["model"], "m1");
        assert_eq!(b["messages"][0]["content"], "hi");
        assert!(b["max_tokens"].as_u64().unwrap() > 0);
    }

    #[test]
    fn anthropic_classify_success_and_empty() {
        let ok = r#"{"content":[{"type":"text","text":"解释完成"}]}"#;
        assert_eq!(classify_anthropic_response(200, ok).unwrap(), "解释完成");
        assert!(classify_anthropic_response(200, r#"{"content":[]}"#).unwrap_err().contains("空响应"));
        assert!(classify_anthropic_response(502, "x").unwrap_err().contains("502"));
    }

    // 超时：本地起一个「永不应答」的 socket，用 200ms 短超时验证 is_timeout 分支。
    #[tokio::test]
    async fn call_quick_ask_times_out() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        // 接受连接后挂住不回复
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let _stream = stream.unwrap();
                std::thread::sleep(Duration::from_secs(5));
                break;
            }
        });
        let cfg = QuickAskConfig {
            base_url: format!("http://{addr}/v1"),
            api_key: String::new(),
            model: "test".into(),
            timeout_ms: 200,
            protocol: QaProtocol::default(),
            source: QaSource::default(),
        };
        let err = call_quick_ask(&cfg, "hi").await.unwrap_err();
        assert!(err.contains("超时"), "期望超时错误，实际: {err}");
    }
}
