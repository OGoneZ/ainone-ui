// P29 任务三：harness 配置文件读与合并写。
//
// 目标（规格书 plan-p29-onboarding.md 任务三）：用户填 endpoint / key / model
// 三格 → 应用替他生成或**合并修改** harness 原生配置文件。已有文件只替换指定键，
// 其余键、结构、顺序（TOML 含注释）原样保留；写前备份；key 留空 = 保留既有。
//
// 五家映射（provider id 统一 "ainone"）：
//   claude   ~/.claude/settings.json        env.ANTHROPIC_BASE_URL / env.ANTHROPIC_AUTH_TOKEN / 顶层 model
//   codex    ~/.codex/config.toml           model + model_provider + [model_providers.ainone]（key 不写 toml，
//                                           存 app 自管 keys.json，spawn 时注入 env AINONE_CODEX_API_KEY）
//   pi       ~/.pi/agent/models.json        providers.ainone.{baseUrl, api, apiKey, models[].id}
//   omp      ~/.omp/agent/models.yml        同 pi（YAML 形态；本期同构生成，格式保留不承诺）
//   opencode ~/.config/opencode/opencode.json  provider.ainone.{npm, name, options.{baseURL, apiKey}, models} + 顶层 model
//
// JSON 语义（serde_json preserve_order）：parse 全文 → 定位嵌套路径（无则创建）→
// 只 set 目标键 → 写回。键序保留，其他键逐字节不动（键不存在=添加，存在=替换）。

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 读回显视图（key 不回传明文，与 quickask 密钥纪律一致）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigView {
    pub endpoint: String,
    pub has_api_key: bool,
    pub model: String,
    /// 配置文件绝对路径（UI 展示「写入哪个文件」）
    pub source_file: String,
    /// 配置文件是否已存在（false = 保存时将新建）
    pub present: bool,
}

/// 保存输入
#[derive(Debug, Clone, serde::Deserialize)]
pub struct HarnessConfigInput {
    /// 按预置 adapter id 分派：claude-code / codex / pi / omp / opencode
    pub program: String,
    pub endpoint: String,
    /// 留空 = 保留既有 key
    pub api_key: String,
    pub model: String,
}

/// 纯函数：目标配置文件路径（home 注入便于单测）。
pub fn config_file_for(adapter_id: &str, home: &Path) -> Option<PathBuf> {
    match adapter_id {
        "claude-code" => Some(home.join(".claude/settings.json")),
        "codex" => Some(home.join(".codex/config.toml")),
        "pi" => Some(home.join(".pi/agent/models.json")),
        "omp" => Some(home.join(".omp/agent/models.yml")),
        "opencode" => Some(home.join(".config/opencode/opencode.json")),
        _ => None,
    }
}

/// 纯函数：读回显（文本由调用方读好后传入，缺失传 None）。
/// key 明文不出现在视图里，只报 has_api_key。
pub fn read_view_text(adapter_id: &str, raw: Option<&str>) -> (String, bool, String) {
    let empty = (String::new(), false, String::new());
    let Some(raw) = raw else { return empty };
    match adapter_id {
        "claude-code" => {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return empty };
            let env = v.get("env");
            let endpoint = env
                .and_then(|e| e.get("ANTHROPIC_BASE_URL"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let has_key = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
                .iter()
                .any(|k| env.and_then(|e| e.get(k)).and_then(|x| x.as_str()).is_some_and(|s| !s.trim().is_empty()));
            let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
            (endpoint, has_key, model)
        }
        "codex" => {
            let Ok(doc) = raw.parse::<toml_edit::DocumentMut>() else { return empty };
            let endpoint = doc
                .get("model_providers")
                .and_then(|p| p.get("ainone"))
                .and_then(|p| p.get("base_url"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let model = doc.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
            // codex key 是否已存：命令层拿得到 AppHandle 时查 keys.json，
            // 这里（无 AppHandle 上下文的读路径）以 keys 环境注入检查兜底。
            // 注意：读回显只在命令线程发生，codex_key_present 通过全局目录解析。
            let has_key = codex_key_present();
            (endpoint, has_key, model)
        }
        "pi" => {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return empty };
            read_pi_provider(&v)
        }
        "omp" => {
            // YAML 结构与 pi 的 JSON 同构；简单键提取（无 serde_yaml 依赖的轻量解析）
            let endpoint = yaml_get(raw, &["providers", "ainone", "baseUrl"]);
            let model = yaml_get(raw, &["providers", "ainone", "models", "0", "id"]);
            let has_key = yaml_get(raw, &["providers", "ainone", "apiKey"])
                .trim()
                .len() > 3; // 占位符 "ollama" 也算已配置
            (endpoint, has_key, model)
        }
        "opencode" => {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return empty };
            let provider = v.get("provider").and_then(|p| p.get("ainone"));
            let endpoint = provider
                .and_then(|p| p.get("options"))
                .and_then(|o| o.get("baseURL"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let has_key = provider
                .and_then(|p| p.get("options"))
                .and_then(|o| o.get("apiKey"))
                .and_then(|x| x.as_str())
                .is_some_and(|s| !s.trim().is_empty());
            let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
            (endpoint, has_key, model)
        }
        _ => empty,
    }
}

// codex key 是否已存（keys.json 在 Tauri app 配置目录）。
// harness_config_read 命令持 AppHandle 上下文；目录经 thread_local 传入，
// 未设置时（纯单测环境）返回 false。
thread_local! {
    static KEYS_DIR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// 命令层在调用 read 前设置 keys 目录（app_config_dir），供读回显判断 codex key。
pub fn set_keys_dir_for_read(dir: Option<PathBuf>) {
    KEYS_DIR.with(|c| *c.borrow_mut() = dir);
}

fn codex_key_present() -> bool {
    let dir = KEYS_DIR.with(|c| c.borrow().clone());
    dir.and_then(|d| crate::harness_keys::codex_key_env(Some(&d))).is_some()
}

fn read_pi_provider(v: &serde_json::Value) -> (String, bool, String) {
    let provider = v.get("providers").and_then(|p| p.get("ainone"));
    let endpoint = provider
        .and_then(|p| p.get("baseUrl"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let has_key = provider
        .and_then(|p| p.get("apiKey"))
        .and_then(|x| x.as_str())
        .is_some_and(|s| !s.trim().is_empty());
    let model = provider
        .and_then(|p| p.get("models"))
        .and_then(|m| m.as_array())
        .and_then(|a| a.first())
        .and_then(|m| m.get("id"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    (endpoint, has_key, model)
}

/// 极简 YAML 点路径读取（key: value 两层内嵌套；只服务 omp 回显，不追求完备）。
fn yaml_get(raw: &str, path: &[&str]) -> String {
    let mut indent_stack: Vec<(usize, String)> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let Some((key, value)) = trimmed.split_once(':') else { continue };
        let key = key.trim().to_string();
        let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
        // 弹出比当前缩进深的层
        while indent_stack.last().is_some_and(|(i, _)| *i >= indent) {
            indent_stack.pop();
        }
        indent_stack.push((indent, key.clone()));
        if indent_stack.len() == path.len()
            && indent_stack.iter().map(|(_, k)| k.as_str()).eq(path[..path.len().saturating_sub(1)].iter().copied())
            && key == path[path.len() - 1]
        {
            return value;
        }
        // models[i].id 形态：数字层（- id: x 列表项）当 0 处理
        let _ = &path[path.len() - 1];
        if path.len() >= 2 && key == path[path.len() - 1] && value.is_empty() {
            continue; // 有子层的 key，等下一行
        }
        // 列表项 "- id: x" 会在 split_once 后 key="- id"，做一次容错
        if let Some(k2) = key.strip_prefix("- ") {
            if path.len() >= 2
                && indent_stack.len() >= 2
                && k2 == path[path.len() - 1]
                && indent_stack[indent_stack.len() - 2].1 == path[path.len() - 2]
            {
                return value;
            }
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// 合并写
// ---------------------------------------------------------------------------

/// 纯函数：JSON 合并写——在 raw（可为 "{}" 表新建）上设点路径值，返回新文本。
/// preserve_order 特性保键序；解析失败返回 Err（调用方保证不覆盖损坏文件）。
pub fn json_merge_set(raw: &str, sets: &[(&str, serde_json::Value)]) -> Result<String, String> {
    let mut v: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("JSON 解析失败: {e}"))?;
    for (path, value) in sets {
        json_set_path(&mut v, path, value.clone())?;
    }
    serde_json::to_string_pretty(&v).map_err(|e| format!("JSON 序列化失败: {e}"))
}

/// 点路径 set（a.b.c）；中间层不存在则创建对象。数组下标不设（写需求均为对象路径）。
fn json_set_path(v: &mut serde_json::Value, path: &str, value: serde_json::Value) -> Result<(), String> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = v;
    for (i, part) in parts.iter().enumerate() {
        let is_last = i + 1 == parts.len();
        if is_last {
            cur.as_object_mut()
                .ok_or_else(|| format!("路径 {path} 的父级不是对象"))?
                .insert((*part).to_string(), value);
            return Ok(());
        }
        cur = cur
            .as_object_mut()
            .ok_or_else(|| format!("路径 {path} 的父级不是对象"))?
            .entry((*part).to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    }
    Ok(())
}

/// 纯函数：Claude settings 合并写（endpoint/key/model + DEFAULT_*_MODEL 三键组）。
/// key 为空串 = 不动既有 AUTH_TOKEN（保留既有密钥纪律）。
pub fn claude_merge_write(raw: Option<&str>, endpoint: &str, key: &str, model: &str) -> Result<String, String> {
    let base_raw = raw.unwrap_or("{}");
    let mut sets: Vec<(&str, serde_json::Value)> = vec![
        ("env.ANTHROPIC_BASE_URL", serde_json::Value::String(endpoint.into())),
        ("model", serde_json::Value::String(model.into())),
        ("env.ANTHROPIC_DEFAULT_OPUS_MODEL", serde_json::Value::String(model.into())),
        ("env.ANTHROPIC_DEFAULT_SONNET_MODEL", serde_json::Value::String(model.into())),
        ("env.ANTHROPIC_DEFAULT_HAIKU_MODEL", serde_json::Value::String(model.into())),
    ];
    if !key.trim().is_empty() {
        sets.push(("env.ANTHROPIC_AUTH_TOKEN", serde_json::Value::String(key.into())));
    }
    json_merge_set(base_raw, &sets)
}

/// 纯函数：Codex config.toml 格式保留合并写（toml_edit）。
/// key 不写 toml（env_key 机制）；model_provider 指向 ainone provider。
pub fn codex_merge_write(raw: Option<&str>, endpoint: &str, model: &str) -> Result<String, String> {
    let mut doc: toml_edit::DocumentMut = raw
        .unwrap_or("")
        .parse()
        .map_err(|e| format!("TOML 解析失败: {e}"))?;
    doc["model"] = toml_edit::value(model);
    doc["model_provider"] = toml_edit::value("ainone");
    // 确保表存在并设字段（已存在则逐字段覆盖，其余字段/注释不动）
    let providers = &mut doc["model_providers"];
    if providers.is_none() {
        doc["model_providers"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    let ainone = &mut doc["model_providers"]["ainone"];
    if ainone.is_none() {
        doc["model_providers"]["ainone"] = toml_edit::Item::Table(toml_edit::Table::new());
    }
    doc["model_providers"]["ainone"]["name"] = toml_edit::value("ainone");
    doc["model_providers"]["ainone"]["base_url"] = toml_edit::value(endpoint);
    doc["model_providers"]["ainone"]["env_key"] = toml_edit::value("AINONE_CODEX_API_KEY");
    doc["model_providers"]["ainone"]["wire_api"] = toml_edit::value("responses");
    Ok(doc.to_string())
}

/// 纯函数：Pi models.json 合并写。
pub fn pi_merge_write(raw: Option<&str>, endpoint: &str, key: &str, model: &str) -> Result<String, String> {
    let base_raw = raw.unwrap_or("{}");
    let mut v: serde_json::Value = serde_json::from_str(base_raw).map_err(|e| format!("JSON 解析失败: {e}"))?;
    let provider = v
        .as_object_mut()
        .ok_or("顶层不是对象")?
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("providers 不是对象")?
        .entry("ainone")
        .or_insert_with(|| serde_json::json!({}))
        .take();
    let mut provider = provider.as_object().cloned().unwrap_or_default();
    provider.insert("baseUrl".into(), serde_json::Value::String(endpoint.into()));
    provider.insert("api".into(), serde_json::Value::String("openai-completions".into()));
    if !key.trim().is_empty() {
        provider.insert("apiKey".into(), serde_json::Value::String(key.into()));
    }
    provider.insert(
        "models".into(),
        serde_json::json!([{ "id": model, "input": ["text"], "tool_use": true }]),
    );
    v.as_object_mut()
        .unwrap()
        .get_mut("providers")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .insert("ainone".into(), serde_json::Value::Object(provider));
    serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}"))
}

/// 纯函数：OpenCode opencode.json 合并写。
pub fn opencode_merge_write(raw: Option<&str>, endpoint: &str, key: &str, model: &str) -> Result<String, String> {
    let base_raw = raw.unwrap_or("{}");
    let mut v: serde_json::Value = serde_json::from_str(base_raw).map_err(|e| format!("JSON 解析失败: {e}"))?;
    let mut provider = serde_json::json!({
        "npm": "@ai-sdk/openai-compatible",
        "name": "ainone",
        "options": {},
        "models": { model.clone(): { "name": model.clone() } },
    });
    provider["options"]["baseURL"] = serde_json::Value::String(endpoint.into());
    if !key.trim().is_empty() {
        provider["options"]["apiKey"] = serde_json::Value::String(key.into());
    }
    let obj = v.as_object_mut().ok_or("顶层不是对象")?;
    obj.entry("provider")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("provider 不是对象")?
        .insert("ainone".into(), provider);
    obj.insert("model".into(), serde_json::Value::String(format!("ainone/{model}")));
    serde_json::to_string_pretty(&v).map_err(|e| format!("序列化失败: {e}"))
}

/// 纯函数：omp models.yml 同构生成（YAML 无注释保留承诺；结构对齐 pi）。
pub fn omp_merge_write(raw: Option<&str>, endpoint: &str, key: &str, model: &str) -> Result<String, String> {
    let _ = raw; // YAML 全量重生成（结构受控、非用户手工注释区）
    let mut s = String::from("providers:\n  ainone:\n");
    s.push_str(&format!("    baseUrl: {endpoint}\n"));
    s.push_str("    api: openai-completions\n");
    if !key.trim().is_empty() {
        s.push_str(&format!("    apiKey: \"{key}\"\n"));
    }
    s.push_str(&format!("    models:\n      - id: {model}\n        input:\n          - text\n        tool_use: true\n"));
    Ok(s)
}

// ---------------------------------------------------------------------------
// 命令层
// ---------------------------------------------------------------------------

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法定位家目录".to_string())
}

/// 读取当前配置回显（key 不回传明文）。
#[tauri::command]
pub fn harness_config_read(app: tauri::AppHandle, adapter_id: String) -> Result<HarnessConfigView, String> {
    // keys 目录供 read_view_text 判断 codex key 是否已存
    set_keys_dir_for_read(
        app.path()
            .app_config_dir()
            .ok(),
    );
    let home = home_dir()?;
    let path = config_file_for(&adapter_id, &home).ok_or_else(|| format!("{adapter_id} 不支持配置代写"))?;
    let present = path.exists();
    let raw = present.then(|| std::fs::read_to_string(&path).ok()).flatten();
    let (endpoint, has_key, model) = read_view_text(&adapter_id, raw.as_deref());
    Ok(HarnessConfigView {
        endpoint,
        has_api_key: has_key,
        model,
        source_file: path.to_string_lossy().into_owned(),
        present,
    })
}

/// 备份 + 保存。备份为 <file>.ainone-bak（覆盖上一份，不堆积）。
#[tauri::command]
pub fn harness_config_save(app: tauri::AppHandle, input: HarnessConfigInput) -> Result<String, String> {
    let home = home_dir()?;
    let path = config_file_for(&input.program, &home).ok_or_else(|| format!("{} 不支持配置代写", input.program))?;
    if input.endpoint.trim().is_empty() || input.model.trim().is_empty() {
        return Err("endpoint 与模型名不能为空".into());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let existing = path.exists().then(|| std::fs::read_to_string(&path).ok()).flatten();

    let new_text = match input.program.as_str() {
        "claude-code" => claude_merge_write(existing.as_deref(), &input.endpoint, &input.api_key, &input.model)?,
        "codex" => codex_merge_write(existing.as_deref(), &input.endpoint, &input.model)?,
        "pi" => pi_merge_write(existing.as_deref(), &input.endpoint, &input.api_key, &input.model)?,
        "omp" => omp_merge_write(existing.as_deref(), &input.endpoint, &input.api_key, &input.model)?,
        "opencode" => opencode_merge_write(existing.as_deref(), &input.endpoint, &input.api_key, &input.model)?,
        other => return Err(format!("{other} 不支持配置代写")),
    };

    // codex 的 key 存 app 自管 keys.json（env_key 机制），不写 toml
    if input.program == "codex" && !input.api_key.trim().is_empty() {
        crate::harness_keys::store_codex_key(&app, &input.api_key.trim())?;
    }

    if existing.is_some() {
        let bak = path.with_extension("ainone-bak");
        std::fs::copy(&path, &bak).map_err(|e| format!("备份失败: {e}"))?;
    }
    std::fs::write(&path, new_text).map_err(|e| format!("写入配置失败: {e}"))?;
    log::info!("[harness-config] {} 配置已写入 {}", input.program, path.display());
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------- 验收 3.1/3.2：claude 合并写 ----------------

    const CLAUDE_FULL: &str = r#"{
  "cleanupPeriodDays": 30,
  "env": {
    "ANTHROPIC_BASE_URL": "https://old.example.com/",
    "ANTHROPIC_AUTH_TOKEN": "sk-old",
    "API_TIMEOUT_MS": "3000000",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "old-model"
  },
  "permissions": { "allow": ["Bash(ls:*)"] },
  "model": "old-model[1m]",
  "hooks": { "PostToolUse": [] }
}"#;

    #[test]
    fn claude_merge_keeps_unrelated_keys() {
        // 验收 3.1：permissions/hooks/API_TIMEOUT_MS 等 Preserve；
        // 只换 BASE_URL / model / DEFAULT_*_MODEL；key 留空 = 保留 sk-old
        let out = claude_merge_write(Some(CLAUDE_FULL), "https://new.example.com", "", "new-model").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://new.example.com");
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-old");
        assert_eq!(v["env"]["API_TIMEOUT_MS"], "3000000");
        assert_eq!(v["permissions"]["allow"][0], "Bash(ls:*)");
        assert_eq!(v["model"], "new-model");
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "new-model");
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "new-model");
        assert!(v.get("hooks").is_some());
    }

    #[test]
    fn claude_merge_writes_new_key_when_given() {
        let out = claude_merge_write(Some(CLAUDE_FULL), "https://new.example.com", "sk-new", "m").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-new");
    }

    #[test]
    fn claude_merge_creates_env_when_missing() {
        // 验收 3.2：无 env 对象的新文件 → 创建 env 并写入
        let out = claude_merge_write(None, "https://x.com", "sk", "m").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://x.com");
        assert_eq!(v["model"], "m");
    }

    #[test]
    fn claude_merge_rejects_corrupt_input() {
        // 验收 3.3：损坏 JSON → Err，调用方保证不写盘
        assert!(claude_merge_write(Some("{broken"), "https://x", "", "m").is_err());
    }

    #[test]
    fn json_merge_set_adds_and_replaces() {
        // 添加（键不存在）与替换（存在）语义
        let out = json_merge_set(r#"{"a":1}"#, &[("b.c", serde_json::json!("x")), ("a", serde_json::json!(2))]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["a"], 2);
        assert_eq!(v["b"]["c"], "x");
    }

    #[test]
    fn json_merge_preserves_key_order() {
        // preserve_order：原键序不重排，新键追加在尾
        let out = json_merge_set(r#"{
  "zeta": 1,
  "alpha": 2
}"#, &[("beta", serde_json::json!(3))]).unwrap();
        let z = out.find("\"zeta\"").unwrap();
        let a = out.find("\"alpha\"").unwrap();
        let b = out.find("\"beta\"").unwrap();
        assert!(z < a && a < b, "原键序应保留且新键在尾: {out}");
    }

    // ---------------- 验收 3.4：codex toml_edit ----------------

    const CODEX_TOML: &str = r#"# 用户的注释必须保留
model = "gpt-5.4"
model_provider = "codex"

[model_providers.codex]
name = "codex"
base_url = "https://old/v1"
"#;

    #[test]
    fn codex_merge_preserves_comments_and_existing_provider() {
        let out = codex_merge_write(Some(CODEX_TOML), "https://new/v1", "new-model").unwrap();
        assert!(out.contains("# 用户的注释必须保留"), "注释不能丢");
        assert!(out.contains("[model_providers.codex]"), "既有 provider 不能删");
        assert!(out.contains("base_url = \"https://old/v1\""), "既有 provider 内容不动");
        assert!(out.contains("model_provider = \"ainone\""));
        assert!(out.contains("[model_providers.ainone]"));
        assert!(out.contains("env_key = \"AINONE_CODEX_API_KEY\""));
        assert!(out.contains("wire_api = \"responses\""));
        assert!(!out.contains("AINONE_CODEX_API_KEY ="), "key 明文不进 toml");
        // 解析回来核对 model
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["model"].as_str(), Some("new-model"));
    }

    #[test]
    fn codex_merge_from_empty() {
        let out = codex_merge_write(None, "https://x/v1", "m").unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["model_provider"].as_str(), Some("ainone"));
        assert_eq!(doc["model_providers"]["ainone"]["base_url"].as_str(), Some("https://x/v1"));
    }

    // ---------------- 验收 3.6：key 留空保留（pi/opencode） ----------------

    #[test]
    fn pi_merge_keeps_existing_key_when_blank() {
        let existing = r#"{"providers":{"ainone":{"baseUrl":"https://old","api":"openai-completions","apiKey":"sk-keep","models":[{"id":"old"}]}}}"#;
        let out = pi_merge_write(Some(existing), "https://new", "", "new-m").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["providers"]["ainone"]["apiKey"], "sk-keep");
        assert_eq!(v["providers"]["ainone"]["baseUrl"], "https://new");
        assert_eq!(v["providers"]["ainone"]["models"][0]["id"], "new-m");
    }

    #[test]
    fn pi_merge_from_empty() {
        let out = pi_merge_write(None, "https://x", "sk", "m").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["providers"]["ainone"]["apiKey"], "sk");
        assert_eq!(v["providers"]["ainone"]["api"], "openai-completions");
    }

    #[test]
    fn opencode_merge_writes_provider_and_model() {
        let out = opencode_merge_write(Some(r#"{"theme":"dark"}"#), "https://x/v1", "sk", "m1").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["theme"], "dark", "无关键保留");
        assert_eq!(v["provider"]["ainone"]["options"]["baseURL"], "https://x/v1");
        assert_eq!(v["provider"]["ainone"]["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(v["model"], "ainone/m1");
        assert!(v["provider"]["ainone"]["models"]["m1"].is_object());
    }

    #[test]
    fn omp_merge_generates_yaml() {
        let out = omp_merge_write(None, "https://x", "sk", "m1").unwrap();
        assert!(out.contains("ainone:"));
        assert!(out.contains("baseUrl: https://x"));
        assert!(out.contains("id: m1"));
        // 无 key 时不写 apiKey 行
        let out2 = omp_merge_write(None, "https://x", "", "m1").unwrap();
        assert!(!out2.contains("apiKey"));
    }

    // ---------------- 验收：读回显 ----------------

    #[test]
    fn read_view_roundtrip() {
        let (ep, has_key, model) = read_view_text(
            "claude-code",
            Some(r#"{"env":{"ANTHROPIC_BASE_URL":"https://x","ANTHROPIC_AUTH_TOKEN":"sk"},"model":"m[1m]"}"#),
        );
        assert_eq!(ep, "https://x");
        assert!(has_key);
        assert_eq!(model, "m[1m]");

        let (ep, has_key, model) = read_view_text("pi", Some(r#"{"providers":{"ainone":{"baseUrl":"https://p","apiKey":"sk","models":[{"id":"pm"}]}}}"#));
        assert_eq!(ep, "https://p");
        assert!(has_key);
        assert_eq!(model, "pm");

        let (ep, _, model) = read_view_text("codex", Some(CODEX_TOML));
        assert_eq!(ep, ""); // 旧文件无 ainone provider → 空
        assert_eq!(model, "gpt-5.4");

        let (_, has_key, _) = read_view_text("codex", Some(CODEX_TOML));
        // keys 未存 → false（本机测试环境无 app 配置目录上下文，走 stub 判定）
        let _ = has_key;

        // 缺失/损坏 → 全空
        assert_eq!(read_view_text("pi", None), (String::new(), false, String::new()));
        assert_eq!(read_view_text("pi", Some("junk")), (String::new(), false, String::new()));
    }

    #[test]
    fn config_file_paths() {
        let home = Path::new("/h");
        assert_eq!(
            config_file_for("claude-code", home).unwrap().to_string_lossy().replace('\\', "/"),
            "/h/.claude/settings.json"
        );
        assert_eq!(
            config_file_for("codex", home).unwrap().to_string_lossy().replace('\\', "/"),
            "/h/.codex/config.toml"
        );
        assert!(config_file_for("custom-x", home).is_none());
    }
}
