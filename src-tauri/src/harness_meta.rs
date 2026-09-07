// P29 R3/R4/R5：harness 本机配置元数据（baseUrl/model/key 存在性）读取与定点写回。
//
// 探索结论（plan-p29 §0.1 矩阵，2026-09-07 实测）：
//   claude-code → ~/.claude/settings.json：env.ANTHROPIC_BASE_URL + 顶层 model（[1m] 后缀去除）
//   codex       → ~/.codex/config.toml：model_providers.<active>.base_url + 顶层 model
//   omp         → ~/.omp/agent/models.yml：providers.<first>.baseUrl（key 判存在）；模型走 adapters.json args --model
//   pi/opencode → 无验证过的单文件配置：返回 None（UI 只读，不写回）
//
// 密钥纪律（与 quickask.rs 一致）：apiKey 只判存在性（api_key_present），明文不回传 WebView。
// 写回：文本锚定定点替换（JSON 走 serde_json 定点字段、TOML/YML 走行级替换），
// 写前生成 <file>.ainone-bak 备份；其余内容（含注释）逐字节保留。

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HarnessMeta {
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// 配置里存在 API key（明文不回传，仅提示「已配置」）
    pub api_key_present: bool,
}

/// 适配器 id → 支持读取/写回的配置种类。
/// 返回 None = 该 harness 无验证过的配置文件（pi/opencode），读与写都不可用。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HarnessConfigKind {
    Claude,
    Codex,
    Omp,
}

pub fn config_kind(adapter_id: &str) -> Option<HarnessConfigKind> {
    match adapter_id {
        "claude-code" => Some(HarnessConfigKind::Claude),
        "codex" => Some(HarnessConfigKind::Codex),
        "omp" => Some(HarnessConfigKind::Omp),
        _ => None,
    }
}

fn settings_path(kind: HarnessConfigKind, home: &Path) -> PathBuf {
    match kind {
        HarnessConfigKind::Claude => home.join(".claude/settings.json"),
        HarnessConfigKind::Codex => home.join(".codex/config.toml"),
        HarnessConfigKind::Omp => home.join(".omp/agent/models.yml"),
    }
}

// ---------- 命令 ----------

/// 读 harness 静态配置元数据（baseUrl/model/key 存在性；key 明文不回传）。
#[tauri::command]
pub fn harness_meta(adapter_id: String) -> Option<HarnessMeta> {
    let m = harness_meta_inner(&adapter_id, None);
    log::debug!("[harness_meta] {adapter_id} → {:?}", m.as_ref().map(|m| (&m.base_url, &m.model)));
    m
}

/// 定点写回 harness 配置（model/baseUrl；写前备份）。
#[tauri::command]
pub fn harness_settings_write(
    adapter_id: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<WriteOutcome, String> {
    harness_settings_write_inner(&adapter_id, model.as_deref(), base_url.as_deref(), None)
}

// ---------- 读取 ----------

/// 读 harness 静态配置（home 注入便于测试；生产传 None 用 dirs::home_dir()）。
pub(crate) fn harness_meta_inner(adapter_id: &str, home: Option<&Path>) -> Option<HarnessMeta> {
    let kind = config_kind(adapter_id)?;
    let home = match home {
        Some(h) => PathBuf::from(h),
        None => dirs::home_dir()?,
    };
    let path = settings_path(kind, &home);
    let raw = std::fs::read_to_string(&path).ok()?;
    match kind {
        HarnessConfigKind::Claude => meta_claude(&raw),
        HarnessConfigKind::Codex => meta_codex(&raw),
        HarnessConfigKind::Omp => meta_omp(&raw),
    }
}

/// Claude settings.json：env.ANTHROPIC_BASE_URL / model（去 [1m]）；key 看 ANTHROPIC_AUTH_TOKEN。
pub(crate) fn meta_claude(raw: &str) -> Option<HarnessMeta> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let base = v
        .get("env")
        .and_then(|e| e.get("ANTHROPIC_BASE_URL"))
        .and_then(|b| b.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    // 模型：顶层 model 优先（会话默认即它）；DEFAULT_*_MODEL 是档位映射，不取
    let model = v
        .get("model")
        .and_then(|m| m.as_str())
        .map(crate::harness_probe::strip_model_suffix)
        .filter(|m| !m.is_empty());
    let key_present = v
        .get("env")
        .and_then(|e| e.get("ANTHROPIC_AUTH_TOKEN"))
        .and_then(|k| k.as_str())
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);
    Some(HarnessMeta { base_url: base, model, api_key_present: key_present })
}

/// Codex config.toml：model_providers.<active>.base_url + 顶层 model；key 看 ~/.codex/auth.json。
pub(crate) fn meta_codex(toml_raw: &str) -> Option<HarnessMeta> {
    let cfg: toml::Value = toml::from_str(toml_raw).ok()?;
    let base_url = {
        let active = cfg
            .get("model_provider")
            .and_then(|p| p.as_str())
            .map(String::from)
            .or_else(|| {
                cfg.get("model_providers")
                    .and_then(|p| p.as_table())
                    .and_then(|t| t.keys().next().cloned())
            })?;
        cfg.get("model_providers")
            .and_then(|p| p.get(&active))
            .and_then(|p| p.get("base_url"))
            .and_then(|b| b.as_str())
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
    };
    let model = cfg
        .get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let key_present = std::fs::read_to_string(dirs::home_dir()?.join(".codex/auth.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .map(|v| {
            v.get("OPENAI_API_KEY")
                .and_then(|k| k.as_str())
                .map(|k| !k.trim().is_empty())
                .unwrap_or(false)
        })
        .unwrap_or(false);
    Some(HarnessMeta { base_url, model, api_key_present: key_present })
}

/// Omp models.yml：providers.<first>.baseUrl + apiKey 判存在；模型不在 yml（args --model）。
/// 纯文本行级解析（引 yml 库只为此一处不值得；锚定 `baseUrl:` 与 `apiKey:` 行）。
pub(crate) fn meta_omp(raw: &str) -> Option<HarnessMeta> {
    let mut base_url = None;
    let mut key_present = false;
    for line in raw.lines() {
        let t = line.trim();
        if base_url.is_none() && t.starts_with("baseUrl:") {
            let v = t["baseUrl:".len()..].trim().trim_matches('"').to_string();
            if !v.is_empty() {
                base_url = Some(v);
            }
        }
        if t.starts_with("apiKey:") {
            let v = t["apiKey:".len()..].trim().trim_matches('"');
            if !v.is_empty() {
                key_present = true;
            }
        }
    }
    Some(HarnessMeta { base_url, model: None, api_key_present: key_present })
}

// ---------- 写回 ----------

pub(crate) const BAK_SUFFIX: &str = ".ainone-bak";

/// 写回前的文本备份（同目录 <name>.ainone-bak；已有备份不覆盖——首次写前的原始态最珍贵）。
pub(crate) fn backup(path: &Path) -> Result<(), String> {
    let bak = path.with_file_name(format!(
        "{}{BAK_SUFFIX}",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
    ));
    if bak.exists() {
        return Ok(());
    }
    std::fs::copy(path, &bak).map_err(|e| format!("备份失败 {bak:?}: {e}"))?;
    log::info!("[harness_meta] 已备份 {:?}", bak);
    Ok(())
}

/// 写回结果：改了哪个文件、备份在哪（UI toast 用）。
#[derive(Debug, Serialize)]
pub struct WriteOutcome {
    pub path: String,
    pub backup: String,
}

/// 定点写回 model / baseUrl（Option 均为 None = 无事可做返回错误）。
pub(crate) fn harness_settings_write_inner(
    adapter_id: &str,
    model: Option<&str>,
    base_url: Option<&str>,
    home: Option<&Path>,
) -> Result<WriteOutcome, String> {
    if model.is_none() && base_url.is_none() {
        return Err("没有要写回的内容".into());
    }
    let kind = config_kind(adapter_id)
        .ok_or_else(|| format!("{adapter_id} 无验证过的配置文件，不支持写回"))?;
    let home = match home {
        Some(h) => PathBuf::from(h),
        None => dirs::home_dir().ok_or("找不到家目录")?,
    };
    let path = settings_path(kind, &home);
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let updated = match kind {
        HarnessConfigKind::Claude => write_claude(&raw, model, base_url)?,
        HarnessConfigKind::Codex => write_codex(&raw, model, base_url)?,
        HarnessConfigKind::Omp => write_omp(&raw, base_url)?,
    };
    backup(&path)?;
    std::fs::write(&path, updated).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    log::info!(
        "[harness_meta] 写回 {adapter_id}: model={:?} baseUrl={:?}",
        model,
        base_url
    );
    Ok(WriteOutcome {
        path: path.to_string_lossy().into_owned(),
        backup: path
            .with_file_name(format!(
                "{}{BAK_SUFFIX}",
                path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
            ))
            .to_string_lossy()
            .into_owned(),
    })
}

/// Claude settings.json：serde_json 定点改写 model / env.ANTHROPIC_BASE_URL，其余键序结构不变
/// （serde_json::Value 保序（preserve_order 未开时按 BTreeMap——为保序这里走定点文本替换）。
pub(crate) fn write_claude(raw: &str, model: Option<&str>, base_url: Option<&str>) -> Result<String, String> {
    let mut v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("settings.json 解析失败: {e}"))?;
    if let Some(m) = model {
        v["model"] = serde_json::Value::String(m.to_string());
        // DEFAULT_*_MODEL 存在时同步（它们优先级更高，不同步会「改了没生效」）
        if let Some(env) = v.get_mut("env").and_then(|e| e.as_object_mut()) {
            for key in [
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
            ] {
                if env.contains_key(key) {
                    env.insert(key.to_string(), serde_json::Value::String(m.to_string()));
                }
            }
        }
    }
    if let Some(b) = base_url {
        if let Some(env) = v.get_mut("env").and_then(|e| e.as_object_mut()) {
            if env.contains_key("ANTHROPIC_BASE_URL") {
                env.insert("ANTHROPIC_BASE_URL".into(), serde_json::Value::String(b.to_string()));
            } else {
                return Err("settings.json 无 env.ANTHROPIC_BASE_URL，无法定点改写".into());
            }
        } else {
            return Err("settings.json 无 env 表，无法定点改写".into());
        }
    }
    serde_json::to_string_pretty(&v).map_err(|e| format!("settings.json 序列化失败: {e}"))
}

/// Codex config.toml：行级锚定替换顶层 `model =` 与该 provider 的 `base_url =`，注释全保留。
pub(crate) fn write_codex(raw: &str, model: Option<&str>, base_url: Option<&str>) -> Result<String, String> {
    let mut out: Vec<String> = Vec::new();
    let mut model_done = model.is_none();
    // base_url 锚定在 [model_providers.*] 段内（顶层出现的不动）
    let mut in_provider_table = false;
    let mut base_done = base_url.is_none();
    for line in raw.lines() {
        let t = line.trim_start();
        let mut replaced = line.to_string();
        if t.starts_with('[') {
            in_provider_table = t.starts_with("[model_providers.");
        } else if !model_done && (t.starts_with("model ") || t.starts_with("model=")) {
            if let Some(m) = model {
                replaced = format!("model = \"{m}\"");
                model_done = true;
            }
        } else if in_provider_table && !base_done && t.starts_with("base_url") {
            if let Some(b) = base_url {
                replaced = format!("base_url = \"{b}\"");
                base_done = true;
            }
        }
        out.push(replaced);
    }
    if !model_done {
        return Err("config.toml 未找到顶层 model 行".into());
    }
    if !base_done {
        return Err("config.toml 未找到 model_providers 的 base_url 行".into());
    }
    let mut s = out.join("\n");
    if raw.ends_with('\n') {
        s.push('\n');
    }
    Ok(s)
}

/// Omp models.yml：行级替换首个 `baseUrl:` 行（providers 段内；本仓只此一处 baseUrl 行的场景）。
pub(crate) fn write_omp(raw: &str, base_url: Option<&str>) -> Result<String, String> {
    let b = base_url.ok_or("omp 仅支持写回 baseUrl")?;
    let mut out: Vec<String> = Vec::new();
    let mut done = false;
    for line in raw.lines() {
        if !done && line.trim_start().starts_with("baseUrl:") {
            out.push(format!("    baseUrl: {b}"));
            done = true;
        } else {
            out.push(line.to_string());
        }
    }
    if !done {
        return Err("models.yml 未找到 baseUrl 行".into());
    }
    let mut s = out.join("\n");
    if raw.ends_with('\n') {
        s.push('\n');
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = r#"{
  "cleanupPeriodDays": 36500,
  "env": {
    "ANTHROPIC_BASE_URL": "https://old.example.com/",
    "ANTHROPIC_AUTH_TOKEN": "sk-test",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "saver/glm-5.3-flash"
  },
  "model": "saver/glm-5.3-flash[1m]",
  "theme": "dark"
}"#;

    const CODEX: &str = r#"model_provider = "codex"
model = "gpt-5.4" #可更改为model = "gpt-5.4"
model_reasoning_effort = "high"

[model_providers.codex]
name = "codex"
base_url = "https://codex.old.cn/v1"
wire_api = "responses"
"#;

    const OMP: &str = r#"providers:
  zhubaoduo:
    type: openai
    api: openai-completions
    baseUrl: https://token.old.com/v1
    apiKey: sk-xxx
    models:
      - id: duo-king-6.6
        context: 128000
"#;

    #[test]
    fn claude_meta_reads_base_model_key() {
        let m = meta_claude(CLAUDE).unwrap();
        assert_eq!(m.base_url.as_deref(), Some("https://old.example.com/"));
        assert_eq!(m.model.as_deref(), Some("saver/glm-5.3-flash")); // [1m] 已去
        assert!(m.api_key_present);
    }

    #[test]
    fn claude_meta_broken_json_returns_none() {
        // 损坏 JSON = 配置不可信 → None（UI 降级到其他来源，不显示编造值）
        assert!(meta_claude("not json").is_none());
        let m = meta_claude("{}").unwrap();
        assert_eq!(m.base_url, None);
        assert_eq!(m.model, None);
        assert!(!m.api_key_present);
    }

    #[test]
    fn codex_meta_reads_provider_base_and_model() {
        let m = meta_codex(CODEX).unwrap();
        assert_eq!(m.base_url.as_deref(), Some("https://codex.old.cn/v1"));
        assert_eq!(m.model.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn omp_meta_reads_base_and_key() {
        let m = meta_omp(OMP).unwrap();
        assert_eq!(m.base_url.as_deref(), Some("https://token.old.com/v1"));
        assert_eq!(m.model, None);
        assert!(m.api_key_present);
    }

    #[test]
    fn config_kind_matrix() {
        assert_eq!(config_kind("claude-code"), Some(HarnessConfigKind::Claude));
        assert_eq!(config_kind("codex"), Some(HarnessConfigKind::Codex));
        assert_eq!(config_kind("omp"), Some(HarnessConfigKind::Omp));
        assert_eq!(config_kind("pi"), None);
        assert_eq!(config_kind("opencode"), None);
    }

    #[test]
    fn write_claude_updates_model_and_defaults() {
        let out = write_claude(CLAUDE, Some("saver/new-model"), Some("https://new.example.com/")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], "saver/new-model");
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://new.example.com/");
        // DEFAULT_*（存在时）同步
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "saver/new-model");
        // 无关字段保留
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["cleanupPeriodDays"], 36500);
    }

    #[test]
    fn write_codex_preserves_comments_and_structure() {
        let out = write_codex(CODEX, Some("gpt-5.6"), Some("https://codex.new.cn/v1")).unwrap();
        assert!(out.contains("model = \"gpt-5.6\""));
        assert!(out.contains("base_url = \"https://codex.new.cn/v1\""));
        // 行级替换只动目标行：目标行尾注释随行被替换（可接受——该行本来就是 model 赋值行），
        // 但其余行（reasoning/wire_api/model_provider）与结构必须逐字节保留
        assert!(out.contains("model_reasoning_effort = \"high\""));
        assert!(out.contains("wire_api = \"responses\""));
        assert!(out.starts_with("model_provider = \"codex\""));
        assert!(!out.contains("gpt-5.4")); // 旧值（含注释里的）已随行替换
    }

    #[test]
    fn write_omp_replaces_base_url_line() {
        let out = write_omp(OMP, Some("https://token.new.com/v1")).unwrap();
        assert!(out.contains("baseUrl: https://token.new.com/v1"));
        assert!(!out.contains("token.old.com"));
        // 无关行保留
        assert!(out.contains("apiKey: sk-xxx"));
        assert!(out.contains("- id: duo-king-6.6"));
    }

    #[test]
    fn write_requires_target_and_kind() {
        assert!(harness_settings_write_inner("omp", None, None, None).is_err());
        assert!(harness_settings_write_inner("pi", Some("m"), None, None).is_err());
    }

    #[test]
    fn write_claude_missing_env_base_errors() {
        let raw = r#"{"model":"m"}"#;
        assert!(write_claude(raw, None, Some("https://x.com")).is_err());
    }

    #[test]
    fn end_to_end_write_with_backup() {
        let dir = std::env::temp_dir().join(format!("ainone-hmeta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        let p = dir.join(".claude/settings.json");
        std::fs::write(&p, CLAUDE).unwrap();
        let r = harness_settings_write_inner("claude-code", Some("saver/n2"), None, Some(&dir)).unwrap();
        assert!(r.backup.ends_with(".ainone-bak"));
        // 备份内容 = 原始
        assert_eq!(std::fs::read_to_string(p.with_file_name("settings.json.ainone-bak")).unwrap(), CLAUDE);
        // 新值生效
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["model"], "saver/n2");
        // 二次写不覆盖首次备份
        harness_settings_write_inner("claude-code", Some("saver/n3"), None, Some(&dir)).unwrap();
        assert_eq!(std::fs::read_to_string(p.with_file_name("settings.json.ainone-bak")).unwrap(), CLAUDE);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn end_to_end_codex_and_omp() {
        let dir = std::env::temp_dir().join(format!("ainone-hmeta2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".codex")).unwrap();
        std::fs::create_dir_all(dir.join(".omp/agent")).unwrap();
        std::fs::write(dir.join(".codex/config.toml"), CODEX).unwrap();
        std::fs::write(dir.join(".omp/agent/models.yml"), OMP).unwrap();
        let r = harness_settings_write_inner("codex", Some("gpt-5.6"), None, Some(&dir)).unwrap();
        assert!(r.path.ends_with("config.toml"));
        let r = harness_settings_write_inner("omp", None, Some("https://n.example.com/v1"), Some(&dir)).unwrap();
        assert!(r.path.ends_with("models.yml"));
        assert!(std::fs::read_to_string(dir.join(".omp/agent/models.yml")).unwrap().contains("n.example.com"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
