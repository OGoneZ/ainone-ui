// P8 · F-8-7 快问（Quick Ask）：独立轻量模型调用路径（DEC-20）。
//
// 边界（plan-p8.md DEC-20）：
//   - 仅供「快问」：不进 agent 主链路、不写会话日志、不走 harness。
//   - 密钥不暴露给 WebView：请求在 Rust 侧发起；config_get 不回传 apiKey 明文，
//     config_save 只在用户显式填入时覆盖，留空则保留既有密钥。
//   - OpenAI 兼容 chat/completions 格式。
//
// 分四类结果（AC-P8-14 四级返回态）：成功 / 非 2xx / 超时 / 空响应。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

fn default_timeout_ms() -> u64 {
    30_000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickAskConfig {
    /// OpenAI 兼容 base_url；结尾可带或不带 /chat/completions（要求绝对 http(s)）
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

impl QuickAskConfig {
    fn empty() -> Self {
        QuickAskConfig {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
            timeout_ms: default_timeout_ms(),
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
    let c = load_config(&app)?;
    Ok(QuickAskConfigView {
        base_url: c.base_url,
        model: c.model,
        timeout_ms: c.timeout_ms,
        has_api_key: !c.api_key.is_empty(),
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

/// 实际发起快问请求（Rust 侧 + 密钥不落 WebView）。
pub async fn call_quick_ask(cfg: &QuickAskConfig, text: &str) -> Result<String, String> {
    let url = chat_completions_url(&cfg.base_url);
    let body = build_chat_body(&cfg.model, text);
    log::info!("[quickask] 请求 {} 模型 {}（{} 字符）", url, cfg.model, text.len());

    let start = std::time::Instant::now();
    let builder = reqwest::Client::builder().timeout(Duration::from_millis(cfg.timeout_ms));
    let mut req = builder
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?
        .post(&url)
        .json(&body);
    if !cfg.api_key.is_empty() {
        req = req.bearer_auth(&cfg.api_key);
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
    match classify_response(status, &text_resp) {
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
        };
        let err = call_quick_ask(&cfg, "hi").await.unwrap_err();
        assert!(err.contains("超时"), "期望超时错误，实际: {err}");
    }
}
