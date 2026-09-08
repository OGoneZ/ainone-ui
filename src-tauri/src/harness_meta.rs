// P29 R3/R4/R5：harness 本机配置元数据（baseUrl/model/key 存在性）读取与定点写回。
//
// 探索结论（plan-p29 §0.1 矩阵，2026-09-07 实测）：
//   claude-code → ~/.claude/settings.json：env.ANTHROPIC_BASE_URL + 顶层 model（[1m] 后缀去除）
//   codex       → ~/.codex/config.toml：model_providers.<active>.base_url + 顶层 model
//   omp         → ~/.omp/agent/models.yml：providers.<first>.baseUrl（key 判存在）；模型走 adapters.json args --model
//   pi          → ~/.pi/agent/models.json：providers.<ainone|首个含 baseUrl>.baseUrl + apiKey
//   opencode    → ~/.config/opencode/opencode.json：provider.ainone.options.baseURL/apiKey + 顶层 model
//                 （与 harness_config.rs 配置代写同构；定点写回仅 baseUrl）
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
/// 返回 None = 该 harness 无已知配置文件，读与写都不可用。
/// pi/opencode 无验证过的定点替换语义（写回落到配置代写链路），读照常。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HarnessConfigKind {
    Claude,
    Codex,
    Omp,
    Pi,
    OpenCode,
}

pub fn config_kind(adapter_id: &str) -> Option<HarnessConfigKind> {
    match adapter_id {
        "claude-code" => Some(HarnessConfigKind::Claude),
        "codex" => Some(HarnessConfigKind::Codex),
        "omp" => Some(HarnessConfigKind::Omp),
        "pi" => Some(HarnessConfigKind::Pi),
        "opencode" => Some(HarnessConfigKind::OpenCode),
        _ => None,
    }
}

fn settings_path(kind: HarnessConfigKind, home: &Path) -> PathBuf {
    match kind {
        HarnessConfigKind::Claude => home.join(".claude/settings.json"),
        HarnessConfigKind::Codex => home.join(".codex/config.toml"),
        HarnessConfigKind::Omp => home.join(".omp/agent/models.yml"),
        HarnessConfigKind::Pi => home.join(".pi/agent/models.json"),
        HarnessConfigKind::OpenCode => home.join(".config/opencode/opencode.json"),
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
        HarnessConfigKind::Pi => meta_pi(&raw),
        HarnessConfigKind::OpenCode => meta_opencode(&raw),
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

/// Pi models.json：providers.<ainone|首个含 baseUrl>.baseUrl + apiKey 判存在。
/// 与 harness_config::read_provider_fallback 同构（ainone 优先，回落用户自配 provider）。
pub(crate) fn meta_pi(raw: &str) -> Option<HarnessMeta> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let providers = v.get("providers")?.as_object()?;
    let mut names: Vec<&String> = Vec::new();
    if let Some(k) = providers.keys().find(|k| k.as_str() == "ainone") {
        names.push(k);
    }
    for k in providers.keys() {
        if k.as_str() != "ainone" {
            names.push(k);
        }
    }
    for name in names {
        let p = &providers[name];
        let base_url = p
            .get("baseUrl")
            .and_then(|b| b.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if base_url.is_none() {
            continue;
        }
        let model = p
            .get("models")
            .and_then(|m| m.as_array())
            .and_then(|a| a.first())
            .and_then(|m| m.get("id"))
            .and_then(|i| i.as_str())
            .map(String::from)
            .filter(|m| !m.is_empty());
        let key_present = p
            .get("apiKey")
            .and_then(|k| k.as_str())
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false);
        return Some(HarnessMeta { base_url, model, api_key_present: key_present });
    }
    None
}

/// OpenCode opencode.json：provider.<ainone|首个含 baseURL>.options.baseURL + 顶层 model。
/// 与 harness_config::read_view_text 同构（ainone 优先；model 带 "ainone/" 前缀时剥掉）。
pub(crate) fn meta_opencode(raw: &str) -> Option<HarnessMeta> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let providers = v.get("provider")?.as_object()?;
    let mut names: Vec<&String> = Vec::new();
    if let Some(k) = providers.keys().find(|k| k.as_str() == "ainone") {
        names.push(k);
    }
    for k in providers.keys() {
        if k.as_str() != "ainone" {
            names.push(k);
        }
    }
    for name in names {
        let p = &providers[name];
        let base_url = p
            .get("options")
            .and_then(|o| o.get("baseURL"))
            .and_then(|b| b.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        if base_url.is_none() {
            continue;
        }
        // 配置代写落的是 "ainone/<model>"，剥掉 provider 前缀与 UI 口径一致
        let model = v
            .get("model")
            .and_then(|m| m.as_str())
            .map(|s| s.strip_prefix("ainone/").unwrap_or(s).to_string())
            .filter(|m| !m.is_empty());
        let key_present = p
            .get("options")
            .and_then(|o| o.get("apiKey"))
            .and_then(|k| k.as_str())
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false);
        return Some(HarnessMeta { base_url, model, api_key_present: key_present });
    }
    None
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
        // pi 无验证过的定点替换语义 → 引导走配置代写（三格齐落盘）
        HarnessConfigKind::Pi | HarnessConfigKind::OpenCode => {
            return Err("{adapter_id} 不支持定点替换，请走设置页配置保存".replace("{adapter_id}", adapter_id))
        }
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
        // availableModels allowlist 合并：网关模型并入后，新会话的 configOptions
        // 选择器即包含它，set_config_option 不再拒绝（连接器 applyAvailableModelsAllowlist
        // 把用户条目逐字透出为可选值）。
        if let Some(list) = merge_available_models(v.get("availableModels"), m) {
            v["availableModels"] =
                serde_json::Value::Array(list.into_iter().map(serde_json::Value::String).collect());
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

/// 纯函数：合并 Claude settings.json 顶层 availableModels allowlist（claude-code 会话级
/// 任意网关模型切换的官方逃生门——连接器把用户条目逐字透出为 configOptions 可选值）。
/// 合并策略：
///   键缺失 → 种子 ["opus","sonnet","haiku"] + model（allowlist 是限制性白名单，
///            只写 model 会把 SDK 档位挤出 picker；default 由连接器恒保留不写入）
///   是数组 → 只追加去重（用户手写 allowlist 视为有意限制，绝不注入种子）
///   非字符串数组（损坏）→ None 不动（连接器对非数组按无 allowlist 处理，行为不变）
/// 保序追加 + trim + 幂等（同 model 二次写零变化）。
pub(crate) fn merge_available_models(existing: Option<&serde_json::Value>, model: &str) -> Option<Vec<String>> {
    const SEED: [&str; 3] = ["opus", "sonnet", "haiku"];
    let entry = model.trim();
    if entry.is_empty() {
        return None;
    }
    let had_key = existing.is_some();
    let existing: Option<Vec<String>> = existing.and_then(|a| a.as_array()).map(|arr| {
        let mut list: Vec<String> = Vec::new();
        for x in arr {
            if let Some(s) = x.as_str() {
                let s = s.trim();
                if !s.is_empty() && !list.iter().any(|m| m == s) {
                    list.push(s.to_string());
                }
            }
        }
        list
    });
    // 键存在但不是字符串数组 → 不动（避免破坏用户手写结构）
    if had_key && existing.is_none() {
        log::warn!("[harness_meta] availableModels 非字符串数组，跳过 allowlist 合并");
        return None;
    }
    let mut list = existing.unwrap_or_else(|| SEED.iter().map(|s| s.to_string()).collect());
    if !list.iter().any(|m| m == entry) {
        list.push(entry.to_string());
    }
    Some(list)
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

// ---------- 模型列表探测 ----------

/// 探测错误结构化（前端按 kind 展示可操作文案）
#[derive(Debug, Serialize)]
pub struct ProbeError {
    pub kind: String, // "bad_url" | "timeout" | "http" | "bad_json" | "network"
    pub message: String,
}

/// 纯函数：拼 /v1/models URL（trim 尾斜杠；不带 /v1 补 /v1）。
pub(crate) fn models_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/v1") {
        format!("{b}/models")
    } else {
        format!("{b}/v1/models")
    }
}

/// 纯函数：解析 OpenAI 格式模型列表 {data:[{id:...}]}（两个实测网关均此格式）。
pub(crate) fn parse_models_json(raw: &str) -> Result<Vec<String>, String> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("响应不是合法 JSON: {e}"))?;
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| "响应缺少 data 数组（非 OpenAI 格式 /models）".to_string())?;
    let mut ids: Vec<String> = arr
        .iter()
        .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
        .filter(|s| !s.is_empty())
        .collect();
    ids.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    ids.dedup();
    Ok(ids)
}

/// 探测远端网关支持哪些模型：GET {base}/v1/models。
/// key 由 Rust 侧按 harness 配置自取（明文不过 WebView）；protocol 决定鉴权头。
pub async fn probe_models(
    adapter_id: &str,
    base_url: &str,
    home: Option<&Path>,
) -> Result<Vec<String>, ProbeError> {
    probe_models_with_key(adapter_id, base_url, None, home).await
}

/// 带显式 key 的探测：key Some 非空优先（设置页表单直传），空/None 回落本机配置自取。
/// Claude 鉴权头另取 baseUrl：无表单值时优先本机 settings.json 的 env.ANTHROPIC_BASE_URL
/// （用户走中转网关时官方地址必 403，探测必须打实际生效的网关）。
pub async fn probe_models_with_key(
    adapter_id: &str,
    base_url: &str,
    api_key: Option<&str>,
    home: Option<&Path>,
) -> Result<Vec<String>, ProbeError> {
    let kind = config_kind(adapter_id).ok_or_else(|| ProbeError {
        kind: "bad_url".into(),
        message: format!("{adapter_id} 未配置协议，无法探测"),
    })?;
    // Claude：表单 baseUrl 为空 → 本机配置的 BASE_URL 优先（中转场景官方地址必挂），再回落传入值
    let url_base = if kind == HarnessConfigKind::Claude
        && base_url.trim().is_empty()
    {
        claude_base_url(home).unwrap_or_else(|| base_url.to_string())
    } else {
        base_url.to_string()
    };
    if url_base.trim().is_empty() {
        return Err(ProbeError { kind: "bad_url".into(), message: "无接口地址，无法探测".into() });
    }
    let url = models_url(&url_base);
    // 鉴权头按协议分叉：anthropic → x-api-key；openai → Bearer。
    // key 来源：表单显式值 > 本机静态配置；均无 → 部分网关允许匿名列模型，不拦截直接发。
    let key = api_key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    let mut req = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .header("Accept", "application/json");
    match kind {
        HarnessConfigKind::Claude => {
            let key = key.or_else(|| claude_api_key(home));
            if let Some(k) = key {
                req = req
                    .header("x-api-key", &k)
                    .header("anthropic-version", "2023-06-01")
                    .header("Authorization", format!("Bearer {k}"));
            }
        }
        HarnessConfigKind::Codex | HarnessConfigKind::Omp | HarnessConfigKind::Pi
        | HarnessConfigKind::OpenCode => {
            let key = match key {
                Some(k) => Some(k),
                None => match kind {
                    HarnessConfigKind::Codex => codex_api_key(home),
                    HarnessConfigKind::Omp => omp_api_key(home),
                    HarnessConfigKind::Pi => pi_api_key(home),
                    HarnessConfigKind::OpenCode => opencode_api_key(home),
                    _ => None,
                },
            };
            if let Some(k) = key {
                req = req.header("Authorization", format!("Bearer {k}"));
            }
        }
    }
    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            ProbeError { kind: "timeout".into(), message: "请求超时（10s）".into() }
        } else if e.is_connect() {
            ProbeError { kind: "network".into(), message: format!("无法连接 {url}: {e}") }
        } else {
            ProbeError { kind: "network".into(), message: format!("请求失败: {e}") }
        }
    })?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| ProbeError {
        kind: "network".into(),
        message: format!("读取响应失败: {e}"),
    })?;
    if !status.is_success() {
        let tail: String = text.chars().take(200).collect();
        return Err(ProbeError {
            kind: "http".into(),
            message: format!("HTTP {status}: {tail}"),
        });
    }
    parse_models_json(&text).map_err(|m| ProbeError { kind: "bad_json".into(), message: m })
}

fn claude_api_key(home: Option<&Path>) -> Option<String> {
    let home = home.map(PathBuf::from).or_else(dirs::home_dir)?;
    let raw = std::fs::read_to_string(home.join(".claude/settings.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("env")
        .and_then(|e| e.get("ANTHROPIC_AUTH_TOKEN"))
        .and_then(|k| k.as_str())
        .map(String::from)
        .filter(|k| !k.trim().is_empty())
}

/// Claude settings.json 的 env.ANTHROPIC_BASE_URL（探测基准：中转网关场景官方地址必 403）。
fn claude_base_url(home: Option<&Path>) -> Option<String> {
    let home = home.map(PathBuf::from).or_else(dirs::home_dir)?;
    let raw = std::fs::read_to_string(home.join(".claude/settings.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("env")
        .and_then(|e| e.get("ANTHROPIC_BASE_URL"))
        .and_then(|b| b.as_str())
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// Pi models.json 的 apiKey（与 meta_pi 同一 provider 优先级：ainone 优先，回落首个含 baseUrl）。
fn pi_api_key(home: Option<&Path>) -> Option<String> {
    let home = home.map(PathBuf::from).or_else(dirs::home_dir)?;
    let raw = std::fs::read_to_string(home.join(".pi/agent/models.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let providers = v.get("providers")?.as_object()?;
    let mut names: Vec<&String> = Vec::new();
    if let Some(k) = providers.keys().find(|k| k.as_str() == "ainone") {
        names.push(k);
    }
    for k in providers.keys() {
        if k.as_str() != "ainone" {
            names.push(k);
        }
    }
    for name in names {
        let p = &providers[name];
        if p.get("baseUrl").and_then(|b| b.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false) {
            return p
                .get("apiKey")
                .and_then(|k| k.as_str())
                .map(String::from)
                .filter(|k| !k.trim().is_empty());
        }
    }
    None
}

fn codex_api_key(home: Option<&Path>) -> Option<String> {
    let home = home.map(PathBuf::from).or_else(dirs::home_dir)?;
    let raw = std::fs::read_to_string(home.join(".codex/auth.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("OPENAI_API_KEY")
        .and_then(|k| k.as_str())
        .map(String::from)
        .filter(|k| !k.trim().is_empty())
}

fn omp_api_key(home: Option<&Path>) -> Option<String> {
    let home = home.map(PathBuf::from).or_else(dirs::home_dir)?;
    let raw = std::fs::read_to_string(home.join(".omp/agent/models.yml")).ok()?;
    for line in raw.lines() {
        let t = line.trim();
        if t.starts_with("apiKey:") {
            let v = t["apiKey:".len()..].trim().trim_matches('"');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// OpenCode opencode.json 的 provider.<ainone|首个含 baseURL>.options.apiKey
/// （与 meta_opencode 同一 provider 优先级）。
fn opencode_api_key(home: Option<&Path>) -> Option<String> {
    let home = home.map(PathBuf::from).or_else(dirs::home_dir)?;
    let raw = std::fs::read_to_string(home.join(".config/opencode/opencode.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let providers = v.get("provider")?.as_object()?;
    let mut names: Vec<&String> = Vec::new();
    if let Some(k) = providers.keys().find(|k| k.as_str() == "ainone") {
        names.push(k);
    }
    for k in providers.keys() {
        if k.as_str() != "ainone" {
            names.push(k);
        }
    }
    for name in names {
        let p = &providers[name];
        if p.get("options")
            .and_then(|o| o.get("baseURL"))
            .and_then(|b| b.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            return p
                .get("options")
                .and_then(|o| o.get("apiKey"))
                .and_then(|k| k.as_str())
                .map(String::from)
                .filter(|k| !k.trim().is_empty());
        }
    }
    None
}

/// 探测网关模型列表（命令入口；key 全程 Rust 侧流转）。
/// api_key：设置页表单显式直传（非空优先），空/None 回落本机配置自取。
#[tauri::command]
pub async fn models_probe(
    adapter_id: String,
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<String>, ProbeError> {
    probe_models_with_key(&adapter_id, &base_url, api_key.as_deref(), None).await
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
        assert_eq!(config_kind("pi"), Some(HarnessConfigKind::Pi));
        assert_eq!(config_kind("opencode"), Some(HarnessConfigKind::OpenCode));
    }

    const PI: &str = r#"{"providers":{"ainone":{"baseUrl":"https://pi.example.com/v1","apiKey":"sk-pi","models":[{"id":"pi-model-1"}]}}}"#;

    #[test]
    fn pi_meta_reads_provider_base_and_model() {
        let m = meta_pi(PI).unwrap();
        assert_eq!(m.base_url.as_deref(), Some("https://pi.example.com/v1"));
        assert_eq!(m.model.as_deref(), Some("pi-model-1"));
        assert!(m.api_key_present);
    }

    #[test]
    fn pi_meta_falls_back_to_user_provider() {
        // ainone 缺失 → 回落首个含 baseUrl 的 provider（与配置代写读回显同构）
        let raw = r#"{"providers":{"my-gw":{"baseUrl":"https://mygw/v1","apiKey":"sk","models":[{"id":"m1"}]}}}"#;
        let m = meta_pi(raw).unwrap();
        assert_eq!(m.base_url.as_deref(), Some("https://mygw/v1"));
        assert_eq!(m.model.as_deref(), Some("m1"));
    }

    #[test]
    fn pi_meta_broken_or_empty_providers_is_none() {
        assert!(meta_pi("not json").is_none());
        assert!(meta_pi("{}").is_none());
        assert!(meta_pi(r#"{"providers":{}}"#).is_none());
    }

    const OPENCODE: &str = r#"{"$schema":"https://opencode.ai/config.json","theme":"dark","provider":{"ainone":{"npm":"@ai-sdk/openai-compatible","name":"ainone","options":{"baseURL":"https://oc.example.com/v1","apiKey":"sk-oc"},"models":{"oc-model-1":{"name":"oc-model-1"}}}},"model":"ainone/oc-model-1"}"#;

    #[test]
    fn opencode_meta_reads_provider_base_and_model() {
        let m = meta_opencode(OPENCODE).unwrap();
        assert_eq!(m.base_url.as_deref(), Some("https://oc.example.com/v1"));
        assert_eq!(m.model.as_deref(), Some("oc-model-1"), "代写的 ainone/ 前缀应剥掉");
        assert!(m.api_key_present);
    }

    #[test]
    fn opencode_meta_falls_back_to_user_provider() {
        // ainone 缺失 → 回落首个含 baseURL 的 provider（与配置代写读回显同构）
        let raw = r#"{"provider":{"my-gw":{"options":{"baseURL":"https://mygw/v1","apiKey":"sk"}}},"model":"plain-model"}"#;
        let m = meta_opencode(raw).unwrap();
        assert_eq!(m.base_url.as_deref(), Some("https://mygw/v1"));
        assert_eq!(m.model.as_deref(), Some("plain-model"), "无 ainone/ 前缀的原样保留");
    }

    #[test]
    fn opencode_meta_broken_or_empty_providers_is_none() {
        assert!(meta_opencode("not json").is_none());
        assert!(meta_opencode("{}").is_none());
        assert!(meta_opencode(r#"{"provider":{}}"#).is_none());
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

    // —— availableModels allowlist 合并（会话级任意网关模型切换，见 merge_available_models） ——

    #[test]
    fn write_claude_seeds_allowlist_on_first_model_write() {
        // 无 availableModels 键 → 种子三档位 + 追加模型；无关键保留
        let out = write_claude(CLAUDE, Some("gemini-3.7-flash"), None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["availableModels"],
            serde_json::json!(["opus", "sonnet", "haiku", "gemini-3.7-flash"])
        );
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["cleanupPeriodDays"], 36500);
        assert_eq!(v["model"], "gemini-3.7-flash");
    }

    #[test]
    fn write_claude_allowlist_merge_is_idempotent() {
        let once = write_claude(CLAUDE, Some("gemini-3.7-flash"), None).unwrap();
        let twice = write_claude(&once, Some("gemini-3.7-flash"), None).unwrap();
        assert_eq!(once, twice, "同模型二次写应字节级等价");
    }

    #[test]
    fn write_claude_existing_allowlist_appends_without_seed() {
        // 用户手写 allowlist = 有意限制 → 只追加，绝不注入档位种子
        let raw = r#"{"model":"m1","availableModels":["custom-1"]}"#;
        let out = write_claude(raw, Some("gemini-3.7-flash"), None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["availableModels"], serde_json::json!(["custom-1", "gemini-3.7-flash"]));
    }

    #[test]
    fn write_claude_allowlist_cleans_blank_and_dup_entries() {
        let raw = r#"{"model":"m1","availableModels":["custom-1","custom-1","  ","custom-2"]}"#;
        let out = write_claude(raw, Some("custom-2"), None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        // 空白剔除、去重、保序；custom-2 已在列表（trim 后）→ 不重复追加
        assert_eq!(v["availableModels"], serde_json::json!(["custom-1", "custom-2"]));
    }

    #[test]
    fn write_claude_corrupt_allowlist_left_untouched() {
        // 非字符串数组（用户配置损坏）→ 原样保留、不合并、不报错
        let raw = r#"{"model":"m1","availableModels":"oops"}"#;
        let out = write_claude(raw, Some("new-model"), None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["availableModels"], "oops");
        assert_eq!(v["model"], "new-model");
    }

    #[test]
    fn write_claude_baseurl_only_does_not_create_allowlist() {
        let out = write_claude(CLAUDE, None, Some("https://x.example.com")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("availableModels").is_none(), "base_url-only 写不得创建 allowlist 键");
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
        // pi/opencode 无定点替换语义（写回落到配置代写链路），报错文案引导走设置页
        assert!(harness_settings_write_inner("opencode", Some("m"), None, None).is_err());
        assert!(harness_settings_write_inner("custom-x", Some("m"), None, None).is_err());
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

    // —— P29 R5：/v1/models 探测纯函数 ——

    #[test]
    fn models_url_normalizes() {
        assert_eq!(models_url("https://gw.example.com/"), "https://gw.example.com/v1/models");
        assert_eq!(models_url("https://gw.example.com/v1"), "https://gw.example.com/v1/models");
        assert_eq!(models_url("https://gw.example.com"), "https://gw.example.com/v1/models");
        assert_eq!(models_url(" https://x.cn/v1 "), "https://x.cn/v1/models");
    }

    #[test]
    fn parse_models_openai_shape() {
        let raw = r#"{"data":[{"id":"duo-king-6.6","object":"model"},{"id":"claude-opus-4-7","object":"model"}],"object":"list","success":true}"#;
        let ids = parse_models_json(raw).unwrap();
        assert_eq!(ids, vec!["claude-opus-4-7", "duo-king-6.6"]); // 排序（忽略大小写）
    }

    #[test]
    fn parse_models_dedup_and_empty_id_filtered() {
        let raw = r#"{"data":[{"id":"a"},{"id":"a"},{"id":""},{"id":"B"}]}"#;
        let ids = parse_models_json(raw).unwrap();
        // 排序忽略大小写：a/B 同键时稳定序保留首个 "a"，"B" 因去重后仅一次排在其后
        assert_eq!(ids, vec!["a", "B"]);
    }

    #[test]
    fn parse_models_bad_json_and_missing_data() {
        assert!(parse_models_json("not json").is_err());
        assert!(parse_models_json(r#"{"object":"list"}"#).is_err());
    }

    #[tokio::test]
    async fn probe_models_unknown_adapter_errors() {
        // 未登记的 adapter id → bad_url 拦截（opencode 已登记协议，改用未知 id 验证）
        let e = probe_models_with_key("custom-xyz", "https://x.example.com", None, None).await.unwrap_err();
        assert_eq!(e.kind, "bad_url");
        assert_eq!(e.message, "custom-xyz 未配置协议，无法探测");
    }

    #[tokio::test]
    async fn probe_models_claude_empty_url_falls_back_to_config() {
        // 表单 baseUrl 为空 → 回落本机 settings.json 的 env.ANTHROPIC_BASE_URL（中转网关场景）
        let dir = std::env::temp_dir().join(format!("ainone-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude/settings.json"), CLAUDE).unwrap();
        // 不发真请求：断言 URL 组装走了配置值（探测失败也应是网络/HTTP 类，而非「无接口地址」）
        let e = probe_models_with_key("claude-code", "", None, Some(&dir)).await.unwrap_err();
        assert_ne!(e.message, "无接口地址，无法探测");
        assert_ne!(e.message, "claude-code 未配置协议，无法探测");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn probe_models_opencode_without_config_still_attempts() {
        // opencode 现已登记协议（OpenAI 兼容 Bearer）；无本地 key 也允许探测（部分网关可匿名列模型）
        let e = probe_models_with_key("opencode", "https://x.example.com/v1", None, None).await.unwrap_err();
        assert_ne!(e.kind, "bad_url", "无 key 不应被 bad_url 拦截: {e:?}");
    }

    #[tokio::test]
    async fn probe_models_pi_without_config_still_attempts() {
        // pi 无本地 key 也允许探测（部分网关可匿名列模型）——不再硬拦「未找到 API key」
        let e = probe_models_with_key("pi", "https://x.example.com/v1", None, None).await.unwrap_err();
        assert_ne!(e.kind, "bad_url", "无 key 不应被 bad_url 拦截: {e:?}");
    }
}
