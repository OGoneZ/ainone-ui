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
    /// 上下文窗口 tokens 回显（空串 = 未设置，保存时落默认 1000000）
    pub context_tokens: String,
}

/// 保存输入
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigInput {
    /// 按预置 adapter id 分派：claude-code / codex / pi / omp / opencode
    pub program: String,
    pub endpoint: String,
    /// 留空 = 保留既有 key
    pub api_key: String,
    pub model: String,
    /// 上下文窗口 tokens（仅 claude-code 消费；None/留空 = 默认 1000000）
    #[serde(default)]
    pub context_tokens: Option<String>,
    /// 探测到的网关全量模型（claude-code allowlist 全量并入用；None = 未探测）。
    /// #[serde(default)] 兼容旧前端调用（不传 = 行为同前：只并入 model 单条）。
    #[serde(default)]
    pub probe_models: Option<Vec<String>>,
}

/// Claude 通道默认上下文窗口（P39：GLM/DeepSeek 等第三方模型原生 1M，
/// Claude Code 对未知网关模型兜底 200k 提前压缩——env 覆盖对非 claude- 模型名直接生效）。
pub const DEFAULT_CLAUDE_CONTEXT_TOKENS: u64 = 1_000_000;

/// settings.json env 中的上下文窗口键名（harness_meta 的切模型链路与本模块的配置
/// 代写共用同一常量，防两处字面量分叉——历史上正是该键只在代写链路写、切模型链路
/// 不写，导致「设置页配的上下文对切换的模型不生效」）。
pub const CLAUDE_MAX_CONTEXT_KEY: &str = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";

/// Claude Code env 范围上限（autoCompactWindow 接受 100k~1M，超出被客户端 cap 无意义）。
const MAX_CLAUDE_CONTEXT_TOKENS: u64 = 1_000_000;

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
/// key 明文不出现在视图里，只报 has_api_key；context_tokens 空串 = 未设置。
pub fn read_view_text(adapter_id: &str, raw: Option<&str>) -> (String, bool, String, String) {
    let empty = (String::new(), false, String::new(), String::new());
    let Some(raw) = raw else { return empty };
    match adapter_id {
        "claude-code" => {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return empty };
            let endpoint = v
                .get("env")
                .and_then(|e| e.get("ANTHROPIC_BASE_URL"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            // P32a：key 判定统一走 harness_meta::claude_key_present（双字段单一实现）
            let has_key = crate::harness_meta::claude_key_present(&v);
            let model = v.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
            let context_tokens = v
                .get("env")
                .and_then(|e| e.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            (endpoint, has_key, model, context_tokens)
        }
        "codex" => {
            let Ok(doc) = raw.parse::<toml_edit::DocumentMut>() else { return empty };
            // 优先 ainone provider（应用代写）；无则按 model_provider 活跃值 → 首个 provider
            // （用户自配的 provider 名各异——回显应显示用户真实在用的 endpoint）
            let endpoint = doc
                .get("model_providers")
                .and_then(|p| p.get("ainone"))
                .and_then(|p| p.get("base_url"))
                .and_then(|x| x.as_str())
                .map(String::from)
                .or_else(|| {
                    let active = doc
                        .get("model_provider")
                        .and_then(|p| p.as_str())
                        .map(String::from)
                        .or_else(|| {
                            doc.get("model_providers")
                                .and_then(|p| p.as_table())
                                .and_then(|t| t.iter().next().map(|(k, _)| k.to_string()))
                        })?;
                    doc.get("model_providers")
                        .and_then(|p| p.get(&active))
                        .and_then(|p| p.get("base_url"))
                        .and_then(|x| x.as_str())
                        .map(String::from)
                })
                .unwrap_or_default();
            let model = doc.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
            // codex key 是否已存：命令层拿得到 AppHandle 时查 keys.json，
            // 这里（无 AppHandle 上下文的读路径）以 keys 环境注入检查兜底。
            // 注意：读回显只在命令线程发生，codex_key_present 通过全局目录解析。
            let has_key = codex_key_present();
            (endpoint, has_key, model, String::new())
        }
        "pi" => {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else { return empty };
            let (endpoint, has_key, model) = read_pi_provider(&v);
            (endpoint, has_key, model, String::new())
        }
        "omp" => {
            // YAML 与 pi 的 JSON 同构；扫 providers 下各层的 baseUrl/apiKey/model id，
            // ainone 优先、无则首个含 baseUrl 的 provider（用户自配名各异，S6 反馈缺陷）
            let (endpoint, has_key, model) = yaml_providers_scan(raw);
            (endpoint, has_key, model, String::new())
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
            (endpoint, has_key, model, String::new())
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
    read_provider_fallback(v.get("providers"), "baseUrl", "apiKey")
}

/// 通用 provider 读取（pi JSON / omp YAML 同构）：优先 ainone（应用代写），
/// 无则取**首个含 baseUrl 的 provider**——用户自配 provider 名各异
/// （本机 omp 配的是 "zhubaoduo"），只认 ainone 会让回显全空（S6 反馈缺陷）。
/// YAML 分支传预解析的扁平行映射，JSON 分支传 serde Value；此处统一收 JSON 树。
fn read_provider_fallback(
    providers: Option<&serde_json::Value>,
    url_key: &str,
    key_field: &str,
) -> (String, bool, String) {
    let empty = (String::new(), false, String::new());
    let Some(map) = providers.and_then(|p| p.as_object()) else { return empty };
    // 候选序：ainone 在前（应用代写值最可信），其余按文件序
    let mut names: Vec<&String> = Vec::new();
    if let Some(k) = map.keys().find(|k| k.as_str() == "ainone") {
        names.push(k);
    }
    for k in map.keys() {
        if k.as_str() != "ainone" {
            names.push(k);
        }
    }
    for name in names {
        let p = &map[name];
        let endpoint = p.get(url_key).and_then(|x| x.as_str()).unwrap_or("");
        if endpoint.trim().is_empty() {
            continue;
        }
        let has_key = p
            .get(key_field)
            .and_then(|x| x.as_str())
            .is_some_and(|s| !s.trim().is_empty());
        let model = p
            .get("models")
            .and_then(|m| m.as_array())
            .and_then(|a| a.first())
            .and_then(|m| m.get("id"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        return (endpoint.to_string(), has_key, model);
    }
    empty
}

/// 极简 YAML 点路径读取（key: value 两层内嵌套；测试用——生产回显走 yaml_providers_scan）。
#[cfg(test)]
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

/// omp models.yml 的 providers 扫描：逐行解析 `providers:` 下各 provider 块的
/// baseUrl / apiKey / models 首项 id；ainone 优先，否则首个含 baseUrl 的 provider。
/// 不追求完整 YAML 语义——只服务回显（写入走受控同构生成）。
fn yaml_providers_scan(raw: &str) -> (String, bool, String) {
    struct P {
        base_url: String,
        has_key: bool,
        model: String,
    }
    let mut order: Vec<String> = Vec::new();
    let mut blocks: std::collections::HashMap<String, P> = std::collections::HashMap::new();
    let mut cur: Option<(usize, String)> = None; // (缩进, provider名)
    let mut in_models = false;
    for line in raw.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        let Some((key_raw, value_raw)) = trimmed.split_once(':') else { continue };
        let key = key_raw.trim().trim_start_matches("- ").trim();
        let value = value_raw.trim().trim_matches('"').trim_matches('\'');
        if key == "providers" {
            in_models = false;
            continue;
        }
        // 进入某个 provider 块（缩进比 providers 深一层、且值内无 baseUrl 等键）
        if indent > 0 && !key.is_empty() && !value.is_empty() || key == "models" {
            // providers 下第一层 = provider 名（"  zhubaoduo:" 值为空）
        }
        if indent >= 2 && value.is_empty() && key != "models" && !key.starts_with('#') {
            // 可能是 provider 名行（如 "  ainone:"）也可能是子键（"  models:" 已排除）
            if raw.contains(&format!("{}:", key)) && blocks.contains_key(key) || is_provider_name(raw, key) {
                cur = Some((indent, key.to_string()));
                order.push(key.to_string());
                blocks.entry(key.to_string()).or_insert(P { base_url: String::new(), has_key: false, model: String::new() });
                in_models = false;
                continue;
            }
        }
        let Some((_, name)) = cur.as_ref() else { continue };
        let b = blocks.get_mut(name).unwrap();
        match key {
            "baseUrl" if b.base_url.is_empty() => b.base_url = value.to_string(),
            "apiKey" if !value.is_empty() => b.has_key = true,
            "id" if b.model.is_empty() && in_models => b.model = value.to_string(),
            "models" => in_models = true,
            _ => {}
        }
    }
    fn is_provider_name(raw: &str, key: &str) -> bool {
        // provider 名行的特征：出现 `  <key>:`（两空格缩进）且后面跟 baseUrl
        raw.lines().any(|l| {
            let t = l.trim_start();
            (t.starts_with(&format!("{key}:")) || t.starts_with(&format!("- {key}:")))
                && (l.starts_with("  ") || l.starts_with("\t"))
        })
    }
    // ainone 优先，否则首个含 baseUrl 的
    let mut names: Vec<&String> = Vec::new();
    if order.iter().any(|k| k == "ainone") {
        names.push(order.iter().find(|k| k.as_str() == "ainone").unwrap());
    }
    for k in &order {
        if k.as_str() != "ainone" {
            names.push(k);
        }
    }
    for name in names {
        if let Some(b) = blocks.get(name) {
            if !b.base_url.is_empty() {
                return (b.base_url.clone(), b.has_key, b.model.clone());
            }
        }
    }
    (String::new(), false, String::new())
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

/// 纯函数：解析用户输入的上下文 tokens——None/空串 = 默认 1M；
/// 非数字或 0 报错；超上限钳到 1M（Claude Code 客户端本身也会 cap）。
fn parse_context_tokens(raw: Option<&str>) -> Result<u64, String> {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(DEFAULT_CLAUDE_CONTEXT_TOKENS);
    };
    let n: u64 = s
        .parse()
        .map_err(|_| format!("上下文大小须为正整数（收到 \"{s}\"）"))?;
    if n == 0 {
        return Err("上下文大小须为正整数".into());
    }
    Ok(n.min(MAX_CLAUDE_CONTEXT_TOKENS))
}

/// 纯函数：Claude settings 合并写（endpoint/key/model + DEFAULT_*_MODEL 三键组）。
/// key 为空串 = 不动既有 AUTH_TOKEN（保留既有密钥纪律）。
/// context_tokens：Some(n) 显式写 env.CLAUDE_CODE_MAX_CONTEXT_TOKENS；None = 不动既有。
pub fn claude_merge_write(
    raw: Option<&str>,
    endpoint: &str,
    key: &str,
    model: &str,
    context_tokens: Option<u64>,
) -> Result<String, String> {
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
    if let Some(n) = context_tokens {
        // 键名与 CLAUDE_MAX_CONTEXT_KEY 必须一致（测试 env_key_matches_const 锁定，
        // json_merge_set 走 &str 点路径，故此处保留字面量）
        sets.push((
            "env.CLAUDE_CODE_MAX_CONTEXT_TOKENS",
            serde_json::Value::String(n.to_string()),
        ));
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
/// P32g：key 留空的继承源扩为「ainone 既有 → 首个带 apiKey 的 provider」——用户自配
/// provider（非 ainone 名）时旧实现新建/覆盖 ainone 会把自配 key 丢掉（与 omp 同根因）。
pub fn pi_merge_write(raw: Option<&str>, endpoint: &str, key: &str, model: &str) -> Result<String, String> {
    let base_raw = raw.unwrap_or("{}");
    let mut v: serde_json::Value = serde_json::from_str(base_raw).map_err(|e| format!("JSON 解析失败: {e}"))?;
    let providers = v
        .as_object_mut()
        .ok_or("顶层不是对象")?
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("providers 不是对象")?;
    let existing_ainone_key = providers
        .get("ainone")
        .and_then(|p| p.get("apiKey"))
        .and_then(|k| k.as_str())
        .map(String::from)
        .filter(|k| !k.trim().is_empty());
    let inherited_key = existing_ainone_key.or_else(|| {
        providers
            .values()
            .find_map(|p| {
                p.get("apiKey")
                    .and_then(|k| k.as_str())
                    .map(String::from)
                    .filter(|k| !k.trim().is_empty())
            })
    });
    // ainone 不存在时继承首个带 baseUrl 的 provider 的 endpoint（与 read_provider_fallback 同语义）
    let first_base = providers.values().find_map(|p| {
        p.get("baseUrl")
            .and_then(|b| b.as_str())
            .map(String::from)
            .filter(|b| !b.trim().is_empty())
    });
    let base_out = if endpoint.trim().is_empty() {
        first_base.unwrap_or_default()
    } else {
        endpoint.to_string()
    };
    let provider = providers
        .entry("ainone".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .take();
    let mut provider = provider.as_object().cloned().unwrap_or_default();
    provider.insert("baseUrl".into(), serde_json::Value::String(base_out));
    provider.insert("api".into(), serde_json::Value::String("openai-completions".into()));
    let key_out = if key.trim().is_empty() {
        inherited_key.unwrap_or_default()
    } else {
        key.to_string()
    };
    if !key_out.trim().is_empty() {
        provider.insert("apiKey".into(), serde_json::Value::String(key_out));
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
/// P32g：key 留空的继承源扩为「ainone 既有 → 首个带 options.apiKey 的 provider」；
/// endpoint 留空时回落首个带 options.baseURL 的 provider（用户自配 provider 不换网关）。
pub fn opencode_merge_write(raw: Option<&str>, endpoint: &str, key: &str, model: &str) -> Result<String, String> {
    let base_raw = raw.unwrap_or("{}");
    let mut v: serde_json::Value = serde_json::from_str(base_raw).map_err(|e| format!("JSON 解析失败: {e}"))?;
    // 继承源探测要在借走 provider.ainone 之前做（借用冲突）
    let inherited = v
        .get("provider")
        .and_then(|p| p.as_object())
        .and_then(|map| {
            let ainone = map.get("ainone");
            let ainone_key = ainone
                .and_then(|p| p.get("options"))
                .and_then(|o| o.get("apiKey"))
                .and_then(|k| k.as_str())
                .map(String::from)
                .filter(|k| !k.trim().is_empty());
            let first = map.values().find_map(|p| {
                let opts = p.get("options")?;
                let k = opts.get("apiKey").and_then(|k| k.as_str())?;
                (!k.trim().is_empty()).then(|| k.to_string())
            });
            let first_base = map.values().find_map(|p| {
                let opts = p.get("options")?;
                let b = opts.get("baseURL").and_then(|b| b.as_str())?;
                (!b.trim().is_empty()).then(|| b.to_string())
            });
            Some((ainone_key, first, first_base))
        })
        .unwrap_or((None, None, None));
    let mut provider = serde_json::json!({
        "npm": "@ai-sdk/openai-compatible",
        "name": "ainone",
        "options": {},
        "models": { model.clone(): { "name": model.clone() } },
    });
    let base_out = if endpoint.trim().is_empty() {
        inherited.2.unwrap_or_default()
    } else {
        endpoint.to_string()
    };
    provider["options"]["baseURL"] = serde_json::Value::String(base_out);
    let key_out = if key.trim().is_empty() {
        inherited.0.or(inherited.1).unwrap_or_default()
    } else {
        key.to_string()
    };
    if !key_out.trim().is_empty() {
        provider["options"]["apiKey"] = serde_json::Value::String(key_out);
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

/// 纯函数：omp models.yml 合并写（serde_yaml_ng 解析 → 只改 ainone provider → 重新序列化）。
///
/// P32g 缺陷根因修复：旧实现「key 留空 = 全量重生成无 apiKey 行」，用户本机自配
/// provider（zhubaoduo）的 apiKey 被蒸发——OMP 后续调用该 provider 全链 401（实测事故
/// 2026-09-09）。且旧实现把用户自配 provider 整体丢弃换成 ainone，endpoint 语义也变。
///
/// 现语义（与 claude_merge_write「key 留空 = 保留既有」同一纪律）：
///   - ainone provider 存在：只改 baseUrl/apiKey(显式时)/models 首项，其余字段保留；
///     key 留空 = 继承 ainone 既有 apiKey。
///   - ainone 不存在但其他 provider 有：保留该 provider 原样，新建 ainone 继承其
///     endpoint/key（用户「在现网关上切模型」的语义，不给网关换地址）。
///   - 全新文件：最小 ainone 结构。
pub fn omp_merge_write(raw: Option<&str>, endpoint: &str, key: &str, model: &str) -> Result<String, String> {
    let mut v: serde_yaml_ng::Value = match raw {
        Some(r) if !r.trim().is_empty() => serde_yaml_ng::from_str(r)
            .map_err(|e| format!("models.yml 解析失败: {e}"))?,
        _ => serde_yaml_ng::Value::Mapping(Default::default()),
    };
    if !v.is_mapping() {
        return Err("models.yml 顶层不是映射".into());
    }
    let providers = match v.get_mut("providers") {
        None => {
            // 全新/无 providers 段 → 创建（等效旧实现的同构生成）
            if let Some(map) = v.as_mapping_mut() {
                map.insert(
                    serde_yaml_ng::Value::String("providers".into()),
                    serde_yaml_ng::Value::Mapping(Default::default()),
                );
            }
            v.get_mut("providers").ok_or("models.yml providers 创建失败")?
        }
        Some(p) if !p.is_mapping() => return Err("models.yml providers 不是映射".into()),
        Some(p) => p,
    };
    let map = providers.as_mapping_mut().unwrap();
    // 既有 key 继承源：ainone 自己的 → 首个带 apiKey 的 provider（key 留空场景）
    let existing_ainone_key = map
        .get(serde_yaml_ng::Value::String("ainone".into()))
        .and_then(|p| p.get("apiKey"))
        .and_then(|k| k.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty());
    let inherited_key = existing_ainone_key.or_else(|| {
        map.iter().find_map(|(_, p)| {
            p.get("apiKey")
                .and_then(|k| k.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty())
        })
    });
    // ainone 不存在时继承首个带 baseUrl 的 provider 的 endpoint/key（同 read_provider_fallback 语义）
    let first_provider = map.iter().find_map(|(_, p)| {
        let base = p.get("baseUrl").and_then(|b| b.as_str())?;
        let k = p.get("apiKey").and_then(|k| k.as_str()).unwrap_or("");
        Some((base.to_string(), k.to_string()))
    });
    let (base_out, key_out) = if endpoint.trim().is_empty() {
        (
            first_provider.clone().map(|(b, _)| b).unwrap_or_default(),
            if key.trim().is_empty() {
                inherited_key.clone().unwrap_or_default()
            } else {
                key.to_string()
            },
        )
    } else {
        (
            endpoint.to_string(),
            if key.trim().is_empty() {
                inherited_key.clone().or_else(|| first_provider.map(|(_, k)| k)).unwrap_or_default()
            } else {
                key.to_string()
            },
        )
    };
    let entry = map
        .entry(serde_yaml_ng::Value::String("ainone".into()))
        .or_insert(serde_yaml_ng::Value::Mapping(Default::default()));
    let p = entry.as_mapping_mut().ok_or("provider.ainone 不是映射")?;
    p.insert(
        serde_yaml_ng::Value::String("baseUrl".into()),
        serde_yaml_ng::Value::String(base_out),
    );
    // anthropic-messages 协议（P32g 实测）：OMP 对 openai-completions 自定义
    // provider 不发思考参数且流式解析与网关 reasoning_content 前缀形态兼容性差
    // （glm-5.3-flash 实测 empty stop）；anthropic-messages 是 OMP 官方 glm 家族
    // 声明（zai 缓存 model_cache 同款 api），思考参数与解析全链路验证可用。
    p.insert(
        serde_yaml_ng::Value::String("api".into()),
        serde_yaml_ng::Value::String("anthropic-messages".into()),
    );
    if !key_out.trim().is_empty() {
        p.insert(
            serde_yaml_ng::Value::String("apiKey".into()),
            serde_yaml_ng::Value::String(key_out),
        );
    }
    // 模型条目完整声明（社区文档 omp.sh/docs/custom-models：省略元数据 = 无思考
    // 配置 + 16K 输出上限——思考模型因此被网关拒/截断）。anthropic-messages 下
    // OMP 按 anthropic budget/effort 形态发思考参数，glm-5.3-flash 实测 OK。
    let thinking = serde_yaml_ng::Value::Mapping(serde_yaml_ng::mapping::Mapping::from_iter([
        (serde_yaml_ng::Value::String("mode".into()), serde_yaml_ng::Value::String("effort".into())),
        (
            serde_yaml_ng::Value::String("efforts".into()),
            serde_yaml_ng::Value::Sequence(vec![
                serde_yaml_ng::Value::String("low".into()),
                serde_yaml_ng::Value::String("high".into()),
                serde_yaml_ng::Value::String("max".into()),
            ]),
        ),
        (serde_yaml_ng::Value::String("defaultLevel".into()), serde_yaml_ng::Value::String("high".into())),
    ]));
    let model_item = serde_yaml_ng::Value::Mapping(serde_yaml_ng::mapping::Mapping::from_iter([
        (
            serde_yaml_ng::Value::String("id".into()),
            serde_yaml_ng::Value::String(model.to_string()),
        ),
        (
            serde_yaml_ng::Value::String("name".into()),
            serde_yaml_ng::Value::String(model.to_string()),
        ),
        (serde_yaml_ng::Value::String("reasoning".into()), serde_yaml_ng::Value::Bool(true)),
        (serde_yaml_ng::Value::String("thinking".into()), thinking),
        (
            serde_yaml_ng::Value::String("input".into()),
            serde_yaml_ng::Value::Sequence(vec![serde_yaml_ng::Value::String("text".into())]),
        ),
        (serde_yaml_ng::Value::String("tool_use".into()), serde_yaml_ng::Value::Bool(true)),
        (
            serde_yaml_ng::Value::String("contextWindow".into()),
            serde_yaml_ng::Value::Number(serde_yaml_ng::Number::from(1_000_000u64)),
        ),
        (
            serde_yaml_ng::Value::String("maxTokens".into()),
            serde_yaml_ng::Value::Number(serde_yaml_ng::Number::from(131_072u64)),
        ),
    ]));
    p.insert(serde_yaml_ng::Value::String("models".into()), serde_yaml_ng::Value::Sequence(vec![model_item]));
    serde_yaml_ng::to_string(&v).map_err(|e| format!("models.yml 序列化失败: {e}"))
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
    let (endpoint, has_key, model, context_tokens) = read_view_text(&adapter_id, raw.as_deref());
    Ok(HarnessConfigView {
        endpoint,
        has_api_key: has_key,
        model,
        source_file: path.to_string_lossy().into_owned(),
        present,
        context_tokens,
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

    // P39：上下文窗口解析——留空/缺省 = 默认 1M；非法值/超上限报错不写盘
    let context_tokens = parse_context_tokens(input.context_tokens.as_deref())?;

    let new_text = match input.program.as_str() {
        "claude-code" => {
            let merged = crate::harness_meta::merge_available_models(
                existing.as_deref().and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                    .as_ref().and_then(|v| v.get("availableModels")),
                input.probe_models.as_deref().unwrap_or(&[]),
            );
            let mut text = claude_merge_write(existing.as_deref(), &input.endpoint, &input.api_key, &input.model, Some(context_tokens))?;
            // allowlist 合并（serde_json 二次定点，重序列化键序由 preserve_order 保证）
            if let Some(list) = merged {
                let mut v: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| format!("settings.json 解析失败: {e}"))?;
                v["availableModels"] = serde_json::Value::Array(
                    list.into_iter().map(serde_json::Value::String).collect(),
                );
                text = serde_json::to_string_pretty(&v)
                    .map_err(|e| format!("settings.json 序列化失败: {e}"))?;
            }
            text
        }
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
    // omp 专属：OMP 的会话默认模型不读 models.yml 的 models[0]，只认 agent.db
    // settings 表的 modelRoles.default（实测 2026-09-09；yml defaultModel 字段无效）。
    // 不同步它，用户切的模型只落 yml，OMP 新会话仍用旧默认（如本机 ollama 的
    // bge-m3）——侧栏与会话实际模型脱节的根因。
    if input.program == "omp" {
        if let Err(e) = crate::harness_meta::omp_set_default_model(&input.model) {
            // yml 已写成功，默认模型联动失败只告警不回滚（非致命）
            log::warn!("[harness-config] omp 默认模型联动失败: {e}");
        }
    }
    log::info!("[harness-config] {} 配置已写入 {}", input.program, path.display());
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// P30 权限模式开关（仅 claude-code）：settings.json 的 permissions.defaultMode 单键合并写
// ---------------------------------------------------------------------------

/// 开关支持的两种模式（用户认可的语义）：
///   bypass = "bypassPermissions"（全部工具直接放行，无分类器——auto 模式依赖的
///            权限分类器在模型通道故障时会拦死所有 Bash，这是加此开关的根因）
///   auto   = "auto"（Claude 自动判权限，依赖分类器）
pub const PERMISSION_MODE_BYPASS: &str = "bypassPermissions";
pub const PERMISSION_MODE_AUTO: &str = "auto";

/// 纯函数：读 settings.json 文本里的 permissions.defaultMode（缺失/损坏 → None）。
pub fn read_permission_mode(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("permissions")?
        .get("defaultMode")?
        .as_str()
        .map(|s| s.to_string())
}

/// 纯函数：合并写 permissions.defaultMode 单键（无则创建 permissions 对象）。
/// 其余键/键序逐字节不动（json_merge_set preserve_order）。损坏 JSON → Err 不写盘。
pub fn write_permission_mode(raw: Option<&str>, mode: &str) -> Result<String, String> {
    let base_raw = raw.unwrap_or("{}");
    json_merge_set(base_raw, &[("permissions.defaultMode", serde_json::Value::String(mode.into()))])
}

/// 读取当前权限模式回显（开关初值；未配置 → None → 前端按默认开渲染）。
/// P36 扩展：按 adapter 分派——claude-code 读 settings.json defaultMode；
/// omp 读 config.yml tools.approvalMode（yolo = 开）；opencode 读 opencode.json
/// permission 全 allow = 开；codex 读应用托管 keys.json 的 codexPermBypass；
/// pi 无机制 → Err（前端渲染「不支持」态）。
#[tauri::command]
pub fn permission_mode_read(app: tauri::AppHandle, adapter_id: String) -> Result<Option<bool>, String> {
    let home = home_dir()?;
    let read_text = |p: &Path| -> Option<String> {
        p.exists().then(|| std::fs::read_to_string(p).ok()).flatten()
    };
    match adapter_id.as_str() {
        "claude-code" => {
            let path = config_file_for("claude-code", &home).ok_or("无法定位 settings.json")?;
            let raw = read_text(&path);
            // auto → 关；bypass/未配置 → 开（与 P30 语义一致）
            Ok(read_permission_mode(raw.as_deref()).map(|m| m != "auto"))
        }
        "omp" => {
            let path = home.join(".omp/agent/config.yml");
            let raw = read_text(&path);
            // 未配置 = OMP schema 默认 yolo → 开；显式 always-ask/write → 关
            Ok(Some(
                read_omp_approval_mode(raw.as_deref())
                    .map(|m| m == OMP_APPROVAL_YOLO)
                    .unwrap_or(true),
            ))
        }
        "opencode" => {
            let path = config_file_for("opencode", &home).ok_or("无法定位 opencode.json")?;
            let raw = read_text(&path);
            // opencode 默认大多 allow（doom_loop/external_directory 除外），但
            // bash/edit 等无默认 ask 的实证形态下开关初值取「是否全 allow」；
            // 未配置 permission 键 → 视为开（默认已放行，与官方 Defaults 一致）
            Ok(Some(read_opencode_perm_mode(raw.as_deref()).unwrap_or(true)))
        }
        "codex" => {
            let dir = app.path().app_config_dir().ok();
            let path = dir.map(|d| d.join("harness-keys.json"));
            let raw = path.and_then(|p| read_text(&p));
            let bypass = raw
                .as_deref()
                .and_then(|r| serde_json::from_str::<serde_json::Value>(r).ok())
                .and_then(|v| v.get("codexPermBypass").and_then(|b| b.as_bool()).map(|_| ()))
                .and_then(|()| {
                    serde_json::from_str::<serde_json::Value>(raw.as_deref().unwrap())
                        .ok()
                        .and_then(|v| v.get("codexPermBypass").and_then(|b| b.as_bool()))
                });
            // 未配置 → codex-acp 默认 agent 模式（会按需弹）→ 关
            Ok(Some(bypass.unwrap_or(false)))
        }
        "pi" => Err("pi 无权限确认机制".into()),
        other => Err(format!("{other} 不支持权限模式开关")),
    }
}

/// 保存权限模式（开 = 跳过权限确认，关 = 恢复确认；按 adapter 分派落盘）。
/// 损坏文件报错不覆盖；写前备份（与配置代写同一纪律）。
#[tauri::command]
pub fn permission_mode_save(app: tauri::AppHandle, adapter_id: String, mode: String) -> Result<String, String> {
    let bypass = match mode.as_str() {
        "bypassPermissions" => true,
        "auto" => false,
        other => return Err(format!("不支持的权限模式: {other}")),
    };
    let home = home_dir()?;
    let save_file = |path: &Path, new_text: String| -> Result<String, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
        }
        let existing = path.exists().then(|| std::fs::read_to_string(path).ok()).flatten();
        if existing.is_some() {
            let bak = path.with_extension("ainone-bak");
            std::fs::copy(path, &bak).map_err(|e| format!("备份失败: {e}"))?;
        }
        std::fs::write(path, new_text).map_err(|e| format!("写入配置失败: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    };
    match adapter_id.as_str() {
        "claude-code" => {
            let m = if bypass { PERMISSION_MODE_BYPASS } else { PERMISSION_MODE_AUTO };
            let path = config_file_for("claude-code", &home).ok_or("无法定位 settings.json")?;
            let existing = path.exists().then(|| std::fs::read_to_string(&path).ok()).flatten();
            // 损坏文件报错不覆盖（与配置代写同一纪律）
            let new_text = write_permission_mode(existing.as_deref(), m)?;
            if existing.is_some() {
                let bak = path.with_extension("ainone-bak");
                std::fs::copy(&path, &bak).map_err(|e| format!("备份失败: {e}"))?;
            }
            std::fs::write(&path, new_text).map_err(|e| format!("写入配置失败: {e}"))?;
            log::info!("[harness-config] {} permissions.defaultMode → {m}（{}）", adapter_id, path.display());
            Ok(path.to_string_lossy().into_owned())
        }
        "omp" => {
            let m = if bypass { OMP_APPROVAL_YOLO } else { OMP_APPROVAL_ASK };
            let path = home.join(".omp/agent/config.yml");
            let existing = path.exists().then(|| std::fs::read_to_string(&path).ok()).flatten();
            let new_text = write_omp_approval_mode(existing.as_deref(), m)?;
            let written = save_file(&path, new_text)?;
            log::info!("[harness-config] omp tools.approvalMode → {m}");
            Ok(written)
        }
        "opencode" => {
            let path = config_file_for("opencode", &home).ok_or("无法定位 opencode.json")?;
            let existing = path.exists().then(|| std::fs::read_to_string(&path).ok()).flatten();
            let new_text = write_opencode_perm_mode(existing.as_deref(), bypass)?;
            let written = save_file(&path, new_text)?;
            log::info!("[harness-config] opencode permission → {}", if bypass { "allow" } else { "ask" });
            Ok(written)
        }
        "codex" => {
            // codex 无配置文件可写：状态存应用托管 keys.json，spawn 时注入 env
            crate::harness_keys::store_codex_perm_bypass(&app, bypass)?;
            log::info!("[harness-config] codex 权限开关 → bypass={bypass}（INITIAL_AGENT_MODE 注入，对新会话生效）");
            Ok("app://harness-keys.json (INITIAL_AGENT_MODE)".into())
        }
        "pi" => Err("pi 无权限确认机制".into()),
        other => Err(format!("{other} 不支持权限模式开关")),
    }
}

// ---------------------------------------------------------------------------
// P36 权限模式开关扩展（omp / opencode / codex / pi）
//
// 各家机制（2026-09-09 全部本机实测）：
//   claude-code  settings.json permissions.defaultMode（既有实现，见上）
//   omp          ~/.omp/agent/config.yml tools.approvalMode = yolo|write|always-ask
//                （schema 默认 yolo；ACP 端到端：yolo 0 次弹权限，write/always-ask 弹）
//   opencode     ~/.config/opencode/opencode.json permission.{edit,bash,...} = allow|ask
//                （schema 官方 PermissionActionConfig；ask 实测弹 request_permission，
//                allow 全放行）
//   codex        config.toml 无效（codex-acp 每 turn 覆盖 approvalPolicy），
//                唯一持久入口 INITIAL_AGENT_MODE env → harness_keys.rs 托管
//   pi           无权限确认机制（README「No permission popups」）→ 开关不适用
// ---------------------------------------------------------------------------

/// omp approvalMode 的两档映射（跳过 = yolo；恢复确认 = always-ask。
/// write 档只自动放行 write tier，bash 仍弹——与 claude 的 auto 语义对不齐，不用）。
pub const OMP_APPROVAL_YOLO: &str = "yolo";
pub const OMP_APPROVAL_ASK: &str = "always-ask";

/// 纯函数：读 config.yml 文本里的 tools.approvalMode（缺失/损坏 → None）。
pub fn read_omp_approval_mode(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(raw).ok()?;
    v.get("tools")?
        .get("approvalMode")?
        .as_str()
        .map(|s| s.to_string())
}

/// 纯函数：合并写 config.yml 的 tools.approvalMode 单键（serde_yaml_ng 定点改写，
/// 其余键序保留；损坏 YAML → Err 不写盘）。OMP 默认即 yolo，但显式写入键值——
/// 与 claude 开关语义一致（设置页状态可回读，不依赖「默认值恰好等于开关状态」）。
pub fn write_omp_approval_mode(raw: Option<&str>, mode: &str) -> Result<String, String> {
    let mut v: serde_yaml_ng::Value = match raw {
        Some(r) if !r.trim().is_empty() => serde_yaml_ng::from_str(r).map_err(|e| format!("config.yml 解析失败: {e}"))?,
        _ => serde_yaml_ng::Value::Mapping(Default::default()),
    };
    if !v.is_mapping() {
        return Err("config.yml 顶层不是映射".into());
    }
    let tools = match v.get_mut("tools") {
        None => {
            if let Some(map) = v.as_mapping_mut() {
                map.insert(
                    serde_yaml_ng::Value::String("tools".into()),
                    serde_yaml_ng::Value::Mapping(Default::default()),
                );
            }
            v.get_mut("tools").ok_or("config.yml tools 创建失败")?
        }
        Some(t) if !t.is_mapping() => return Err("config.yml tools 不是映射".into()),
        Some(t) => t,
    };
    tools
        .as_mapping_mut()
        .ok_or("config.yml tools 不是映射")?
        .insert(
            serde_yaml_ng::Value::String("approvalMode".into()),
            serde_yaml_ng::Value::String(mode.into()),
        );
    serde_yaml_ng::to_string(&v).map_err(|e| format!("config.yml 序列化失败: {e}"))
}

/// opencode permission 的两档映射（跳过 = 全部 allow；恢复确认 = 全部 ask）。
/// 覆盖键取官方 PermissionConfig 的行为类动作（read/glob/grep 默认即 allow 无需写）。
pub const OPENCODE_PERM_KEYS: &[&str] = &["edit", "bash", "webfetch", "websearch", "question"];

/// 纯函数：读 opencode.json 里的 permission 档位。全部 allow → bypass；
/// 存在任一 ask/deny 或缺 permission 键 → None/ask 语义（前端按关渲染）。
pub fn read_opencode_perm_mode(raw: Option<&str>) -> Option<bool> {
    let raw = raw?;
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let perm = v.get("permission")?.as_object()?;
    // 全部键均为 "allow" 才算 bypass（部分 ask = 未全放行）
    let all_allow = OPENCODE_PERM_KEYS
        .iter()
        .all(|k| perm.get(*k).and_then(|x| x.as_str()) == Some("allow"));
    Some(all_allow)
}

/// 纯函数：合并写 opencode.json 的 permission 单层键（其余键/键序不动）。
pub fn write_opencode_perm_mode(raw: Option<&str>, bypass: bool) -> Result<String, String> {
    let action = if bypass { "allow" } else { "ask" };
    let sets: Vec<(String, serde_json::Value)> = OPENCODE_PERM_KEYS
        .iter()
        .map(|k| (format!("permission.{k}"), serde_json::Value::String(action.into())))
        .collect();
    let refs: Vec<(&str, serde_json::Value)> =
        sets.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    json_merge_set(raw.unwrap_or("{}"), &refs)
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
        let out = claude_merge_write(Some(CLAUDE_FULL), "https://new.example.com", "", "new-model", Some(DEFAULT_CLAUDE_CONTEXT_TOKENS)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://new.example.com");
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-old");
        assert_eq!(v["env"]["API_TIMEOUT_MS"], "3000000");
        assert_eq!(v["permissions"]["allow"][0], "Bash(ls:*)");
        assert_eq!(v["model"], "new-model");
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"], "new-model");
        assert_eq!(v["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "new-model");
        assert!(v.get("hooks").is_some());
        // P39：显式传值 → env 键写入（字符串形态与 Claude Code env 表一致）
        assert_eq!(v["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "1000000");
    }

    #[test]
    fn claude_merge_none_context_tokens_keeps_existing() {
        // P39：context_tokens=None = 不动既有（用户手写 500000 不能被应用抹掉）
        let raw = r#"{"env":{"CLAUDE_CODE_MAX_CONTEXT_TOKENS":"500000"}}"#;
        let out = claude_merge_write(Some(raw), "https://x.com", "", "m", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "500000");
    }

    #[test]
    fn claude_merge_none_context_tokens_omits_key_when_absent() {
        // P39：context_tokens=None 且原文无该键 → 不新增（None 语义 = 完全不触碰）
        let out = claude_merge_write(Some("{}"), "https://x.com", "", "m", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("env").and_then(|e| e.get("CLAUDE_CODE_MAX_CONTEXT_TOKENS")).is_none());
    }

    #[test]
    fn env_key_matches_const() {
        // 字面量路径（json_merge_set 走 &str）必须与 CLAUDE_MAX_CONTEXT_KEY 一致，
        // 否则代写链路与切模型链路会写到两个不同的键上（分叉回归）
        assert_eq!(CLAUDE_MAX_CONTEXT_KEY, "CLAUDE_CODE_MAX_CONTEXT_TOKENS");
        let out = claude_merge_write(Some("{}"), "https://x.com", "", "m", Some(500_000)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"][CLAUDE_MAX_CONTEXT_KEY], "500000");
    }

    #[test]
    fn claude_merge_writes_new_key_when_given() {
        let out = claude_merge_write(Some(CLAUDE_FULL), "https://new.example.com", "sk-new", "m", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-new");
    }

    #[test]
    fn claude_merge_creates_env_when_missing() {
        // 验收 3.2：无 env 对象的新文件 → 创建 env 并写入
        let out = claude_merge_write(None, "https://x.com", "sk", "m", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://x.com");
        assert_eq!(v["model"], "m");
    }

    #[test]
    fn claude_merge_rejects_corrupt_input() {
        // 验收 3.3：损坏 JSON → Err，调用方保证不写盘
        assert!(claude_merge_write(Some("{broken"), "https://x", "", "m", None).is_err());
    }

    #[test]
    fn parse_context_tokens_defaults_and_validates() {
        // P39：空/缺省 = 默认 1M；非法值与 0 报错；超上限钳到 1M
        assert_eq!(parse_context_tokens(None).unwrap(), DEFAULT_CLAUDE_CONTEXT_TOKENS);
        assert_eq!(parse_context_tokens(Some("")).unwrap(), DEFAULT_CLAUDE_CONTEXT_TOKENS);
        assert_eq!(parse_context_tokens(Some("  ")).unwrap(), DEFAULT_CLAUDE_CONTEXT_TOKENS);
        assert_eq!(parse_context_tokens(Some("500000")).unwrap(), 500_000);
        assert!(parse_context_tokens(Some("abc")).is_err());
        assert!(parse_context_tokens(Some("0")).is_err());
        assert_eq!(parse_context_tokens(Some("99999999")).unwrap(), MAX_CLAUDE_CONTEXT_TOKENS);
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

    // ---------------- P32g：key 留空 = 继承既有（omp/pi/opencode 真实事故回归） ----------------

    // 真实事故样例：用户本机 models.yml 自配 zhubaoduo provider（duo-king-6.6），
    // 旧 omp_merge_write 全量重生成把 apiKey 蒸发 → OMP 调用全链 401（2026-09-09）。
    #[test]
    fn omp_merge_inherits_key_from_user_provider_when_blank() {
        let existing = "providers:\n  zhubaoduo:\n    type: openai\n    api: openai-completions\n    baseUrl: https://token.zhubaoduo.com/v1\n    apiKey: sk-keep\n    models:\n      - id: duo-king-6.6\n        context: 128000\n        maxTokens: 8192\n";
        // 场景：设置页在现网关上切模型（endpoint 不变、key 留空）→ key 必须继承
        let out = omp_merge_write(Some(existing), "https://token.zhubaoduo.com/v1", "", "claude-opus-4-7").unwrap();
        let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(&out).unwrap();
        let ainone = &v["providers"]["ainone"];
        assert_eq!(ainone["apiKey"].as_str(), Some("sk-keep"), "key 留空必须继承自配 provider 的 apiKey");
        assert_eq!(ainone["baseUrl"].as_str(), Some("https://token.zhubaoduo.com/v1"));
        assert_eq!(ainone["models"][0]["id"].as_str(), Some("claude-opus-4-7"));
        // 用户自配 provider 原样保留（旧实现整体丢弃——语义突变）
        let z = &v["providers"]["zhubaoduo"];
        assert_eq!(z["apiKey"].as_str(), Some("sk-keep"), "自配 provider 不能被丢弃");
        assert_eq!(z["models"][0]["id"].as_str(), Some("duo-king-6.6"));
    }

    #[test]
    fn omp_merge_blank_key_no_inherit_source_omits_key() {
        // 无任何既有 key（全新/无 key 文件）+ 留空 → 不写 apiKey 行（与 UI 提示一致）
        let out = omp_merge_write(None, "https://x", "", "m1").unwrap();
        let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(&out).unwrap();
        assert!(v["providers"]["ainone"].get("apiKey").is_none());
        assert!(out.contains("baseUrl: https://x"));
    }

    #[test]
    fn omp_merge_declares_anthropic_protocol_and_thinking() {
        // P32g 实测回归：openai-completions 自定义 provider 下 OMP 思考模型
        // empty stop（glm-5.3-flash@aiapi 实测）；anthropic-messages + thinking
        // 声明（efforts 含 max、defaultLevel 高档）后 OMP 端到端回复正常。
        //OMP 官方 glm 家族声明（zai 缓存）同为 anthropic 协议 + low/high/max。
        let out = omp_merge_write(None, "https://gw.example.com", "sk", "saver/glm-5.3-flash").unwrap();
        let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(&out).unwrap();
        let ainone = &v["providers"]["ainone"];
        assert_eq!(ainone["api"].as_str(), Some("anthropic-messages"), "必须用 anthropic 协议");
        let model = &ainone["models"][0];
        assert_eq!(model["reasoning"].as_bool(), Some(true), "必须声明 reasoning");
        let efforts: Vec<&str> = model["thinking"]["efforts"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(|x| x.as_str())
            .collect();
        assert_eq!(efforts, vec!["low", "high", "max"], "efforts 必须含网关接受的三档");
        assert_eq!(model["thinking"]["defaultLevel"].as_str(), Some("high"));
        assert!(model["contextWindow"].as_u64().unwrap() >= 1_000_000);
        assert!(model["maxTokens"].as_u64().unwrap() >= 131_072, "思考需要充足 maxTokens 预算");
    }

    #[test]
    fn omp_merge_explicit_key_overrides_and_corrupt_rejected() {
        // 显式填 key → 覆盖既有（不改继承语义）
        let existing = "providers:\n  ainone:\n    baseUrl: https://old\n    apiKey: sk-old\n    models:\n      - id: old\n";
        let out = omp_merge_write(Some(existing), "https://new", "sk-new", "m").unwrap();
        let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(&out).unwrap();
        assert_eq!(v["providers"]["ainone"]["apiKey"].as_str(), Some("sk-new"));
        // 损坏 YAML → Err 不写盘（与 claude/codex 同纪律）
        assert!(omp_merge_write(Some("{broken: ["), "https://x", "", "m").is_err());
    }

    #[test]
    fn pi_merge_inherits_key_from_user_provider_when_blank() {
        // pi 同根因回归：自配 provider（myprov）+ 新建 ainone + key 留空 → key 继承
        let existing = r#"{"providers":{"myprov":{"baseUrl":"https://p.example","apiKey":"sk-pi-keep","models":[{"id":"old"}]}}}"#;
        let out = pi_merge_write(Some(existing), "https://p.example", "", "new-m").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["providers"]["ainone"]["apiKey"].as_str(), Some("sk-pi-keep"), "key 留空必须继承自配 provider");
        assert_eq!(v["providers"]["ainone"]["baseUrl"].as_str(), Some("https://p.example"));
        // 自配 provider 原样保留
        assert_eq!(v["providers"]["myprov"]["apiKey"].as_str(), Some("sk-pi-keep"));
    }

    #[test]
    fn opencode_merge_inherits_key_from_user_provider_when_blank() {
        let existing = r#"{"provider":{"myprov":{"options":{"baseURL":"https://oc.example/v1","apiKey":"sk-oc-keep"}}},"theme":"dark"}"#;
        let out = opencode_merge_write(Some(existing), "https://oc.example/v1", "", "m1").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["provider"]["ainone"]["options"]["apiKey"].as_str(), Some("sk-oc-keep"), "key 留空必须继承自配 provider");
        assert_eq!(v["provider"]["ainone"]["options"]["baseURL"].as_str(), Some("https://oc.example/v1"));
        assert_eq!(v["theme"].as_str(), Some("dark"), "无关键保留");
        // 自配 provider 原样保留
        assert_eq!(v["provider"]["myprov"]["options"]["apiKey"].as_str(), Some("sk-oc-keep"));
    }

    // ---------------- 旧语义测试（保留部分，收敛到新实现） ----------------

    #[test]
    fn omp_merge_generates_yaml() {
        let out = omp_merge_write(None, "https://x", "sk", "m1").unwrap();
        assert!(out.contains("ainone:"));
        assert!(out.contains("baseUrl: https://x"));
        assert!(out.contains("id: m1"));
        // 显式 key → 写 apiKey 行
        assert!(out.contains("apiKey"));
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

    // ---------------- 验收：读回显 ----------------

    #[test]
    fn read_view_roundtrip() {
        let (ep, has_key, model, ctx) = read_view_text(
            "claude-code",
            Some(r#"{"env":{"ANTHROPIC_BASE_URL":"https://x","ANTHROPIC_AUTH_TOKEN":"sk","CLAUDE_CODE_MAX_CONTEXT_TOKENS":"1000000"},"model":"m[1m]"}"#),
        );
        assert_eq!(ep, "https://x");
        assert!(has_key);
        assert_eq!(model, "m[1m]");
        assert_eq!(ctx, "1000000");

        // 未设置 → 空串（保存时落默认 1M）
        let (_, _, _, ctx) = read_view_text(
            "claude-code",
            Some(r#"{"env":{"ANTHROPIC_BASE_URL":"https://x","ANTHROPIC_AUTH_TOKEN":"sk"},"model":"m"}"#),
        );
        assert_eq!(ctx, "");

        let (ep, has_key, model, _) = read_view_text("pi", Some(r#"{"providers":{"ainone":{"baseUrl":"https://p","apiKey":"sk","models":[{"id":"pm"}]}}}"#));
        assert_eq!(ep, "https://p");
        assert!(has_key);
        assert_eq!(model, "pm");

        let (ep, _, model, _) = read_view_text("codex", Some(CODEX_TOML));
        // 无 ainone provider → 回落读活跃 provider（model_provider="codex"）的 base_url
        assert_eq!(ep, "https://old/v1");
        assert_eq!(model, "gpt-5.4");

        let (_, has_key, _, _) = read_view_text("codex", Some(CODEX_TOML));
        // keys 未存 → false（本机测试环境无 app 配置目录上下文，走 stub 判定）
        let _ = has_key;

        // 缺失/损坏 → 全空
        assert_eq!(read_view_text("pi", None), (String::new(), false, String::new(), String::new()));
        assert_eq!(read_view_text("pi", Some("junk")), (String::new(), false, String::new(), String::new()));
    }

    #[test]
    fn omp_write_then_read_roundtrip_real_shape() {
        // P32g 流程回归：写回后的 models.yml 必须能被读回显正确还原
        // （endpoint/key/模型名三格一致）——用户「探测→点选→保存→再打开设置」
        // 全流程的闭环保障，防「写成功但回显错乱」类回归。
        let existing = "providers:\n  zhubaoduo:\n    type: openai\n    api: openai-completions\n    baseUrl: https://token.zhubaoduo.com/v1\n    apiKey: sk-real\n    models:\n      - id: duo-king-6.6\n        context: 128000\n        maxTokens: 8192\n";
        let written = omp_merge_write(Some(existing), "https://token.zhubaoduo.com/v1", "", "claude-opus-4-7").unwrap();
        let (ep, has_key, model, _) = read_view_text("omp", Some(&written));
        assert_eq!(ep, "https://token.zhubaoduo.com/v1", "写后回显 endpoint 一致");
        assert!(has_key, "写后（key 继承）回显 has_key=true");
        assert_eq!(model, "claude-opus-4-7", "写后回显模型名一致（读首个 provider 模型）");
        // 二次保存（用户再点选一次模型，仍留空 key）→ key 仍在（连续操作不蒸发）
        let written2 = omp_merge_write(Some(&written), "https://token.zhubaoduo.com/v1", "", "glm-5.3-flash").unwrap();
        let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(&written2).unwrap();
        assert_eq!(v["providers"]["ainone"]["apiKey"].as_str(), Some("sk-real"), "二次保存 key 不蒸发");
        let (ep2, has_key2, model2, _) = read_view_text("omp", Some(&written2));
        assert_eq!(ep2, "https://token.zhubaoduo.com/v1");
        assert!(has_key2);
        assert_eq!(model2, "glm-5.3-flash");
    }

    #[test]
    fn pi_write_then_read_roundtrip_user_provider() {
        // pi 同流程闭环：自配 provider + 新建 ainone → 回显应取 ainone（应用代写值最可信）
        let existing = r#"{"providers":{"myprov":{"baseUrl":"https://p.example","apiKey":"sk-pi","models":[{"id":"old"}]}}}"#;
        let written = pi_merge_write(Some(existing), "https://p.example", "", "m-new").unwrap();
        let (ep, has_key, model, _) = read_view_text("pi", Some(&written));
        assert_eq!(ep, "https://p.example");
        assert!(has_key);
        assert_eq!(model, "m-new");
    }

    #[test]
    fn read_view_falls_back_to_user_provider() {
        // S6 反馈缺陷回归：用户自配 provider 名各异（omp 配的是 "zhubaoduo"），
        // 只认 ainone 会让回显全空 → 应回落到首个含 baseUrl 的 provider
        let omp_yaml = "providers:\n  zhubaoduo:\n    type: openai\n    api: openai-completions\n    baseUrl: https://token.zhubaoduo.com/v1\n    apiKey: sk-user\n    models:\n      - id: duo-king-6.6\n        context: 128000\n";
        let (ep, has_key, model, _) = read_view_text("omp", Some(omp_yaml));
        assert_eq!(ep, "https://token.zhubaoduo.com/v1");
        assert!(has_key);
        assert_eq!(model, "duo-king-6.6");

        // pi 同理：自配 provider 名 → 回落读出
        let pi_json = r#"{"providers":{"my-gw":{"baseUrl":"https://mygw/v1","apiKey":"sk","models":[{"id":"m1"}]}}}"#;
        let (ep, has_key, model, _) = read_view_text("pi", Some(pi_json));
        assert_eq!(ep, "https://mygw/v1");
        assert!(has_key);
        assert_eq!(model, "m1");

        // ainone 与用户自配并存 → 优先 ainone（应用代写值最可信）
        let both = r#"{"providers":{"my-gw":{"baseUrl":"https://mygw/v1"},"ainone":{"baseUrl":"https://ainone/v1","apiKey":"sk","models":[{"id":"m2"}]}}}"#;
        let (ep, _, model, _) = read_view_text("pi", Some(both));
        assert_eq!(ep, "https://ainone/v1");
        assert_eq!(model, "m2");
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

    // ---------------- P30 权限模式开关（回归：单键合并写不动其他键） ----------------

    #[test]
    fn permission_mode_read_detects_existing_value() {
        assert_eq!(
            read_permission_mode(Some(r#"{"permissions":{"defaultMode":"auto"},"model":"m"}"#)),
            Some("auto".into())
        );
        // 无 permissions 对象 → None（前端按默认开渲染）
        assert_eq!(read_permission_mode(Some(r#"{"model":"m"}"#)), None);
        // 损坏 JSON → None（不 panic）
        assert_eq!(read_permission_mode(Some("{broken")), None);
        assert_eq!(read_permission_mode(None), None);
    }

    #[test]
    fn permission_mode_write_creates_when_missing() {
        // 键不存在 → 创建 permissions.defaultMode（用户「没有就新增」的诉求）
        let out = write_permission_mode(Some(r#"{"cleanupPeriodDays":30,"model":"m"}"#), PERMISSION_MODE_BYPASS).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["permissions"]["defaultMode"], "bypassPermissions");
        assert_eq!(v["model"], "m", "无关键必须保留");
        assert_eq!(v["cleanupPeriodDays"], 30);
        // 全新文件（None）→ 最小合法 JSON
        let out2 = write_permission_mode(None, PERMISSION_MODE_AUTO).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&out2).unwrap();
        assert_eq!(v2["permissions"]["defaultMode"], "auto");
    }

    #[test]
    fn permission_mode_write_replaces_only_target_key() {
        // 用户「有就修改那一个键」：替换 defaultMode，permissions 内其他键（allow/deny）与
        // 顶层键（env/hooks/键序）逐字节不动——这是本开关与全量覆盖写的分界线
        let raw = r#"{
  "cleanupPeriodDays": 36500,
  "env": {"ANTHROPIC_BASE_URL": "https://x"},
  "permissions": {
    "allow": ["Bash(ls:*)"],
    "defaultMode": "auto"
  },
  "model": "glm-5.3",
  "hooks": {"SessionStart": []}
}"#;
        let out = write_permission_mode(Some(raw), PERMISSION_MODE_BYPASS).unwrap();
        assert!(out.contains("\"allow\""), "permissions.allow 必须保留");
        assert!(out.contains("Bash(ls:*)"));
        assert!(out.contains("\"ANTHROPIC_BASE_URL\""));
        assert!(out.contains("\"hooks\""));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["permissions"]["defaultMode"], "bypassPermissions");
        // 键序保留：cleanupPeriodDays 仍在 env 前（preserve_order）
        let cp = out.find("cleanupPeriodDays").unwrap();
        let env = out.find("ANTHROPIC_BASE_URL").unwrap();
        assert!(cp < env, "原键序应保留: {out}");
    }

    #[test]
    fn permission_mode_write_rejects_corrupt_input() {
        // 损坏 settings.json → Err，调用方保证不覆盖用户文件
        assert!(write_permission_mode(Some("{broken"), PERMISSION_MODE_BYPASS).is_err());
    }

    // ---------------- P36：omp tools.approvalMode 开关 ----------------

    #[test]
    fn omp_approval_read_detects_and_defaults() {
        // 显式 yolo / always-ask / write 三档可读
        assert_eq!(
            read_omp_approval_mode(Some("modelRoles:\n  default: x\ntools:\n  approvalMode: yolo\n")),
            Some("yolo".into())
        );
        assert_eq!(
            read_omp_approval_mode(Some("tools:\n  approvalMode: always-ask\n")),
            Some("always-ask".into())
        );
        // 未配置 → None（read 命令层按 OMP schema 默认 yolo 处理）
        assert_eq!(read_omp_approval_mode(Some("modelRoles:\n  default: x\n")), None);
        assert_eq!(read_omp_approval_mode(None), None);
        // 损坏 YAML → None 不 panic
        assert_eq!(read_omp_approval_mode(Some("{broken: [")), None);
    }

    #[test]
    fn omp_approval_write_preserves_existing_keys() {
        // 真实事故回归基础：config.yml 里已有的 modelRoles 必须原样保留
        let raw = "modelRoles:\n  default: ainone/saver/glm-5.3-flash\n";
        let out = write_omp_approval_mode(Some(raw), OMP_APPROVAL_YOLO).unwrap();
        let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(&out).unwrap();
        assert_eq!(
            v["modelRoles"]["default"].as_str().unwrap(),
            "ainone/saver/glm-5.3-flash",
            "modelRoles 不能丢"
        );
        assert_eq!(v["tools"]["approvalMode"].as_str().unwrap(), "yolo");
        // 切回 always-ask：覆盖同一键而非追加
        let out2 = write_omp_approval_mode(Some(&out), OMP_APPROVAL_ASK).unwrap();
        let v2: serde_yaml_ng::Value = serde_yaml_ng::from_str(&out2).unwrap();
        assert_eq!(v2["tools"]["approvalMode"].as_str().unwrap(), "always-ask");
        assert_eq!(
            v2["modelRoles"]["default"].as_str().unwrap(),
            "ainone/saver/glm-5.3-flash"
        );
    }

    #[test]
    fn omp_approval_write_creates_tools_when_missing() {
        // 全新文件（None）→ 最小合法结构
        let out = write_omp_approval_mode(None, OMP_APPROVAL_YOLO).unwrap();
        let v: serde_yaml_ng::Value = serde_yaml_ng::from_str(&out).unwrap();
        assert_eq!(v["tools"]["approvalMode"].as_str().unwrap(), "yolo");
        // 损坏 YAML → Err 不写盘
        assert!(write_omp_approval_mode(Some("{broken: ["), OMP_APPROVAL_YOLO).is_err());
    }

    // ---------------- P36：opencode permission 开关 ----------------

    #[test]
    fn opencode_perm_read_all_allow_and_partial() {
        // 全 allow → bypass
        assert_eq!(
            read_opencode_perm_mode(Some(
                r#"{"$schema":"x","permission":{"edit":"allow","bash":"allow","webfetch":"allow","websearch":"allow","question":"allow"}}"#
            )),
            Some(true)
        );
        // 部分 ask → 非 bypass
        assert_eq!(
            read_opencode_perm_mode(Some(r#"{"permission":{"bash":"ask"}}"#)),
            Some(false)
        );
        // 无 permission 键 → None（命令层按开渲染——官方 Defaults 大多 allow）
        assert_eq!(read_opencode_perm_mode(Some(r#"{"$schema":"x"}"#)), None);
        assert_eq!(read_opencode_perm_mode(None), None);
        // 损坏 JSON → None
        assert_eq!(read_opencode_perm_mode(Some("{broken")), None);
    }

    #[test]
    fn opencode_perm_write_merges_and_preserves() {
        // 既有 provider/schema 键必须保留（配置代写同纪律）
        let raw = r#"{"$schema":"https://opencode.ai/config.json","model":"ainone/m","permission":{"bash":"ask"}}"#;
        let out = write_opencode_perm_mode(Some(raw), true).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["model"], "ainone/m", "model 键保留");
        assert!(out.contains("opencode.ai/config.json"), "schema 保留");
        for k in OPENCODE_PERM_KEYS {
            assert_eq!(v["permission"][*k], "allow", "permission.{k} 应为 allow");
        }
        // 切回 ask
        let out2 = write_opencode_perm_mode(Some(&out), false).unwrap();
        let v2: serde_json::Value = serde_json::from_str(&out2).unwrap();
        assert_eq!(v2["permission"]["bash"], "ask");
        // 全新文件
        let out3 = write_opencode_perm_mode(None, true).unwrap();
        let v3: serde_json::Value = serde_json::from_str(&out3).unwrap();
        assert_eq!(v3["permission"]["edit"], "allow");
        // 损坏 → Err
        assert!(write_opencode_perm_mode(Some("{broken"), true).is_err());
    }
}
