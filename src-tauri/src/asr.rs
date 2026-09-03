// P9 · F-9-5 语音输入：音频上传自建 ASR 服务端转写。
//
// 客户端只做「录音（前端）+ 上传（本命令）」；ASR 模型本身在服务端。
// 服务端为 OpenAI 兼容 audio/transcriptions 格式（multipart：file + model）。
// 地址默认 https://asr.zhubaoduo.com/v1/audio/transcriptions，可用环境变量
// AINONE_ASR_URL 覆盖（内网部署无鉴权）。

use std::time::Duration;

pub const DEFAULT_ASR_URL: &str = "https://asr.zhubaoduo.com/v1/audio/transcriptions";
pub const DEFAULT_ASR_MODEL: &str = "mano-asr";

fn asr_url() -> String {
    std::env::var("AINONE_ASR_URL").unwrap_or_else(|_| DEFAULT_ASR_URL.to_string())
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
pub async fn transcribe_audio(data: Vec<u8>, filename: String, model: String) -> Result<String, String> {
    let url = asr_url();
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
    let resp = match client.post(&url).multipart(form).send().await {
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

/// Tauri command：语音转写入口（前端传音频字节 + 文件名，返回转写文本）。
#[tauri::command]
pub async fn asr_transcribe(data: Vec<u8>, filename: String) -> Result<String, String> {
    transcribe_audio(data, filename, DEFAULT_ASR_MODEL.to_string()).await
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
}
