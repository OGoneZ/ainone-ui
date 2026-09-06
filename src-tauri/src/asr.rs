// P9 · F-9-5 语音输入：音频上传自建 ASR 服务端转写。
//
// 客户端只做「录音（前端）+ 上传（本命令）」；ASR 模型本身在服务端。
// 服务端为 OpenAI 兼容 audio/transcriptions 格式（multipart：file + model）。
// 地址默认 https://asr.zhubaoduo.com/v1/audio/transcriptions，可用环境变量
// AINONE_ASR_URL 覆盖（内网部署无鉴权）。
//
// 语音服务配置化（P21）：asr.json 持久化 base_url/api_key/model，
// 设置页可改；未配置时回落 DEFAULT_* 与 AINONE_ASR_URL（兼容旧部署）。
// api_key 不回传明文（config_get 只给 has_api_key），留空保存 = 保留既有密钥。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;

pub const DEFAULT_ASR_URL: &str = "https://asr.zhubaoduo.com/v1/audio/transcriptions";
pub const DEFAULT_ASR_MODEL: &str = "mano-asr";

/// 语音服务配置（asr.json）：留空 = 用默认值（不写 has_api_key 判定）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrConfig {
    /// OpenAI 兼容 audio/transcriptions 端点（可带或不带全路径）
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
}

impl AsrConfig {
    fn empty() -> Self {
        AsrConfig {
            base_url: String::new(),
            api_key: String::new(),
            model: String::new(),
        }
    }
}

/// 回传前端的配置视图（api_key 不回传明文，只给 has_api_key 标记）
#[derive(Debug, Clone, Serialize)]
pub struct AsrConfigView {
    pub base_url: String,
    pub model: String,
    pub has_api_key: bool,
}

/// 前端保存的配置（api_key 为空串 = 保留既有密钥）
#[derive(Debug, Clone, Deserialize)]
pub struct AsrConfigInput {
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("asr.json"))
}

fn load_config(app: &tauri::AppHandle) -> Result<AsrConfig, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(AsrConfig::empty());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取语音配置失败: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| {
        log::warn!("[asr] 配置 JSON 损坏: {e}");
        format!("语音配置解析失败: {e}")
    })
}

fn save_config(app: &tauri::AppHandle, cfg: &AsrConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {e}"))?;
    std::fs::write(config_path(app)?, json).map_err(|e| format!("写入语音配置失败: {e}"))
}

#[tauri::command]
pub fn asr_config_get(app: tauri::AppHandle) -> Result<AsrConfigView, String> {
    let c = load_config(&app)?;
    Ok(AsrConfigView {
        base_url: c.base_url,
        model: c.model,
        has_api_key: !c.api_key.is_empty(),
    })
}

#[tauri::command]
pub fn asr_config_save(app: tauri::AppHandle, input: AsrConfigInput) -> Result<(), String> {
    let mut c = load_config(&app)?;
    c.base_url = input.base_url.trim().to_string();
    c.model = input.model.trim().to_string();
    // apiKey：仅显式填入时覆盖（留空 = 保留既有密钥）
    let key = input.api_key.trim().to_string();
    if !key.is_empty() {
        c.api_key = key;
    }
    save_config(&app, &c)
}

/// 纯函数：由配置 + 环境变量解析实际端点（优先级：配置 > AINONE_ASR_URL > 默认）。
pub fn effective_url(cfg_base_url: &str) -> String {
    let b = cfg_base_url.trim();
    if !b.is_empty() {
        return b.to_string();
    }
    std::env::var("AINONE_ASR_URL").unwrap_or_else(|_| DEFAULT_ASR_URL.to_string())
}

/// 纯函数：由配置解析实际模型（配置 > 默认）。
pub fn effective_model(cfg_model: &str) -> String {
    let m = cfg_model.trim();
    if !m.is_empty() {
        return m.to_string();
    }
    DEFAULT_ASR_MODEL.to_string()
}

/// 纯函数：解析 OpenAI 兼容转写响应（成功 → text；错误主因分类）。
pub fn parse_transcription(status: u16, body: &str) -> Result<String, String> {
    if !(200..300).contains(&status) {
        return Err(format!("ASR 非 2xx 状态码 {status}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("响应非 JSON: {e}"))?;
    match v["text"].as_str() {
        Some(t) if !t.trim().is_empty() => Ok(t.to_string()),
        _ => Err("转写结果为空".to_string()),
    }
}

/// 上传音频做转写（Rust 侧，避免前端直接连内网 ASR）。
///
/// 兼容保留的旧签名：不带配置，走默认端点/模型、无鉴权。
pub async fn transcribe_audio(data: Vec<u8>, filename: String, model: String) -> Result<String, String> {
    let url = effective_url("");
    transcribe_to(url, String::new(), model, data, filename).await
}

/// Tauri command：语音转写入口（前端传音频字节 + 文件名，返回转写文本）。
#[tauri::command]
pub async fn asr_transcribe(app: tauri::AppHandle, data: Vec<u8>, filename: String) -> Result<String, String> {
    let cfg = load_config(&app)?;
    let url = effective_url(&cfg.base_url);
    let model = effective_model(&cfg.model);
    let api_key = cfg.api_key;
    transcribe_to(url, api_key, model, data, filename).await
}

/// 按给定端点/密钥上传转写（供 asr_transcribe 与测试复用）。
pub async fn transcribe_to(url: String, api_key: String, model: String, data: Vec<u8>, filename: String) -> Result<String, String> {
    log::info!("[asr] 上传 {filename}（{} 字节）→ {url}", data.len());

    let part = reqwest::multipart::Part::bytes(data).file_name(filename);
    let form = reqwest::multipart::Form::new()
        .text("model", model)
        .part("file", part);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;

    let start = std::time::Instant::now();
    let mut req = client.post(&url).multipart(form);
    if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[asr] 上传失败 {url}: {e}");
            return Err(format!("上传失败: {e}"));
        }
    };
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    let elapsed = start.elapsed().as_millis();
    match parse_transcription(status, &body) {
        Ok(text) => {
            log::info!("[asr] 转写成功 {url} 耗时 {elapsed}ms（{} 字）", text.chars().count());
            Ok(text)
        }
        Err(msg) => {
            log::warn!("[asr] 转写失败 {url} {status} {msg}");
            Err(msg)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_success() {
        let body = r#"{"text":"这是转写结果"}"#;
        assert_eq!(parse_transcription(200, body).unwrap(), "这是转写结果");
    }

    #[test]
    fn parse_non_2xx() {
        assert!(parse_transcription(500, "err").unwrap_err().contains("500"));
    }

    #[test]
    fn parse_empty_text() {
        assert!(parse_transcription(200, r#"{"text":""}"#).unwrap_err().contains("为空"));
        assert!(parse_transcription(200, r#"{}"#).unwrap_err().contains("为空"));
    }

    #[test]
    fn parse_bad_json() {
        assert!(parse_transcription(200, "not-json").unwrap_err().contains("非 JSON"));
    }

    #[test]
    fn effective_url_priority() {
        // 配置优先于默认
        assert_eq!(effective_url("http://cfg.example/v1/audio/transcriptions"), "http://cfg.example/v1/audio/transcriptions");
        // 配置为空 → 默认（测试环境一般无 AINONE_ASR_URL；有则恒等该值）
        let fallback = std::env::var("AINONE_ASR_URL").unwrap_or_else(|_| DEFAULT_ASR_URL.to_string());
        assert_eq!(effective_url("  "), fallback);
        assert_eq!(effective_url(""), fallback);
    }

    #[test]
    fn effective_model_priority() {
        assert_eq!(effective_model("whisper-1"), "whisper-1");
        assert_eq!(effective_model(""), DEFAULT_ASR_MODEL);
        assert_eq!(effective_model("  "), DEFAULT_ASR_MODEL);
    }
}
