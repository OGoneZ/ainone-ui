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
use futures_util::StreamExt;
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

/// P32f：探测链路读取快问落盘配置（home 注入便于测试；生产由 harness_meta
/// 传 None → 用 app config dir）。返回 (base_url, api_key, protocol 字符串)。
/// 文件缺失/损坏 → None（探测回落表单值）。key 明文仅在 Rust 侧流转。
pub(crate) fn load_config_for_probe(
    _home: Option<&std::path::Path>,
) -> Option<QuickAskProbeConfig> {
    // harness_meta 无 AppHandle；直接读默认 config dir（与 config_path 同一目录）
    let dir = dirs::config_dir()?.join("com.zhubaoduo.ainone-ui");
    let path = dir.join("quickask.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let c: QuickAskConfig = serde_json::from_str(&raw).ok()?;
    Some(QuickAskProbeConfig {
        base_url: c.base_url,
        api_key: c.api_key,
        protocol: c.protocol.as_str().to_string(),
    })
}

/// 探测链路用的快问配置切片（key 明文只到请求头，不回传 WebView）
#[derive(Debug, Clone)]
pub struct QuickAskProbeConfig {
    pub base_url: String,
    pub api_key: String,
    pub protocol: String,
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

/// 快问提示词（P27d）：选中文本多为术语/单句，参考社区划词解释扩展
/// （text-explainer 等通用模式）——一句话定义 + 关键点 + 简短示例，
/// 保持简短，用选中内容的语言回答。
pub const QUICK_ASK_SYSTEM_PROMPT: &str = "你是一个简洁的解释助手。用户会选中一段术语、代码、报错或句子。请用与选中内容相同的语言，简短清晰地解释：先用一句话给出定义或结论，再用 markdown 列表给出 2-4 个要点，必要时给一个简短示例。使用 markdown 格式。不要开场白，不要复述问题。";

/// 纯函数：拼 OpenAI 兼容请求体。
pub fn build_chat_body(model: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": QUICK_ASK_SYSTEM_PROMPT },
            { "role": "user", "content": text },
        ],
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
/// max_tokens 16384：给思考块留足预算（实测 glm-5.3-flash 思考消耗可达数百块），
/// 解释类回答本身很短，上限仅防极端跑飞；OpenAI 协议则不带该字段（服务端默认）。
pub fn build_anthropic_body(model: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "max_tokens": 16384,
        "system": QUICK_ASK_SYSTEM_PROMPT,
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

/// SSE 流事件（serde tag="event"，对齐 terminal.rs TerminalEvent 形状）：
/// Delta 推增量文本，Done 收尾（前端以 done 为终止信号）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "payload", rename_all = "camelCase")]
pub enum QuickAskEvent {
    Delta(String),
    Done,
}

/// 纯函数：从一条 SSE data 行提取增量文本（openai choices[0].delta.content）。
/// 返回 None = 本行无增量（keep-alive/[DONE]/role-only 首块等）。
pub fn sse_delta(line: &str) -> Option<String> {
    let payload = line.strip_prefix("data: ")?;
    let payload = payload.trim();
    if payload == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    v["choices"][0]["delta"]["content"].as_str().map(String::from)
}

/// 纯函数：从一条 SSE data 行提取 anthropic 增量。
/// 只取 content_block_delta 且 delta.type=="text_delta" 的 text —— 该网关模型
/// （glm-5.3-flash）还会推 thinking_delta（思考块），必须跳过，否则正文被
/// 思考文本污染；且 max_tokens 被思考耗尽时 text_delta 一个都没有 → 空响应。
pub fn sse_delta_anthropic(line: &str) -> Option<String> {
    let payload = line.strip_prefix("data: ")?;
    let payload = payload.trim();
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    if v["type"].as_str() == Some("content_block_delta") && v["delta"]["type"].as_str() == Some("text_delta") {
        return v["delta"]["text"].as_str().map(String::from);
    }
    None
}

/// 实际发起快问请求（Rust 侧 + 密钥不落 WebView）。流式：请求体 stream:true，
/// SSE 逐块经 channel 推 Delta，全部收割后返回完整文本（错误仍整链返回 Err）。
pub async fn call_quick_ask(
    cfg: &QuickAskConfig,
    text: &str,
    channel: &tauri::ipc::Channel<QuickAskEvent>,
) -> Result<String, String> {
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
    let mut body = body;
    body["stream"] = serde_json::Value::Bool(true);
    log::info!(
        "[quickask] 流式请求 {} 模型 {} 协议 {}（{} 字符）",
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
    if !(200..300).contains(&status) {
        let msg = format!("非 2xx 状态码 {status}");
        log::warn!("[quickask] 失败 {url} {status}");
        return Err(msg);
    }

    // SSE 收割：bytes_stream 逐块 → 按 \n 切行 → data 行提取增量。
    // buffer 处理 chunk 边界（一行 data 跨两个网络块的情形）。
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut full = String::new();
    loop {
        let chunk = match stream.next().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                let msg = format!("读取响应失败: {e}");
                log::warn!("[quickask] 失败 {url} {msg}");
                return Err(msg);
            }
            None => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buffer.find('\n') {
            let line: String = buffer.drain(..=pos).collect();
            let line = line.trim_end();
            let delta = match cfg.protocol {
                QaProtocol::Anthropic => sse_delta_anthropic(line),
                QaProtocol::Openai => sse_delta(line),
            };
            if let Some(d) = delta {
                if !d.is_empty() {
                    full.push_str(&d);
                    let _ = channel.send(QuickAskEvent::Delta(d));
                }
            }
        }
    }
    let elapsed = start.elapsed().as_millis();
    if full.trim().is_empty() {
        let msg = "空响应（流式无增量内容）".to_string();
        log::warn!("[quickask] 失败 {url} {msg}");
        return Err(msg);
    }
    log::info!("[quickask] 流式成功 {url} 耗时 {elapsed}ms（{} 字符）", full.len());
    let _ = channel.send(QuickAskEvent::Done);
    Ok(full)
}

/// Tauri command：快问入口（前端传选中文本，返回解释文本；增量经 channel 推送）。
#[tauri::command]
pub async fn quick_ask(
    app: tauri::AppHandle,
    text: String,
    on_event: tauri::ipc::Channel<QuickAskEvent>,
) -> Result<String, String> {
    let cfg = load_config(&app)?;
    if cfg.base_url.trim().is_empty() {
        return Err("未配置快问模型（base_url 为空）".to_string());
    }
    call_quick_ask(&cfg, &text, &on_event).await
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
        // P27d：system 提示词入请求体（两协议一致）
        assert_eq!(b["system"], QUICK_ASK_SYSTEM_PROMPT);
        let c = build_chat_body("m1", "hi");
        assert_eq!(c["messages"][0]["role"], "system");
        assert_eq!(c["messages"][0]["content"], QUICK_ASK_SYSTEM_PROMPT);
        assert_eq!(c["messages"][1]["content"], "hi");
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
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let err = call_quick_ask(&cfg, "hi", &channel).await.unwrap_err();
        assert!(err.contains("超时"), "期望超时错误，实际: {err}");
    }

    // —— P27 SSE 流式解析 ——
    #[test]
    fn sse_delta_openai() {
        assert_eq!(
            sse_delta(r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#).unwrap(),
            "你好"
        );
        // role-only 首块无增量
        assert_eq!(sse_delta(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), None);
        assert_eq!(sse_delta("data: [DONE]"), None);
        assert_eq!(sse_delta(": keep-alive"), None);
        assert_eq!(sse_delta(""), None);
    }

    #[test]
    fn sse_delta_anthropic_events() {
        assert_eq!(
            sse_delta_anthropic(r#"data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"解释"}}"#).unwrap(),
            "解释"
        );
        // thinking_delta（思考块）必须跳过——实测网关模型会推思考流，
        // 不滤会把思考文本当正文渲染
        assert_eq!(
            sse_delta_anthropic(
                r#"data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Let me"}}"#
            ),
            None
        );
        // 其他事件（message_start 等）无增量
        assert_eq!(
            sse_delta_anthropic(r#"data: {"type":"message_start","message":{}}"#),
            None
        );
    }
}
