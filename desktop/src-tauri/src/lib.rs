use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};

/// Windows GUI 程序派生控制台子进程时必须隐藏新控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

mod dream_maintenance;
mod notifications;
mod computer_access;
mod task_worktree;
use task_worktree::{allocate_worktree, directory_is_occupied, release_worktree_if_unchanged, TaskWorktree, WorktreeDisposition};
use dream_maintenance::{
    start as start_dream_maintenance_impl, status as dream_maintenance_status_impl,
    stop as stop_dream_maintenance_impl, DreamMaintenanceState, DreamMaintenanceStatus,
};

const DEFAULT_PREVIEW_BYTES: u64 = 256 * 1024;
const MAX_PREVIEW_BYTES: u64 = 256 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 200;
const RUNTIME_HEARTBEAT_TIMEOUT_MS: u64 = 30_000;
// Stdout heartbeats share the runtime main thread. A synchronous store flush
// or a large event serialization can pause them without the process being
// dead. Once the stderr process heartbeat is flowing, allow that pause before
// treating the event loop as stuck.
const RUNTIME_EVENT_LOOP_STALL_MS: u64 = 120_000;
// A terminal state is emitted before the runtime flushes durable stores and
// disposes provider fibers. Allow that final shutdown to finish while the
// process is heartbeating; only stop a stale process after this grace period.
const RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS: u64 = 120_000;
const RUNTIME_STARTUP_GRACE_MS: u64 = 120_000;
const RUNTIME_WATCHDOG_POLL_MS: u64 = 250;
// A watchdog poll normally blocks at most RUNTIME_WATCHDOG_POLL_MS. A multi-second
// gap means the OS/VM was suspended or starved, so extend watchdog deadlines on wake
// instead of killing live tasks before Node's event loop can emit its next heartbeat.
const RUNTIME_WATCHDOG_SUSPEND_GAP_MS: u64 = 5_000;

struct RuntimeTaskSlot {
    session_id: String,
    pid: Option<u32>,
    run_id: Option<String>,
    approval_request_ids: HashSet<String>,
    clarification_request_ids: HashSet<String>,
    stdin: Option<ChildStdin>,
    started_at_ms: Option<u64>,
    last_heartbeat_at_ms: Option<u64>,
    started_at: Option<Instant>,
    last_heartbeat_at: Option<Instant>,
    heartbeat_seen: bool,
    last_process_heartbeat_at_ms: Option<u64>,
    last_process_heartbeat_at: Option<Instant>,
    process_heartbeat_seen: bool,
    launching: bool,
    cancel_requested: bool,
    job_handle: Option<usize>,
    order: u64,
    /// Directory this task is executing in. Set before the process starts so a
    /// second launch can see that the checkout is already taken.
    workspace_root: Option<PathBuf>,
    /// Present only when this task was moved to a linked git worktree.
    worktree: Option<TaskWorktree>,
}

#[derive(Clone, Default)]
struct AppState {
    workspace_root: Arc<Mutex<Option<PathBuf>>>,
    runtime_slots: Arc<Mutex<HashMap<String, RuntimeTaskSlot>>>,
    runtime_slot_seq: Arc<AtomicU64>,
    runtime_state_lock: Arc<Mutex<()>>,
    dream_maintenance: DreamMaintenanceState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalContextStatus {
    enabled: bool,
    state: &'static str,
    managed: bool,
    running: bool,
    ready: bool,
    pid: Option<u32>,
    started_at_ms: Option<u64>,
    error_code: Option<String>,
}

fn local_context_status() -> LocalContextStatus {
    LocalContextStatus {
        enabled: true,
        state: "LOCAL",
        managed: false,
        running: true,
        ready: true,
        pid: None,
        started_at_ms: None,
        error_code: None,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSnapshot {
    release_channel: String,
    platform: &'static str,
    version: &'static str,
    read_only: bool,
    workspace_read: bool,
    command_execution: bool,
    network_side_effects: bool,
    runtime_ready: bool,
    node_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    build_id: Option<String>,
    model: Option<RuntimeModelSummary>,
    config_loaded: bool,
    context_sidecar: LocalContextStatus,
    dream_maintenance: DreamMaintenanceStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    cells_availability: Option<CellsAvailability>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeModelSummary {
    provider: String,
    protocol: String,
    model: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct ModelConfig {
    schema_version: String,
    provider: String,
    protocol: String,
    model: String,
    #[serde(rename = "baseURL", skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
    api_key_env: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_instructions: Option<String>,
    /// 连续验证配置（runtime model-config.mjs 的 verifier 段）。保持原样双向透传，
    /// 具体取值由 runtime 侧 normalizeContinuousVerifierConfig 校验。
    #[serde(skip_serializing_if = "Option::is_none")]
    verifier: Option<Value>,
    /// 每个模型的上下文上限（token）。接近上限时 runtime 压缩较早的工具记录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_context_limits: Option<std::collections::BTreeMap<String, u32>>,
}

impl Default for ModelConfig {
    fn default() -> Self {
        default_model_config()
    }
}

#[derive(Debug, Deserialize, Serialize)]
struct CatalogRemoteModel {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigResponse {
    config: ModelConfig,
    config_path: String,
    exists: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfigSummary {
    loaded: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CellsAvailability {
    available: bool,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    sandbox_available: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeHealthResponse {
    ok: bool,
    runtime: Option<RuntimeHealthRuntime>,
    config: Option<RuntimeConfigSummary>,
    model: Option<RuntimeModelSummary>,
    error: Option<String>,
    /// Absent on health payloads that are not a windows-desktop / cells probe.
    #[serde(default)]
    cells_availability: Option<CellsAvailability>,
}

#[derive(Debug, Deserialize)]
struct RuntimeHealthRuntime {
    node: Option<String>,
    #[serde(rename = "buildId")]
    build_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceGrant {
    root_label: String,
    /// Absolute path of the workspace root, when it maps to a real directory.
    root_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum WorkspaceEntryKind {
    Directory,
    File,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntry {
    name: String,
    relative_path: String,
    kind: WorkspaceEntryKind,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    relative_path: String,
    content: String,
    content_digest: String,
    total_bytes: u64,
    truncated: bool,
    binary: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTaskResponse {
    ok: bool,
    run_id: Option<String>,
    thread_id: Option<String>,
    thread: Option<Value>,
    roles: Option<Value>,
    text: Option<String>,
    reasoning_chars: Option<u64>,
    tool_rounds: Option<u32>,
    tool_call_count: Option<u32>,
    execution_mode: Option<String>,
    error: Option<String>,
    plugins: Option<Value>,
    tools: Option<Value>,
    workspace: Option<Value>,
    evolution: Option<Value>,
    model: Option<Value>,
    verification: Option<Value>,
    trajectory: Option<Value>,
    context: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCancellation {
    cancelled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProcessStatus {
    running: bool,
    pid: Option<u32>,
    started_at_ms: Option<u64>,
    last_heartbeat_at_ms: Option<u64>,
    healthy: bool,
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// Resolve `%LOCALAPPDATA%\hmCodex\logs` (the same data root the runtime uses
/// for model-config.json / harness-events.json). Falls back to %APPDATA%.
fn desktop_log_dir() -> Option<PathBuf> {
    let root = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("APPDATA"))?;
    Some(PathBuf::from(root).join("hmCodex").join("logs"))
}

fn model_config_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("DDA_MODEL_CONFIG") {
        let path = path.trim();
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    let root = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("APPDATA"))
        .ok_or_else(|| "无法确定模型配置目录".to_string())?;
    Ok(PathBuf::from(root)
        .join("hmCodex")
        .join("model-config.json"))
}

fn default_model_config() -> ModelConfig {
    ModelConfig {
        schema_version: "1.0".to_string(),
        provider: "openai-chat".to_string(),
        protocol: "chat-completions".to_string(),
        model: "mimo-v2.5-pro".to_string(),
        base_url: Some("https://opencode.ai/zen/go/v1".to_string()),
        endpoint: None,
        api_key_env: "OPENCODE_GO_API_KEY".to_string(),
        session_header: Some("x-opencode-session".to_string()),
        custom_instructions: None,
        verifier: None,
        model_context_limits: None,
    }
}

fn required_model_config_text(value: &str, field: &str, maximum: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(format!("模型配置字段无效: {field}"));
    }
    Ok(value.to_string())
}

fn optional_model_config_text(
    value: Option<String>,
    field: &str,
    maximum: usize,
) -> Result<Option<String>, String> {
    value
        .map(|value| required_model_config_text(&value, field, maximum))
        .transpose()
}

fn validate_model_config_url(value: Option<String>, field: &str) -> Result<Option<String>, String> {
    let value = optional_model_config_text(value, field, 2_000)?;
    if let Some(value) = &value {
        let url = url::Url::parse(value).map_err(|_| format!("模型配置地址无效: {field}"))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(format!("模型配置地址无效: {field}"));
        }
    }
    Ok(value)
}

fn valid_context_model_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    if value.chars().count() > 240 {
        return false;
    }
    chars.all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '/' | '-')
    })
}

fn validate_model_context_limits(
    limits: Option<std::collections::BTreeMap<String, u32>>,
) -> Result<Option<std::collections::BTreeMap<String, u32>>, String> {
    let Some(limits) = limits else {
        return Ok(None);
    };
    if limits.is_empty() {
        return Ok(None);
    }
    if limits.len() > 256 {
        return Err("上下文上限最多 256 个模型".to_string());
    }
    let mut cleaned = std::collections::BTreeMap::new();
    let mut seen = std::collections::HashSet::new();
    for (model_id, tokens) in limits {
        let id = model_id.trim();
        if model_id != id
            || !valid_context_model_id(id)
            || !seen.insert(id.to_ascii_lowercase())
        {
            return Err("上下文上限里的模型名无效".to_string());
        }
        if !(8_192..=2_000_000).contains(&tokens) {
            return Err("上下文上限需要是 8192 到 2000000 的整数 token".to_string());
        }
        cleaned.insert(id.to_string(), tokens);
    }
    Ok(Some(cleaned))
}

fn valid_api_key_env(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(character) if character.is_ascii_alphabetic() || character == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn validate_model_config(mut config: ModelConfig) -> Result<ModelConfig, String> {
    if config.schema_version != "1.0" {
        return Err("不支持的模型配置版本".to_string());
    }
    config.provider = required_model_config_text(&config.provider, "provider", 80)?;
    config.protocol = required_model_config_text(&config.protocol, "protocol", 40)?;
    config.model = required_model_config_text(&config.model, "model", 200)?;
    config.api_key_env = required_model_config_text(&config.api_key_env, "apiKeyEnv", 120)?;
    if ![
        "openai",
        "openai-responses",
        "openai-chat",
        "compatible",
        "deepseek",
    ]
    .contains(&config.provider.as_str())
    {
        return Err("不支持的模型 Provider".to_string());
    }
    if !["responses", "chat-completions", "deepseek-harness"].contains(&config.protocol.as_str()) {
        return Err("不支持的模型协议".to_string());
    }
    if config.provider == "deepseek" && config.protocol != "deepseek-harness" {
        return Err("DeepSeek Provider 需要 deepseek-harness 协议".to_string());
    }
    if !valid_api_key_env(&config.api_key_env) {
        return Err("API Key 环境变量名无效".to_string());
    }
    config.base_url = validate_model_config_url(config.base_url, "baseURL")?;
    config.endpoint = validate_model_config_url(config.endpoint, "endpoint")?;
    config.session_header =
        optional_model_config_text(config.session_header, "sessionHeader", 120)?;
    config.custom_instructions = match config.custom_instructions {
        Some(value) => {
            let text = value.trim();
            if text.encode_utf16().count() > 8_000
                || text.chars().any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
            {
                return Err("自定义指令无效：最多 8000 字符，不支持控制字符".to_string());
            }
            if text.is_empty() { None } else { Some(text.to_string()) }
        }
        None => None,
    };
    if let Some(header) = &config.session_header {
        if !header
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
            || [
                "accept",
                "authorization",
                "content-length",
                "content-type",
                "host",
            ]
            .contains(&header.to_ascii_lowercase().as_str())
        {
            return Err("会话 Header 名称无效".to_string());
        }
    }
    config.model_context_limits = validate_model_context_limits(config.model_context_limits)?;
    Ok(config)
}

fn normalize_legacy_model_alias(mut config: ModelConfig) -> ModelConfig {
    if config.provider != "openai-chat" || config.model != "mimo-v2.6" {
        return config;
    }
    let is_open_code_go = config
        .base_url
        .as_deref()
        .or(config.endpoint.as_deref())
        .and_then(|value| url::Url::parse(value).ok())
        .map(|url| {
            url.origin().ascii_serialization() == "https://opencode.ai"
                && url.path().trim_end_matches('/').trim_end_matches("/chat/completions") == "/zen/go/v1"
        })
        .unwrap_or(false);
    if is_open_code_go {
        config.model = "mimo-v2.6-pro".to_string();
    }
    config
}

#[tauri::command]
fn model_config() -> Result<ModelConfigResponse, String> {
    let config_path = model_config_path()?;
    let exists = config_path.is_file();
    let config = if exists {
        let content = fs::read_to_string(&config_path)
            .map_err(|error| format!("读取模型配置失败: {error}"))?;
        let config = serde_json::from_str::<ModelConfig>(content.trim_start_matches('\u{feff}'))
            .map_err(|_| "模型配置不是有效 JSON".to_string())?;
        normalize_legacy_model_alias(validate_model_config(config)?)
    } else {
        default_model_config()
    };
    Ok(ModelConfigResponse {
        config,
        config_path: config_path.to_string_lossy().to_string(),
        exists,
    })
}

/// Read-only: model names the runtime config can actually route to (top-level
/// `model` plus active `models[]` entries, narrowed by the executor allowList
/// when one is set). Used by the desktop to vet a legacy pinned model before
/// migrating it into the Settings default.
fn configured_model_ids_from(document: &Value, primary: &str) -> Vec<String> {
    let allow: Option<Vec<String>> = document
        .pointer("/roleBindings/executor/allowList")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect());
    let mut ids = vec![primary.to_string()];
    if let Some(models) = document.get("models").and_then(Value::as_array) {
        for entry in models {
            let state = entry.get("state").and_then(Value::as_str).unwrap_or("ACTIVE");
            if state == "DISABLED" || state == "QUARANTINED" {
                continue;
            }
            let model_id = entry
                .get("modelId")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str);
            if let (Some(allow), Some(model_id)) = (&allow, model_id) {
                if !allow.iter().any(|item| item == model_id) {
                    continue;
                }
            }
            for key in ["model", "modelId", "id"] {
                if let Some(value) = entry.get(key).and_then(Value::as_str) {
                    if !ids.iter().any(|id| id == value) {
                        ids.push(value.to_string());
                    }
                }
            }
        }
    }
    ids
}

#[tauri::command]
fn configured_model_ids() -> Result<Vec<String>, String> {
    let config_path = model_config_path()?;
    let response = model_config()?;
    if !config_path.is_file() {
        return Ok(vec![response.config.model]);
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|error| format!("读取模型配置失败: {error}"))?;
    let document = serde_json::from_str::<Value>(content.trim_start_matches('\u{feff}'))
        .map_err(|_| "模型配置不是有效 JSON".to_string())?;
    Ok(configured_model_ids_from(&document, &response.config.model))
}

#[tauri::command]
fn save_model_config(config: ModelConfig) -> Result<ModelConfigResponse, String> {
    let config = normalize_legacy_model_alias(validate_model_config(config)?);
    let config_path = model_config_path()?;
    persist_model_config(&config_path, &config)?;
    Ok(ModelConfigResponse {
        config,
        config_path: config_path.to_string_lossy().to_string(),
        exists: true,
    })
}

fn redact_catalog_message(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    let credential_url = message.contains("://") && message.contains('@');
    if lower.contains("authorization") || lower.contains("bearer ") || credential_url {
        return "获取可用模型失败。".to_string();
    }
    message.chars().take(240).collect()
}

fn wait_child_output(mut child: std::process::Child, timeout: Duration) -> Result<std::process::Output, String> {
    let started = Instant::now();
    loop {
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("获取可用模型超时。".to_string());
        }
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|_| "模型目录命令失败。".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return Err("模型目录命令失败。".to_string()),
        }
    }
}

/// Fetch and catalog writes go through the runtime catalog CLI. They do not
/// call `save_model_config` / `persist_model_config`.
fn run_catalog_cli(app: &AppHandle, command: &str, stdin_payload: Option<String>) -> Result<Value, String> {
    let entry = runtime_entrypoint(app)?;
    let cli = entry.with_file_name("provider-model-catalog-cli.mjs");
    if !cli.is_file() {
        return Err("找不到模型目录命令。".to_string());
    }
    let resource_dir = app.path().resource_dir().ok();
    let mut command_process = runtime_command(&cli, resource_dir.as_deref());
    if let Ok(config_path) = model_config_path() {
        command_process.env("DDA_MODEL_CONFIG", &config_path);
    }
    command_process
        .arg(&cli)
        .arg(command)
        .stdin(if stdin_payload.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command_process
        .spawn()
        .map_err(|_| "无法启动模型目录命令。".to_string())?;
    if let Some(payload) = stdin_payload {
        if payload.len() > 256 * 1024 {
            let _ = child.kill();
            let _ = child.wait();
            return Err("模型目录校验失败，未写入。".to_string());
        }
        if let Some(mut stdin) = child.stdin.take() {
            if stdin.write_all(payload.as_bytes()).is_err() {
                let _ = child.kill();
                let _ = child.wait();
                return Err("模型目录命令失败。".to_string());
            }
        }
    }
    let output = wait_child_output(child, Duration::from_secs(35))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err("模型目录命令失败。".to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|value| !value.trim().is_empty())
        .unwrap_or("");
    let value = serde_json::from_str::<Value>(line).map_err(|_| "模型目录命令失败。".to_string())?;
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let message = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("模型目录命令失败。");
        return Err(redact_catalog_message(message));
    }
    if !output.status.success() {
        return Err("模型目录命令失败。".to_string());
    }
    Ok(value)
}

#[tauri::command]
async fn provider_model_catalog(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_catalog_cli(&app, "show", None))
        .await
        .map_err(|_| "读取模型目录失败。".to_string())?
}

#[tauri::command]
async fn fetch_provider_models(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_catalog_cli(&app, "fetch", None))
        .await
        .map_err(|_| "获取可用模型失败。".to_string())?
}

#[tauri::command]
async fn save_provider_model_catalog(
    app: AppHandle,
    provider_key: String,
    checked_ids: Vec<String>,
    remote: Vec<CatalogRemoteModel>,
) -> Result<Value, String> {
    if checked_ids.len() > 256 || remote.len() > 512 || provider_key.len() > 80 {
        return Err("模型目录校验失败，未写入。".to_string());
    }
    let payload = serde_json::to_string(&serde_json::json!({
        "providerKey": provider_key,
        "checkedIds": checked_ids,
        "remote": remote
    }))
    .map_err(|_| "模型目录校验失败，未写入。".to_string())?;
    tauri::async_runtime::spawn_blocking(move || run_catalog_cli(&app, "save", Some(payload)))
        .await
        .map_err(|_| "模型目录写入失败，未修改配置。".to_string())?
}

fn persist_model_config(config_path: &Path, config: &ModelConfig) -> Result<(), String> {
    use std::io::Write;
    let parent = config_path
        .parent()
        .ok_or_else(|| "模型配置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建模型配置目录失败: {error}"))?;
    let mut document = if config_path.is_file() {
        let content = fs::read_to_string(&config_path)
            .map_err(|error| format!("读取原模型配置失败: {error}"))?;
        serde_json::from_str::<Value>(content.trim_start_matches('\u{feff}'))
            .map_err(|_| "原模型配置不是有效 JSON".to_string())?
    } else {
        serde_json::json!({})
    };
    let object = document
        .as_object_mut()
        .ok_or_else(|| "原模型配置不是 JSON 对象".to_string())?;
    let editable =
        serde_json::to_value(&config).map_err(|error| format!("序列化模型配置失败: {error}"))?;
    for key in [
        "schemaVersion",
        "provider",
        "protocol",
        "model",
        "baseURL",
        "endpoint",
        "apiKeyEnv",
        "sessionHeader",
        "customInstructions",
        "verifier",
        "modelContextLimits",
    ] {
        if let Some(value) = editable.get(key) {
            object.insert(key.to_string(), value.clone());
        } else {
            object.remove(key);
        }
    }
    let serialized = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("序列化模型配置失败: {error}"))?;
    if serialized.len() > 32 * 1024 {
        return Err("模型配置超过 32 KB".to_string());
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("创建模型配置临时文件失败: {error}"))?;
    temporary
        .write_all(&serialized)
        .map_err(|error| format!("写入模型配置失败: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("同步模型配置失败: {error}"))?;
    temporary
        .persist(config_path)
        .map_err(|error| format!("保存模型配置失败: {error}"))?;
    Ok(())
}

/// Howard Hinnant's civil-from-days: days since the Unix epoch -> (y, m, d).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

/// ISO-8601 UTC timestamp (milliseconds included) without a date crate.
fn iso_utc_from_ms(ms: u64) -> String {
    let secs = (ms / 1_000) as i64;
    let millis = (ms % 1_000) as u32;
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let secs_of_day = secs.rem_euclid(86_400) as u32;
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Append a best-effort diagnostic line to
/// `%LOCALAPPDATA%\hmCodex\logs\desktop-YYYYMMDD.log` (5MB -> rotate to `.1`).
/// Errors are swallowed on purpose: file logging must never change any result
/// returned to the frontend.
fn append_desktop_log(message: &str) {
    append_desktop_log_at("ERROR", message);
}

fn append_desktop_log_at(level: &str, message: &str) {
    const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
    let Some(dir) = desktop_log_dir() else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let now_ms = unix_time_ms();
    let (year, month, day) = civil_from_days((now_ms / 1_000 / 86_400) as i64);
    let path = dir.join(format!("desktop-{year:04}{month:02}{day:02}.log"));
    if let Ok(metadata) = fs::metadata(&path) {
        if metadata.len() > MAX_LOG_BYTES {
            let _ = fs::rename(&path, path.with_extension("log.1"));
        }
    }
    let line = format!("[{}] [{}] {}\n", iso_utc_from_ms(now_ms), level, message);
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write as _;
        let _ = file.write_all(line.as_bytes());
    }
}

#[tauri::command]
fn runtime_process_status(state: State<'_, AppState>) -> Result<RuntimeProcessStatus, String> {
    runtime_process_status_impl(state.inner())
}

fn runtime_process_status_impl(state: &AppState) -> Result<RuntimeProcessStatus, String> {
    let _state_guard = state
        .runtime_state_lock
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let slots = state
        .runtime_slots
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let newest = slots
        .values()
        .filter(|slot| slot.pid.is_some())
        .max_by_key(|slot| slot.order);
    let pid = newest.and_then(|slot| slot.pid);
    let started_at_ms = newest.and_then(|slot| slot.started_at_ms);
    let last_heartbeat_at_ms = newest.and_then(|slot| {
        match (slot.last_heartbeat_at_ms, slot.last_process_heartbeat_at_ms) {
            (Some(stdout_at), Some(process_at)) => Some(stdout_at.max(process_at)),
            (stdout_at, process_at) => stdout_at.or(process_at),
        }
    });
    let healthy = newest
        .filter(|slot| slot.pid.is_some())
        .is_some_and(|slot| {
            !runtime_liveness_is_stale(
                slot.heartbeat_seen,
                slot.started_at,
                slot.last_heartbeat_at,
                slot.process_heartbeat_seen,
                slot.last_process_heartbeat_at,
                Instant::now(),
            )
        });
    Ok(RuntimeProcessStatus {
        running: pid.is_some(),
        pid,
        started_at_ms,
        last_heartbeat_at_ms,
        healthy,
    })
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
}

fn runtime_heartbeat_is_stale(last_heartbeat_at_ms: Option<u64>, now_ms: u64) -> bool {
    last_heartbeat_at_ms.map_or(true, |heartbeat| {
        now_ms.saturating_sub(heartbeat) > RUNTIME_HEARTBEAT_TIMEOUT_MS
    })
}

fn runtime_instant_heartbeat_is_stale(last_heartbeat_at: Option<Instant>, now: Instant) -> bool {
    last_heartbeat_at.map_or(true, |heartbeat| {
        runtime_heartbeat_is_stale(Some(0), duration_ms(now.saturating_duration_since(heartbeat)))
    })
}

fn runtime_slot_is_stale(
    heartbeat_seen: bool,
    started_at: Option<Instant>,
    last_heartbeat_at: Option<Instant>,
    now: Instant,
) -> bool {
    if heartbeat_seen {
        runtime_instant_heartbeat_is_stale(last_heartbeat_at, now)
    } else {
        let startup_elapsed_ms = started_at
            .map(|started| duration_ms(now.saturating_duration_since(started)))
            .unwrap_or(RUNTIME_STARTUP_GRACE_MS + 1);
        startup_elapsed_ms > RUNTIME_STARTUP_GRACE_MS
    }
}

fn runtime_watchdog_poll_was_suspended(poll_gap_ms: u64) -> bool {
    poll_gap_ms > RUNTIME_WATCHDOG_SUSPEND_GAP_MS
}

fn advance_instant_for_suspend(target: &mut Option<Instant>, now: Instant, suspended: Duration) {
    if let Some(instant) = target.as_mut() {
        *instant = instant
            .checked_add(suspended)
            .map_or(now, |shifted| shifted.min(now));
    }
}

fn advance_slot_timers_for_suspend(
    slot: &mut RuntimeTaskSlot,
    now: Instant,
    now_ms: u64,
    suspended: Duration,
) {
    slot.last_heartbeat_at = Some(now);
    slot.last_heartbeat_at_ms = Some(now_ms);
    if slot.process_heartbeat_seen {
        slot.last_process_heartbeat_at = Some(now);
        slot.last_process_heartbeat_at_ms = Some(now_ms);
    }
    advance_instant_for_suspend(&mut slot.started_at, now, suspended);
}

fn extend_runtime_slot_after_suspend(
    state: &AppState,
    session_id: &str,
    pid: u32,
    now: Instant,
    now_ms: u64,
    suspended: Duration,
    terminal_seen_at: &mut Option<Instant>,
) -> bool {
    advance_instant_for_suspend(terminal_seen_at, now, suspended);
    let Ok(_state_guard) = state.runtime_state_lock.lock() else {
        return false;
    };
    let Ok(mut slots) = state.runtime_slots.lock() else {
        return false;
    };
    let Some(slot) = slots.get_mut(session_id).filter(|slot| slot.pid == Some(pid)) else {
        return false;
    };
    advance_slot_timers_for_suspend(slot, now, now_ms, suspended);
    true
}

fn process_heartbeat_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.len() > 256 || !trimmed.starts_with('{') {
        return false;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(|kind| kind == "runtime_heartbeat")
        })
        .unwrap_or(false)
}

fn note_process_heartbeat(state: &AppState, session_id: &str, pid: u32) {
    let Ok(_state_guard) = state.runtime_state_lock.lock() else {
        return;
    };
    let Ok(mut slots) = state.runtime_slots.lock() else {
        return;
    };
    let Some(slot) = slots.get_mut(session_id) else {
        return;
    };
    if slot.pid != Some(pid) {
        return;
    }
    let now = Instant::now();
    slot.last_process_heartbeat_at = Some(now);
    slot.last_process_heartbeat_at_ms = Some(unix_time_ms());
    slot.process_heartbeat_seen = true;
}

/// Stdout silence is fatal only when no side-channel heartbeat exists. A live
/// stderr heartbeat means the process is still scheduled, so the main thread
/// may block up to RUNTIME_EVENT_LOOP_STALL_MS before the supervisor stops it.
fn runtime_liveness_is_stale(
    heartbeat_seen: bool,
    started_at: Option<Instant>,
    last_heartbeat_at: Option<Instant>,
    process_heartbeat_seen: bool,
    last_process_heartbeat_at: Option<Instant>,
    now: Instant,
) -> bool {
    if process_heartbeat_seen {
        let process_stale = runtime_instant_heartbeat_is_stale(last_process_heartbeat_at, now);
        let event_loop_silent_ms = last_heartbeat_at
            .map(|seen| duration_ms(now.saturating_duration_since(seen)))
            .unwrap_or(u64::MAX);
        return process_stale || event_loop_silent_ms > RUNTIME_EVENT_LOOP_STALL_MS;
    }
    runtime_slot_is_stale(heartbeat_seen, started_at, last_heartbeat_at, now)
}

fn runtime_watchdog_should_stop(stale: bool, terminal_for_ms: Option<u64>) -> bool {
    stale
        && terminal_for_ms.map_or(true, |elapsed| elapsed > RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS)
}

/// Return whether stdout emitted by `pid` still belongs to an active runtime
/// invocation. Cancellation removes the slot before taskkill returns so a late
/// buffered line from the cancelled child cannot be forwarded to the frontend.
fn runtime_process_is_active(state: &AppState, pid: u32) -> bool {
    let Ok(_state_guard) = state.runtime_state_lock.lock() else {
        return false;
    };
    state
        .runtime_slots
        .lock()
        .map(|slots| slots.values().any(|slot| slot.pid == Some(pid)))
        .unwrap_or(false)
}

fn handle_runtime_stdout_line(
    app: &AppHandle,
    state: &AppState,
    session_id: &str,
    pid: u32,
    line: &str,
    stdout_text: &mut String,
) {
    stdout_text.push_str(line);
    let Ok(mut value) = serde_json::from_str::<Value>(line.trim()) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("runtime_event") {
        return;
    }
    let now_ms = unix_time_ms();
    let now = Instant::now();
    let is_active = {
        let Ok(_state_guard) = state.runtime_state_lock.lock() else {
            return;
        };
        let Ok(mut slots) = state.runtime_slots.lock() else {
            return;
        };
        let Some(slot) = slots.get_mut(session_id) else {
            return;
        };
        if slot.pid != Some(pid) {
            return;
        }
        slot.last_heartbeat_at_ms = Some(now_ms);
        slot.last_heartbeat_at = Some(now);
        if value.get("kind").and_then(Value::as_str) == Some("runtime.heartbeat") {
            slot.heartbeat_seen = true;
        }
        if let Some(run_id) = value.get("runId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            slot.run_id = Some(run_id.to_string());
        }
        if value.get("kind").and_then(Value::as_str) == Some("approval.requested") {
            if let Some(request_id) = value
                .get("payload")
                .and_then(|p| p.get("requestId"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                slot.approval_request_ids.insert(request_id.to_string());
            }
        }
        if value.get("kind").and_then(Value::as_str) == Some("clarification.requested") {
            if let Some(request_id) = value
                .get("payload")
                .and_then(|p| p.get("requestId"))
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            {
                slot.clarification_request_ids.insert(request_id.to_string());
            }
        }
        true
    };
    if !is_active {
        return;
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "clientSessionId".to_string(),
            Value::String(session_id.to_string()),
        );
    }
    let _ = app.emit("runtime-event", value);
}

/// Reserve an independent task slot before scheduling its blocking worker so
/// immediate cancellation can target a launch before spawn while allowing
/// multiple tasks to run in parallel.
fn reserve_runtime_launch(state: &AppState, session_id: Option<&str>) -> Result<String, String> {
    let _state_guard = state
        .runtime_state_lock
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let mut slots = state
        .runtime_slots
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let order = state.runtime_slot_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let resolved_id = match session_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(explicit) => {
            if explicit.len() > 160 || explicit.chars().any(|ch| ch.is_control()) {
                return Err("任务会话标识无效".to_string());
            }
            if slots.contains_key(explicit) {
                return Err("该会话已有任务正在运行".to_string());
            }
            explicit.to_string()
        }
        None => format!("session-{}-{order}", unix_time_ms()),
    };
    slots.insert(
        resolved_id.clone(),
        RuntimeTaskSlot {
            session_id: resolved_id.clone(),
            pid: None,
            run_id: None,
            approval_request_ids: HashSet::new(),
            clarification_request_ids: HashSet::new(),
            stdin: None,
            started_at_ms: None,
            last_heartbeat_at_ms: None,
            started_at: None,
            last_heartbeat_at: None,
            heartbeat_seen: false,
            last_process_heartbeat_at_ms: None,
            last_process_heartbeat_at: None,
            process_heartbeat_seen: false,
            launching: true,
            cancel_requested: false,
            job_handle: None,
            order,
            workspace_root: None,
            worktree: None,
        },
    );
    Ok(resolved_id)
}

fn clear_runtime_launch_reservation(state: &AppState, session_id: &str) {
    let removed = {
        let Ok(_state_guard) = state.runtime_state_lock.lock() else {
            return;
        };
        let Ok(mut slots) = state.runtime_slots.lock() else {
            return;
        };
        if slots.get(session_id).is_some_and(|slot| slot.pid.is_none()) {
            slots.remove(session_id)
        } else {
            None
        }
    };
    let Some(removed) = removed else {
        return;
    };
    if let Some(handle) = removed.job_handle {
        close_job_handle(handle);
    }
    release_task_worktree(removed.worktree);
}

fn release_task_worktree(worktree: Option<TaskWorktree>) {
    let Some(worktree) = worktree else {
        return;
    };
    match release_worktree_if_unchanged(&worktree) {
        WorktreeDisposition::Removed => append_desktop_log(&format!(
            "removed task worktree path={} branch={}",
            worktree.path.display(),
            worktree.branch
        )),
        WorktreeDisposition::Kept { reason } => append_desktop_log(&format!(
            "kept task worktree path={} branch={} reason={reason}",
            worktree.path.display(),
            worktree.branch
        )),
    }
}

/// The first live task keeps `requested`. A later task for that same directory
/// gets a linked worktree so the two do not share one workspace lease.
fn claim_task_workspace(state: &AppState, session_id: &str, requested: &Path) -> Result<PathBuf, String> {
    let requested = requested.canonicalize()
        .map_err(|error| format!("无法解析工作区路径: {error}"))?;
    let needs_worktree = {
        let _state_guard = state.runtime_state_lock.lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        let mut slots = state.runtime_slots.lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        if !slots.contains_key(session_id) || slots.get(session_id).is_some_and(|slot| slot.cancel_requested) {
            return Err("Cordis runtime 已在启动前取消".to_string());
        }
        let occupied: Vec<PathBuf> = slots.values()
            .filter(|other| other.session_id != session_id && !other.cancel_requested)
            .filter_map(|other| other.workspace_root.clone())
            .collect();
        if directory_is_occupied(&requested, &occupied) {
            true
        } else if let Some(slot) = slots.get_mut(session_id) {
            slot.workspace_root = Some(requested.clone());
            false
        } else {
            return Err("Cordis runtime 已在启动前取消".to_string());
        }
    };
    if !needs_worktree {
        return Ok(requested);
    }
    let worktree = allocate_worktree(&requested, session_id)?;
    let path = worktree.workspace.clone();
    let attach = {
        let state_guard = state.runtime_state_lock.lock();
        let slots = state.runtime_slots.lock();
        match (state_guard, slots) {
            (Ok(_state_guard), Ok(mut slots)) => match slots.get_mut(session_id) {
                Some(slot) if !slot.cancel_requested => {
                    slot.workspace_root = Some(path.clone());
                    slot.worktree = Some(worktree);
                    Ok(())
                }
                _ => Err(worktree),
            },
            _ => Err(worktree),
        }
    };
    if let Err(worktree) = attach {
        release_task_worktree(Some(worktree));
        return Err("Cordis runtime 已在启动前取消".to_string());
    }
    Ok(path)
}

fn task_worktree_branch(state: &AppState, session_id: &str) -> Option<String> {
    let Ok(_state_guard) = state.runtime_state_lock.lock() else {
        return None;
    };
    let Ok(slots) = state.runtime_slots.lock() else {
        return None;
    };
    slots.get(session_id).and_then(|slot| slot.worktree.as_ref().map(|worktree| worktree.branch.clone()))
}

#[tauri::command]
async fn runtime_snapshot(app: AppHandle, state: State<'_, AppState>) -> Result<RuntimeSnapshot, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime_snapshot_impl(app, &state))
        .await.map_err(|error| error.to_string())?
}

fn runtime_snapshot_impl(app: AppHandle, state: &AppState) -> Result<RuntimeSnapshot, String> {
    let release_channel = desktop_release_channel()?;
    let runtime = runtime_entrypoint(&app)?;
    let resource_dir = app.path().resource_dir().ok();
    let output = runtime_command(&runtime, resource_dir.as_deref())
        .arg(runtime)
        .arg("health")
        .output()
        .map_err(|error| {
            append_desktop_log(&format!("runtime 健康检查 spawn 失败: {error}"));
            format!("无法启动 Cordis runtime 健康检查: {error}")
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&output.stderr);
            format!(
                "Cordis runtime 健康检查没有返回结果{}",
                bounded_process_error(&stderr)
            )
        })?;
    let health = parse_runtime_health_line(line)?;
    if !output.status.success() || !health.ok {
        let detail = health
            .error
            .as_deref()
            .map(|value| format!(": {value}"))
            .unwrap_or_default();
        return Err(format!("Cordis runtime 健康检查失败{detail}"));
    }
    let (node_version, build_id) = health.runtime.map(|runtime| (runtime.node, runtime.build_id)).unwrap_or_default();
    let config_loaded = health.config.map(|config| config.loaded).unwrap_or(false);
    Ok(RuntimeSnapshot {
        release_channel,
        platform: "WINDOWS",
        version: env!("CARGO_PKG_VERSION"),
        read_only: false,
        workspace_read: true,
        command_execution: true,
        network_side_effects: false,
        runtime_ready: true,
        node_version,
        build_id,
        model: health.model,
        config_loaded,
        context_sidecar: local_context_status(),
        dream_maintenance: dream_maintenance_status_impl(&state.dream_maintenance),
        cells_availability: health.cells_availability,
    })
}

#[tauri::command]
fn context_sidecar_status() -> LocalContextStatus {
    local_context_status()
}

fn parse_runtime_health_line(line: &str) -> Result<RuntimeHealthResponse, String> {
    serde_json::from_str::<RuntimeHealthResponse>(line)
        .map_err(|error| format!("Cordis runtime 健康检查返回了无效结果: {error}"))
}

#[tauri::command]
fn choose_workspace(state: State<'_, AppState>) -> Result<WorkspaceGrant, String> {
    let selected = rfd::FileDialog::new()
        .set_title("选择只读项目目录")
        .pick_folder()
        .ok_or_else(|| "cancelled".to_string())?;
    let root =
        normalize_existing_dir(selected).map_err(|error| format!("无法解析所选目录: {error}"))?;
    if !root.is_dir() {
        return Err("所选路径不是目录".to_string());
    }

    let root_label = workspace_root_label(&root);
    let root_path = Some(root.display().to_string());
    let mut workspace_root = state
        .workspace_root
        .lock()
        .map_err(|_| "工作区状态不可用".to_string())?;
    *workspace_root = Some(root);

    Ok(WorkspaceGrant {
        root_label,
        root_path,
    })
}

#[tauri::command]
fn set_workspace(state: State<'_, AppState>, path: String) -> Result<WorkspaceGrant, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("工作区路径不能为空".to_string());
    }
    let root = normalize_existing_dir(PathBuf::from(trimmed))
        .map_err(|error| format!("无法解析工作区路径: {error}"))?;
    if !root.is_dir() {
        return Err("工作区路径不是目录".to_string());
    }

    let root_label = workspace_root_label(&root);
    let root_path = Some(root.display().to_string());
    let mut workspace_root = state
        .workspace_root
        .lock()
        .map_err(|_| "工作区状态不可用".to_string())?;
    *workspace_root = Some(root);

    Ok(WorkspaceGrant {
        root_label,
        root_path,
    })
}

#[tauri::command]
fn default_workspace(app: AppHandle, state: State<'_, AppState>) -> Result<WorkspaceGrant, String> {
    let root = default_workspace_root(&app)?;
    let root_label = workspace_root_label(&root);
    let root_path = Some(root.display().to_string());
    let mut workspace_root = state
        .workspace_root
        .lock()
        .map_err(|_| "工作区状态不可用".to_string())?;
    *workspace_root = Some(root);
    Ok(WorkspaceGrant {
        root_label,
        root_path,
    })
}

#[tauri::command]
async fn list_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    relative_path: String,
) -> Result<Vec<WorkspaceEntry>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = ensure_default_workspace(&app, &state)?;
        list_workspace_impl(Some(&root), &relative_path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_workspace_file(
    app: AppHandle,
    state: State<'_, AppState>,
    relative_path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = ensure_default_workspace(&app, &state)?;
        read_workspace_file_impl(Some(&root), &relative_path, max_bytes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_threads(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_runtime_json(&app, &["thread", "--operation", "list", "--summary", "true"]))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn runtime_dashboard(app: AppHandle, details: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if details.unwrap_or(false) {
            run_runtime_json(&app, &["dashboard", "--timeline-limit", "0"])
        } else {
            run_runtime_json(&app, &["dashboard", "--summary", "true"])
        }
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn runtime_timeline_page(app: AppHandle, cursor: u32, limit: u32) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cursor = cursor.to_string();
        let limit = limit.to_string();
        run_runtime_json(
            &app,
            &[
                "read-model",
                "--timeline-cursor",
                cursor.as_str(),
                "--timeline-limit",
                limit.as_str(),
            ],
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_thread(app: AppHandle, thread_id: String) -> Result<Value, String> {
    if thread_id.trim().is_empty() {
        return Err("threadId 不能为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_runtime_json(
            &app,
            &[
                "thread",
                "--operation",
                "get",
                "--thread-id",
                thread_id.as_str(),
            ],
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_thread_events(app: AppHandle, thread_id: String, limit: Option<u32>, before: Option<String>) -> Result<Value, String> {
    if thread_id.trim().is_empty() {
        return Err("threadId 不能为空".to_string());
    }
    let limit = limit.unwrap_or(100);
    if !(1..=500).contains(&limit) || before.as_ref().is_some_and(|value| value.len() > 2048) {
        return Err("THREAD_HISTORY_PAGE_INVALID".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let limit = limit.to_string();
        let mut args = vec!["thread-events", "--thread-id", thread_id.as_str(), "--limit", limit.as_str()];
        if let Some(before) = before.as_deref() { args.extend(["--before", before]); }
        run_runtime_json(&app, &args)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn archive_thread_events(
    app: AppHandle,
    thread_id: String,
    restore: Option<bool>,
    vacuum: Option<bool>,
) -> Result<Value, String> {
    let thread_id = thread_id.trim().to_string();
    if thread_id.is_empty() || thread_id.len() > 240 {
        return Err("threadId 无效".to_string());
    }
    let operation = if restore.unwrap_or(false) { "restore-thread" } else { "archive-thread" };
    let vacuum_flag = if vacuum.unwrap_or(false) { "true" } else { "false" };
    tauri::async_runtime::spawn_blocking(move || {
        run_runtime_json(
            &app,
            &[
                "harness-events",
                operation,
                "--thread-id",
                thread_id.as_str(),
                "--vacuum",
                vacuum_flag,
            ],
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn archive_threads(
    app: AppHandle,
    thread_ids: Vec<String>,
    vacuum: Option<bool>,
) -> Result<Value, String> {
    if thread_ids.is_empty()
        || thread_ids.len() > 500
        || thread_ids.iter().any(|id| {
            let id = id.trim();
            id.is_empty() || id.len() > 240
        })
    {
        return Err("threadId 无效".to_string());
    }
    let payload = serde_json::to_string(&thread_ids).map_err(|error| error.to_string())?;
    let vacuum_flag = if vacuum.unwrap_or(false) { "true" } else { "false" };
    tauri::async_runtime::spawn_blocking(move || {
        run_runtime_json(
            &app,
            &[
                "harness-events",
                "archive-threads",
                "--thread-ids",
                payload.as_str(),
                "--vacuum",
                vacuum_flag,
            ],
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn vacuum_event_store(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_runtime_json(&app, &["harness-events", "vacuum"]))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn fork_thread(app: AppHandle, thread_id: String, title: Option<String>) -> Result<Value, String> {
    if thread_id.trim().is_empty() {
        return Err("threadId 不能为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec![
            "thread",
            "--operation",
            "fork",
            "--thread-id",
            thread_id.as_str(),
        ];
        let title_value;
        if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
            title_value = title;
            args.extend(["--title", title_value.as_str()]);
        }
        run_runtime_json(&app, &args)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_execution_state(app: AppHandle, record_type: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || list_execution_state_blocking(app, record_type))
        .await.map_err(|error| error.to_string())?
}

fn list_execution_state_blocking(app: AppHandle, record_type: Option<String>) -> Result<Value, String> {
    let mut args = vec!["execution-state", "--operation", "list"];
    let record_type_value;
    if let Some(record_type) = record_type.filter(|value| !value.trim().is_empty()) {
        if !["intent", "approval", "lease"].contains(&record_type.as_str()) {
            return Err("执行记录类型无效".to_string());
        }
        record_type_value = record_type;
        args.extend(["--record-type", record_type_value.as_str()]);
    }
    run_runtime_json(&app, &args)
}

#[tauri::command]
async fn get_execution_state(app: AppHandle, record_id: String) -> Result<Value, String> {
    if record_id.trim().is_empty() {
        return Err("recordId 不能为空".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        run_runtime_json(
            &app,
            &[
                "execution-state",
                "--operation",
                "get",
                "--record-id",
                record_id.as_str(),
            ],
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reconcile_execution_state(app: AppHandle) -> Result<Value, String> {
    // Governance adapters are hosted by the runtime process.
    tauri::async_runtime::spawn_blocking(move || {
        run_runtime_json(&app, &["execution-state", "--operation", "reconcile"])
    })
    .await
    .map_err(|error| error.to_string())?
}

fn mutate_execution_record(
    app: &AppHandle,
    operation: &str,
    record_id: String,
    expected_digest: Option<String>,
    reason: &str,
) -> Result<Value, String> {
    let record_id = required_runtime_argument(Some(record_id), "recordId")?;
    if !["cancel-approval", "revoke-lease"].contains(&operation) {
        return Err("执行状态操作无效".to_string());
    }
    let mut args = vec!["execution-state".to_string(), "--operation".to_string(), operation.to_string(), "--record-id".to_string(), record_id];
    if let Some(expected_digest) = expected_digest.filter(|value| !value.trim().is_empty()) {
        args.extend(["--expected-digest".to_string(), expected_digest]);
    }
    args.extend(["--reason".to_string(), reason.to_string()]);
    run_runtime_json_owned(app, &args)
}

#[tauri::command]
async fn cancel_execution_approval(
    app: AppHandle,
    record_id: String,
    expected_digest: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mutate_execution_record(&app, "cancel-approval", record_id, expected_digest, "USER_RECOVERY_CANCELLED")
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn revoke_execution_lease(
    app: AppHandle,
    record_id: String,
    expected_digest: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mutate_execution_record(&app, "revoke-lease", record_id, expected_digest, "USER_RECOVERY_REVOKED")
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_task_result(app: AppHandle, file_name: String, content: String) -> Result<Value, String> {
    if !file_name.starts_with("task-result-") || !file_name.ends_with(".md")
        || file_name.len() > 160
        || !file_name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err("导出文件名无效".to_string());
    }
    if content.trim().is_empty() || content.len() > 16 * 1024 * 1024 {
        return Err("导出内容为空或超过 16 MB，请缩小导出范围".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new()
            .set_title("保存当前任务结果")
            .add_filter("Markdown 文档", &["md"])
            .set_file_name(&file_name);
        if let Ok(directory) = app.path().document_dir() {
            dialog = dialog.set_directory(directory);
        }
        let Some(path) = dialog.save_file() else {
            return Ok(serde_json::json!({ "ok": false, "cancelled": true }));
        };
        fs::write(&path, content.as_bytes())
            .map_err(|error| "保存任务结果失败：".to_owned() + &error.to_string())?;
        Ok(serde_json::json!({ "ok": true, "output": path.to_string_lossy() }))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn export_data(app: AppHandle, scope: String) -> Result<Value, String> {
    let scope = required_runtime_argument(Some(scope), "scope")?;
    if !["all", "runs", "settings"].contains(&scope.as_str()) {
        return Err("导出范围无效".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录: {error}"))?.join("exports");
        fs::create_dir_all(&dir).map_err(|error| format!("创建导出目录失败: {error}"))?;
        let output = dir.join(format!("export-{}-{}.json", scope, SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()));
        let output_string = output.to_string_lossy().to_string();
        let args = vec!["export-data".to_string(), "--scope".to_string(), scope, "--output".to_string(), output_string.clone()];
        let mut result = run_runtime_json_owned(&app, &args)?;
        if let Some(object) = result.as_object_mut() { object.insert("output".to_string(), Value::String(output_string)); }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reconcile_runtime_state(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    // Run the same recovery scan used at task startup, but expose it to the
    // desktop bootstrap so orphaned approvals and role contexts are closed
    // before the user submits another task. Recovery never replays work.
    let mut args = vec!["recovery".to_string()];
    if let Ok(root) = ensure_default_workspace(&app, &state) {
        args.extend(["--workspace".to_string(), root.to_string_lossy().to_string()]);
    }
    tauri::async_runtime::spawn_blocking(move || run_runtime_json_owned(&app, &args))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_memories(app: AppHandle, status: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || list_memories_blocking(app, status))
        .await.map_err(|error| error.to_string())?
}

fn list_memories_blocking(app: AppHandle, status: Option<String>) -> Result<Value, String> {
    let mut args = vec![
        "memory".to_string(),
        "--operation".to_string(),
        "list".to_string(),
    ];
    if let Some(status) = status.filter(|value| !value.trim().is_empty()) {
        let status = required_runtime_argument(Some(status), "status")?.to_ascii_uppercase();
        if ![
            "PROPOSED",
            "VERIFIED",
            "REJECTED",
            "ACTIVE",
            "RETRACTED",
            "EXPIRED",
            "PRUNED",
        ]
        .contains(&status.as_str())
        {
            return Err("status 无效".to_string());
        }
        args.extend(["--status".to_string(), status]);
    }
    run_runtime_json_owned(&app, &args)
}

fn required_runtime_argument(value: Option<String>, name: &str) -> Result<String, String> {
    let value = value.ok_or_else(|| format!("{name} 不能为空"))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(format!("{name} 不能为空"));
    }
    if value.len() > 16 * 1024 || value.chars().any(char::is_control) {
        return Err(format!("{name} 无效"));
    }
    Ok(value)
}

fn optional_runtime_argument(
    args: &mut Vec<String>,
    flag: &str,
    value: Option<String>,
    name: &str,
) -> Result<(), String> {
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        args.extend([
            flag.to_string(),
            required_runtime_argument(Some(value), name)?,
        ]);
    }
    Ok(())
}

#[tauri::command]
async fn memory_action(
    app: AppHandle,
    operation: String,
    memory_id: Option<String>,
    statement: Option<String>,
    scope: Option<String>,
    confidence: Option<f64>,
    accepted: Option<bool>,
    reason: Option<String>,
    source_event_ids: Option<Vec<String>>,
    sensitivity: Option<String>,
    conflicts_with_memory_ids: Option<Vec<String>>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        memory_action_blocking(
            app,
            operation,
            memory_id,
            statement,
            scope,
            confidence,
            accepted,
            reason,
            source_event_ids,
            sensitivity,
            conflicts_with_memory_ids,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn memory_action_blocking(
    app: AppHandle,
    operation: String,
    memory_id: Option<String>,
    statement: Option<String>,
    scope: Option<String>,
    confidence: Option<f64>,
    accepted: Option<bool>,
    reason: Option<String>,
    source_event_ids: Option<Vec<String>>,
    sensitivity: Option<String>,
    conflicts_with_memory_ids: Option<Vec<String>>,
) -> Result<Value, String> {
    let operation = required_runtime_argument(Some(operation), "operation")?.to_ascii_lowercase();
    if !["propose", "edit", "resolve-conflict", "verify", "activate", "retract", "delete"].contains(&operation.as_str()) {
        return Err("memory operation 无效".to_string());
    }
    let mut args = vec![
        "memory".to_string(),
        "--operation".to_string(),
        operation.clone(),
    ];
    match operation.as_str() {
        "propose" | "edit" => {
            if operation == "propose" {
                let statement = required_runtime_argument(statement, "statement")?;
                args.extend(["--statement".to_string(), statement]);
            } else if let Some(statement) = statement.filter(|value| !value.trim().is_empty()) {
                args.extend(["--statement".to_string(), required_runtime_argument(Some(statement), "statement")?]);
            }
            optional_runtime_argument(&mut args, "--scope", scope, "scope")?;
            optional_runtime_argument(&mut args, "--sensitivity", sensitivity, "sensitivity")?;
            if let Some(confidence) = confidence {
                if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
                    return Err("confidence 必须在 0 到 1 之间".to_string());
                }
                args.extend(["--confidence".to_string(), confidence.to_string()]);
            }
            if let Some(memory_id) = memory_id {
                args.extend(["--memory-id".to_string(), required_runtime_argument(Some(memory_id), "memoryId")?]);
            } else if operation == "edit" {
                return Err("memoryId 不能为空".to_string());
            }
            if let Some(source_event_ids) = source_event_ids {
                if source_event_ids.len() > 32 {
                    return Err("sourceEventIds 最多 32 个".to_string());
                }
                let mut normalized = Vec::with_capacity(source_event_ids.len());
                for source_event_id in source_event_ids {
                    normalized.push(required_runtime_argument(Some(source_event_id), "sourceEventId")?);
                }
                if normalized.iter().collect::<HashSet<_>>().len() != normalized.len() {
                    return Err("sourceEventIds 不能重复".to_string());
                }
                let encoded = serde_json::to_string(&normalized).map_err(|_| "sourceEventIds 无效".to_string())?;
                args.extend(["--source-event-ids".to_string(), encoded]);
            }
            if let Some(conflicts) = conflicts_with_memory_ids {
                if conflicts.len() > 32 { return Err("conflictsWithMemoryIds 最多 32 个".to_string()); }
                let mut normalized = Vec::with_capacity(conflicts.len());
                for conflict in conflicts {
                    normalized.push(required_runtime_argument(Some(conflict), "conflictMemoryId")?);
                }
                if normalized.iter().collect::<HashSet<_>>().len() != normalized.len() { return Err("conflictsWithMemoryIds 不能重复".to_string()); }
                let encoded = serde_json::to_string(&normalized).map_err(|_| "conflictsWithMemoryIds 无效".to_string())?;
                args.extend(["--conflicts-with-memory-ids".to_string(), encoded]);
            }
        }
        "resolve-conflict" => {
            let memory_id = required_runtime_argument(memory_id, "memoryId")?;
            args.extend(["--memory-id".to_string(), memory_id]);
            optional_runtime_argument(&mut args, "--reason", reason, "reason")?;
        }
        "verify" => {
            let memory_id = required_runtime_argument(memory_id, "memoryId")?;
            args.extend(["--memory-id".to_string(), memory_id]);
            if let Some(accepted) = accepted {
                args.extend(["--accepted".to_string(), accepted.to_string()]);
            }
            optional_runtime_argument(&mut args, "--reason", reason, "reason")?;
        }
        "activate" => {
            let memory_id = required_runtime_argument(memory_id, "memoryId")?;
            args.extend(["--memory-id".to_string(), memory_id]);
        }
        "retract" => {
            let memory_id = required_runtime_argument(memory_id, "memoryId")?;
            args.extend(["--memory-id".to_string(), memory_id]);
            optional_runtime_argument(&mut args, "--reason", reason, "reason")?;
        }
        "delete" => {
            let memory_id = required_runtime_argument(memory_id, "memoryId")?;
            args.extend(["--memory-id".to_string(), memory_id]);
        }
        _ => unreachable!(),
    }
    run_runtime_json_owned(&app, &args)
}

#[tauri::command]
async fn list_dream_runs(app: AppHandle, project_id: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || list_dream_runs_blocking(app, project_id))
        .await.map_err(|error| error.to_string())?
}

fn list_dream_runs_blocking(app: AppHandle, project_id: Option<String>) -> Result<Value, String> {
    let mut args = vec![
        "dream".to_string(),
        "--operation".to_string(),
        "list".to_string(),
    ];
    optional_runtime_argument(&mut args, "--project-id", project_id, "projectId")?;
    run_runtime_json_owned(&app, &args)
}

#[tauri::command]
async fn run_dream(
    app: AppHandle,
    project_id: Option<String>,
    idle: Option<bool>,
    safety_allowed: Option<bool>,
    active_runs: Option<i64>,
) -> Result<Value, String> {
    let mut args = vec![
        "dream".to_string(),
        "--operation".to_string(),
        "run".to_string(),
    ];
    optional_runtime_argument(&mut args, "--project-id", project_id, "projectId")?;
    if let Some(idle) = idle {
        args.extend(["--idle".to_string(), idle.to_string()]);
    }
    if let Some(safety_allowed) = safety_allowed {
        args.extend(["--safety-allowed".to_string(), safety_allowed.to_string()]);
    }
    if let Some(active_runs) = active_runs {
        if !(0..=1024).contains(&active_runs) {
            return Err("activeRuns 必须在 0 到 1024 之间".to_string());
        }
        args.extend(["--active-runs".to_string(), active_runs.to_string()]);
    }
    tauri::async_runtime::spawn_blocking(move || run_runtime_json_owned(&app, &args))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn dream_maintenance_status(state: State<'_, AppState>) -> DreamMaintenanceStatus {
    dream_maintenance_status_impl(&state.dream_maintenance)
}

#[tauri::command]
fn start_dream_maintenance(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: Option<String>,
    interval_ms: Option<i64>,
    failure_limit: Option<i64>,
) -> Result<DreamMaintenanceStatus, String> {
    let root = ensure_default_workspace(&app, state.inner())?;
    let project_id = project_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| workspace_root_label(&root));
    let interval_ms = match interval_ms {
        None => 15 * 60 * 1000,
        Some(value) if (30 * 1000..=24 * 60 * 60 * 1000).contains(&value) => value as u64,
        _ => return Err("intervalMs 必须在 30000 到 86400000 之间".to_string()),
    };
    let failure_limit = match failure_limit {
        None => 3,
        Some(value) if (1..=20).contains(&value) => value as u32,
        _ => return Err("failureLimit 必须在 1 到 20 之间".to_string()),
    };
    let runtime = runtime_entrypoint(&app)?;
    let runtime_slots = state.runtime_slots.clone();
    let active_runs: Arc<dyn Fn() -> u32 + Send + Sync> = Arc::new(move || {
        runtime_slots
            .lock()
            .map(|slots| slots.len() as u32)
            .unwrap_or(1)
    });
    let active_runs_file = std::env::temp_dir().join("hmcodex-dream-active-runs.txt");
    start_dream_maintenance_impl(
        &app,
        &state.dream_maintenance,
        &runtime,
        project_id,
        interval_ms,
        failure_limit,
        active_runs_file,
        active_runs,
    )
}

#[tauri::command]
fn stop_dream_maintenance(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DreamMaintenanceStatus, String> {
    stop_dream_maintenance_impl(&app, &state.dream_maintenance)
}

#[tauri::command]
async fn list_plugin_governance(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_runtime_json(&app, &["plugin", "--operation", "list"]))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn plugin_action(
    app: AppHandle,
    plugin_id: String,
    operation: String,
    state: Option<String>,
) -> Result<Value, String> {
    let plugin_id = required_runtime_argument(Some(plugin_id), "pluginId")?;
    let operation = required_runtime_argument(Some(operation), "operation")?.to_ascii_lowercase();
    if !["validate", "transition"].contains(&operation.as_str()) {
        return Err("plugin operation 无效".to_string());
    }
    let mut args = vec![
        "plugin".to_string(),
        "--operation".to_string(),
        operation.clone(),
        "--plugin-id".to_string(),
        plugin_id,
    ];
    if operation == "transition" {
        let state = required_runtime_argument(state, "state")?;
        args.extend(["--state".to_string(), state]);
    }
    tauri::async_runtime::spawn_blocking(move || run_runtime_json_owned(&app, &args))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_evolution(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_runtime_json(&app, &["evolution", "--operation", "list"]))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn evolution_action(
    app: AppHandle,
    proposal_id: String,
    operation: String,
    state: Option<String>,
    reason: Option<String>,
    min_samples: Option<i64>,
) -> Result<Value, String> {
    let proposal_id = required_runtime_argument(Some(proposal_id), "proposalId")?;
    let operation = required_runtime_argument(Some(operation), "operation")?.to_ascii_lowercase();
    if !["transition", "rollback", "monitor"].contains(&operation.as_str()) {
        return Err("evolution operation 无效".to_string());
    }
    let mut args = vec![
        "evolution".to_string(),
        "--operation".to_string(),
        operation.clone(),
        "--proposal-id".to_string(),
        proposal_id,
    ];
    if operation == "transition" {
        let state = required_runtime_argument(state, "state")?;
        args.extend(["--state".to_string(), state]);
    } else if operation == "rollback" {
        optional_runtime_argument(&mut args, "--reason", reason, "reason")?;
    } else if let Some(min_samples) = min_samples {
        if !(1..=1024).contains(&min_samples) {
            return Err("minSamples 必须在 1 到 1024 之间".to_string());
        }
        args.extend(["--min-samples".to_string(), min_samples.to_string()]);
    }
    tauri::async_runtime::spawn_blocking(move || run_runtime_json_owned(&app, &args))
        .await
        .map_err(|error| error.to_string())?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeImageInput {
    name: Option<String>,
    media_type: String,
    data_url: String,
}

struct TempFileGuard(Option<PathBuf>);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn validate_task_images(images: &[RuntimeImageInput]) -> Result<(), String> {
    const MAX_IMAGES: usize = 4;
    // 10 MiB raw ~= 13.99 MiB base64; cap individual data URL and 20 MiB total raw (~28 MiB base64).
    const MAX_SINGLE_DATA_URL_LEN: usize = 14 * 1024 * 1024 + 4096;
    const MAX_TOTAL_DATA_URL_LEN: usize = 28 * 1024 * 1024 + 8192;
    if images.len() > MAX_IMAGES {
        return Err(format!("TASK_IMAGE_COUNT_EXCEEDED: 单次最多添加 {MAX_IMAGES} 张图片"));
    }
    let mut total_len = 0usize;
    for item in images {
        let media = item.media_type.trim().to_ascii_lowercase();
        let canonical = match media.as_str() {
            "image/png" => "image/png",
            "image/jpeg" | "image/jpg" => "image/jpeg",
            "image/webp" => "image/webp",
            "image/gif" => "image/gif",
            _ => return Err("TASK_IMAGE_FORMAT_UNSUPPORTED: 仅支持 PNG、JPG、WebP、GIF 图片格式".to_string()),
        };
        let url = item.data_url.trim();
        let expected_prefix = format!("data:{canonical};base64,");
        let alt_jpg_prefix = "data:image/jpg;base64,";
        let payload = if url.len() >= expected_prefix.len()
            && url[..expected_prefix.len()].eq_ignore_ascii_case(&expected_prefix)
        {
            &url[expected_prefix.len()..]
        } else if canonical == "image/jpeg"
            && url.len() >= alt_jpg_prefix.len()
            && url[..alt_jpg_prefix.len()].eq_ignore_ascii_case(alt_jpg_prefix)
        {
            &url[alt_jpg_prefix.len()..]
        } else {
            return Err("TASK_IMAGE_DATA_INVALID: 图片数据格式无效".to_string());
        };
        if payload.trim().is_empty() {
            return Err("TASK_IMAGE_DATA_INVALID: 图片数据为空".to_string());
        }
        if url.len() > MAX_SINGLE_DATA_URL_LEN {
            return Err("TASK_IMAGE_TOO_LARGE: 单张图片不能超过 10 MB".to_string());
        }
        total_len = total_len.saturating_add(url.len());
        if total_len > MAX_TOTAL_DATA_URL_LEN {
            return Err("TASK_IMAGE_TOTAL_TOO_LARGE: 单次图片总大小不能超过 20 MB".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
async fn run_model_task(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    model: Option<String>,
    thread_id: Option<String>,
    resume: Option<bool>,
    max_tool_rounds: Option<u32>,
    max_tokens: Option<u32>,
    max_cost: Option<f64>,
    execution_mode: Option<String>,
    lease_capabilities: Option<Vec<String>>,
    lease_commands: Option<Vec<String>>,
    lease_network_targets: Option<serde_json::Value>,
    client_session_id: Option<String>,
    workspace_path: Option<String>,
    images: Option<Vec<RuntimeImageInput>>,
) -> Result<RuntimeTaskResponse, String> {
    let image_list = images.unwrap_or_default();
    if !image_list.is_empty() {
        validate_task_images(&image_list)?;
    }
    let prompt_length = prompt.trim().encode_utf16().count();
    if prompt_length == 0 && image_list.is_empty() {
        return Err("TASK_EMPTY: 请填写任务需求或粘贴图片".to_string());
    }
    if prompt_length > 8000 {
        return Err(format!("TASK_PROMPT_TOO_LONG:{prompt_length}:8000：需求超过 8000 字符，请拆分后提交；原文未被截断"));
    }
    let effective_prompt = if prompt_length == 0 {
        "请结合所附图片分析并处理。".to_string()
    } else {
        prompt
    };
    let state = state.inner().clone();
    let session_id = reserve_runtime_launch(&state, client_session_id.as_deref())?;
    let cleanup_state = state.clone();
    let cleanup_session = session_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_model_task_blocking(
            app,
            state,
            session_id,
            workspace_path,
            effective_prompt,
            image_list,
            model,
            thread_id,
            resume,
            max_tool_rounds,
            max_tokens,
            max_cost,
            execution_mode,
            lease_capabilities,
            lease_commands,
            lease_network_targets,
        )
    })
    .await;
    match result {
        Ok(result) => {
            if result.is_err() {
                clear_runtime_launch_reservation(&cleanup_state, &cleanup_session);
            }
            result
        }
        Err(error) => {
            clear_runtime_launch_reservation(&cleanup_state, &cleanup_session);
            Err(format!("Cordis runtime 后台任务异常: {error}"))
        }
    }
}

fn desktop_release_channel() -> Result<String, String> {
    if let Some(channel) = option_env!("DDA_BAKED_RELEASE_CHANNEL") {
        validate_release_mode(channel, None)?;
        return Ok(channel.to_string());
    }
    let channel = match std::env::var("DDA_RELEASE_CHANNEL") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => "WINDOWS_PHASE1_5_CONTROLLED".to_string(),
        Err(_) => return Err("RELEASE_CHANNEL_INVALID".to_string()),
    };
    validate_release_mode(&channel, None)?;
    Ok(channel)
}

fn validate_release_mode(channel: &str, mode: Option<&str>) -> Result<(), String> {
    match channel {
        "WINDOWS_PHASE1_5_CONTROLLED" | "WINDOWS_FULL_LOCAL" => {}
        "WINDOWS_MVP_PRE_PHASE1" | "WINDOWS_PHASE1_READ_ONLY" | "LINUX_CLI_READ_ONLY" => {
            return Err("RELEASE_CHANNEL_RETIRED".to_string());
        }
        _ => return Err("RELEASE_CHANNEL_INVALID".to_string()),
    }
    let mode = mode.unwrap_or("CONTROLLED");
    if mode != "CONTROLLED" {
        return Err("EXECUTION_MODE_INVALID".to_string());
    }
    Ok(())
}

fn slot_cancel_requested(state: &AppState, session_id: &str) -> Result<bool, String> {
    let slots = state
        .runtime_slots
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    Ok(slots.get(session_id).map_or(true, |slot| slot.cancel_requested))
}

fn prepare_project_workspace(app: &AppHandle, state: &AppState, session_id: &str, root: &Path) -> Result<PathBuf, String> {
    let requested = if root.as_os_str().is_empty() {
        ensure_default_workspace(app, state)?
    } else {
        normalize_existing_dir(root.to_path_buf()).map_err(|error| error.to_string())?
    };
    if !requested.is_dir() { return Err("工作区路径不是目录".to_string()); }
    let root = claim_task_workspace(state, session_id, &requested)?;
    if let Some(branch) = task_worktree_branch(state, session_id) {
        append_desktop_log(&format!(
            "task worktree session={session_id} path={} branch={branch}",
            root.display()
        ));
        let _ = app.emit("task-worktree", serde_json::json!({
            "clientSessionId": session_id,
            "path": root.display().to_string(),
            "branch": branch,
        }));
    }
    Ok(root)
}

fn run_model_task_blocking(
    app: AppHandle,
    state: AppState,
    session_id: String,
    workspace_path: Option<String>,
    prompt: String,
    images: Vec<RuntimeImageInput>,
    model: Option<String>,
    thread_id: Option<String>,
    resume: Option<bool>,
    max_tool_rounds: Option<u32>,
    max_tokens: Option<u32>,
    max_cost: Option<f64>,
    execution_mode: Option<String>,
    lease_capabilities: Option<Vec<String>>,
    lease_commands: Option<Vec<String>>,
    lease_network_targets: Option<serde_json::Value>,
) -> Result<RuntimeTaskResponse, String> {
    append_desktop_log(&format!("runtime task launch begin session={session_id}"));
    if slot_cancel_requested(&state, &session_id)? {
        return Err("Cordis runtime 已在启动前取消".to_string());
    }
    let channel = desktop_release_channel()?;
    validate_release_mode(&channel, execution_mode.as_deref())?;
    // Capture the selected directory as an identity only. A chat can start
    // without a project, including when the last checkout has disappeared.
    let root = workspace_path.as_deref().map(str::trim).filter(|value| !value.is_empty())
        .map(PathBuf::from).or_else(|| state.workspace_root.lock().ok()?.clone()).unwrap_or_default();
    let runtime = runtime_entrypoint(&app)?;
    let _ = app.emit("context-sidecar-status", &local_context_status());
    let resource_dir = app.path().resource_dir().ok();
    let mut command = runtime_command_for(
        &runtime,
        resource_dir.as_deref(),
        TASK_RUNTIME_SPAWN_MODE,
    );
    let session_store_file = local_app_data_dir().map(|app_data| {
        let safe_id: String = session_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
            .take(80)
            .collect();
        windows_desktop_journal_path(&app_data, &format!("kernel-session-{safe_id}.json"))
    });
    if let Some(ref session_file) = session_store_file {
        command.env("DDA_KERNEL_SESSION_STORE", session_file.display().to_string());
    }
    command
        .arg(runtime)
        .arg("task")
        .arg("--prompt")
        .arg(prompt)
        .arg("--workspace")
        .arg(&root)
        .arg("--defer-workspace");
    let mut _images_file_guard = TempFileGuard(None);
    if !images.is_empty() {
        let safe_id: String = session_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
            .take(80)
            .collect();
        let file_name = format!("task-images-{safe_id}-{}.json", unix_time_ms());
        let images_path = local_app_data_dir()
            .map(|app_data| windows_desktop_journal_path(&app_data, &file_name))
            .unwrap_or_else(|| std::env::temp_dir().join(&file_name));
        if let Some(parent) = images_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建图片临时目录: {error}"))?;
        }
        let serialized = serde_json::to_string(&serde_json::json!({ "images": images }))
            .map_err(|error| format!("序列化图片数据失败: {error}"))?;
        fs::write(&images_path, serialized)
            .map_err(|error| format!("写入图片临时文件失败: {error}"))?;
        command.arg("--images-file").arg(&images_path);
        _images_file_guard = TempFileGuard(Some(images_path));
    }
    let execution_mode = execution_mode.unwrap_or_else(|| "CONTROLLED".to_string());
    if execution_mode != "CONTROLLED" {
        return Err("EXECUTION_MODE_INVALID".to_string());
    }
    command.arg("--execution-mode").arg(&execution_mode);
    command.arg("--agent-mode").arg("multi");
    command.arg("--events").arg("stdout");
    command.arg("--session-id").arg(&session_id);
    if let Some(capabilities) = lease_capabilities {
        let value = join_runtime_values(&capabilities)?;
        if !value.is_empty() {
            command.arg("--lease-capabilities").arg(value);
        }
    }
    if let Some(commands) = lease_commands {
        let value = join_runtime_values(&commands)?;
        if !value.is_empty() {
            command.arg("--lease-commands").arg(value);
        }
    }
    if let Some(targets) = lease_network_targets {
        let value = serde_json::to_string(&targets)
            .map_err(|error| format!("NETWORK_TARGETS_INVALID: {error}"))?;
        if !value.is_empty() && value != "null" {
            command.arg("--network-targets").arg(value);
        }
    }
    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        command.arg("--model").arg(&model);
        command.arg("--executor-model").arg(&model);
    }
    let has_thread_id = thread_id
        .as_ref()
        .is_some_and(|value| !value.trim().is_empty());
    if let Some(thread_id) = thread_id.filter(|value| !value.trim().is_empty()) {
        command.arg("--thread-id").arg(thread_id);
    }
    if resume == Some(true) {
        if !has_thread_id {
            return Err("恢复任务必须指定 Thread".to_string());
        }
        command.arg("--resume");
    }
    if let Some(value) = max_tool_rounds {
        if !(1..=64).contains(&value) { return Err("工具轮数上限必须在 1 到 64 之间".to_string()); }
        command.arg("--max-tool-rounds").arg(value.to_string());
    }
    if let Some(value) = max_tokens {
        if !(256..=1_000_000).contains(&value) { return Err("Token 上限必须在 256 到 1000000 之间".to_string()); }
        command.arg("--max-tokens").arg(value.to_string());
    }
    if let Some(value) = max_cost {
        if !value.is_finite() || value < 0.0 { return Err("费用上限必须是非负数字".to_string()); }
        command.arg("--max-cost").arg(value.to_string());
    }
    let (mut child, spawn_instant) = {
        let _state_guard = state
            .runtime_state_lock
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        let mut slots = state
            .runtime_slots
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        if !slots.contains_key(&session_id) {
            return Err("Cordis runtime 已在启动前取消".to_string());
        }
        if slots.get(&session_id).is_some_and(|slot| slot.pid.is_some()) {
            return Err("该会话已有任务正在运行".to_string());
        }
        if slots.get(&session_id).is_some_and(|slot| slot.cancel_requested) {
            let removed = slots.remove(&session_id);
            drop(slots);
            drop(_state_guard);
            if let Some(removed) = removed {
                if let Some(handle) = removed.job_handle {
                    close_job_handle(handle);
                }
                release_task_worktree(removed.worktree);
            }
            return Err("Cordis runtime 已在启动前取消".to_string());
        }
        let Some(slot) = slots.get_mut(&session_id) else {
            return Err("Cordis runtime 已在启动前取消".to_string());
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                append_desktop_log(&format!("runtime spawn 失败: {error}"));
                format!("无法启动 Cordis runtime: {error}")
            })?;
        let pid = child.id();
        let job_handle = bind_session_keep_reaper(pid);
        let child_stdin = child.stdin.take();
        let started = unix_time_ms();
        let started_at = Instant::now();
        slot.pid = Some(pid);
        slot.stdin = child_stdin;
        slot.started_at_ms = Some(started);
        slot.last_heartbeat_at_ms = Some(started);
        slot.started_at = Some(started_at);
        slot.last_heartbeat_at = Some(started_at);
        slot.heartbeat_seen = false;
        slot.launching = false;
        slot.job_handle = job_handle;
        (child, started_at)
    };
    let pid = child.id();
    append_desktop_log(&format!("runtime task spawned session={session_id} pid={pid}"));
    let stderr = child.stderr.take();
    let stderr_state = state.clone();
    let stderr_session = session_id.clone();
    let stderr_pid = pid;
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        let Some(stderr) = stderr else {
            return text;
        };
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if process_heartbeat_line(&line) {
                        note_process_heartbeat(&stderr_state, &stderr_session, stderr_pid);
                    } else {
                        text.push_str(&line);
                    }
                }
                Err(error) => {
                    text.push_str(&format!("读取 Cordis runtime 错误输出失败: {error}\n"));
                    break;
                }
            }
        }
        text
    });
    let stdout = child.stdout.take();
    let (stdout_sender, stdout_receiver) = mpsc::channel::<Result<Option<String>, String>>();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if stdout_sender.send(Ok(Some(line.clone()))).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = stdout_sender
                            .send(Err(format!("读取 Cordis runtime 输出失败: {error}")));
                        return;
                    }
                }
            }
        }
        let _ = stdout_sender.send(Ok(None));
    });
    let mut stdout_text = String::new();
    let mut stdout_error = None;
    let mut claimed_workspace: Option<PathBuf> = None;
    let mut terminal_seen_at: Option<Instant> = None;
    let mut last_watchdog_tick = spawn_instant;
    loop {
        let recv_result =
            stdout_receiver.recv_timeout(Duration::from_millis(RUNTIME_WATCHDOG_POLL_MS));
        let now = Instant::now();
        let poll_gap_ms = duration_ms(now.saturating_duration_since(last_watchdog_tick));
        last_watchdog_tick = now;
        if runtime_watchdog_poll_was_suspended(poll_gap_ms) {
            let suspended =
                Duration::from_millis(poll_gap_ms.saturating_sub(RUNTIME_WATCHDOG_POLL_MS));
            if extend_runtime_slot_after_suspend(
                &state,
                &session_id,
                pid,
                now,
                unix_time_ms(),
                suspended,
                &mut terminal_seen_at,
            ) {
                append_desktop_log(&format!(
                    "runtime 监督器检测到系统挂起或调度跳变 gap_ms={poll_gap_ms}，顺延心跳窗口 pid={pid}"
                ));
            }
        }
        match recv_result {
            Ok(Ok(Some(line))) => {
                if line.contains("workspace.claim_requested") {
                    if let Ok(event) = serde_json::from_str::<Value>(&line) {
                        if event["type"] == "runtime_event" && event["kind"] == "workspace.claim_requested" {
                            // Resolve only the parent-owned launch directory, once per task slot.
                            let result = match &claimed_workspace {
                                Some(path) => Ok(path.clone()),
                                None => prepare_project_workspace(&app, &state, &session_id, &root),
                            };
                            if let Ok(path) = &result { claimed_workspace = Some(path.clone()); }
                            let reply = serde_json::json!({
                                "type": "workspace.claim_result", "requestId": event["payload"]["requestId"],
                                "path": result.as_ref().ok(), "error": result.as_ref().err()
                            });
                            if let Ok(mut slots) = state.runtime_slots.lock() {
                                if let Some(input) = slots.get_mut(&session_id)
                                    .filter(|slot| slot.pid == Some(pid)).and_then(|slot| slot.stdin.as_mut()) {
                                    let _ = writeln!(input, "{reply}").and_then(|_| input.flush());
                                }
                            }
                        }
                    }
                }
                handle_runtime_stdout_line(&app, &state, &session_id, pid, &line, &mut stdout_text);
                if runtime_last_phase(&stdout_text).is_some_and(|phase| {
                    matches!(phase.as_str(), "run.state_changed:SUCCEEDED" | "run.state_changed:FAILED" | "run.state_changed:CANCELLED")
                }) {
                    terminal_seen_at.get_or_insert_with(Instant::now);
                }
            }
            Ok(Ok(None)) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                append_desktop_log("runtime stdout closed");
                break;
            }
            Ok(Err(error)) => {
                append_desktop_log(&format!("runtime 输出读取失败: {error}"));
                stdout_error = Some(error);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let (
                    slot_active,
                    heartbeat_seen,
                    started_at,
                    last_heartbeat_at,
                    process_heartbeat_seen,
                    last_process_heartbeat_at,
                    watchdog_job,
                ) = {
                    let Ok(slots) = state.runtime_slots.lock() else {
                        continue;
                    };
                    if let Some(slot) = slots.get(&session_id).filter(|s| s.pid == Some(pid)) {
                        (
                            true,
                            slot.heartbeat_seen,
                            slot.started_at,
                            slot.last_heartbeat_at,
                            slot.process_heartbeat_seen,
                            slot.last_process_heartbeat_at,
                            slot.job_handle,
                        )
                    } else {
                        (false, false, None, None, false, None, None)
                    }
                };
                if !slot_active {
                    continue;
                }
                let stale = runtime_liveness_is_stale(
                    heartbeat_seen,
                    started_at,
                    last_heartbeat_at,
                    process_heartbeat_seen,
                    last_process_heartbeat_at,
                    now,
                );
                let terminal_for_ms = terminal_seen_at
                    .map(|seen| duration_ms(now.saturating_duration_since(seen)));
                if runtime_watchdog_should_stop(stale, terminal_for_ms) {
                    let exited = child.try_wait().map_or(false, |status| status.is_some());
                    let terminal_error = if exited {
                        terminal_stdout_error(&stdout_text)
                    } else {
                        None
                    };
                    let message = match terminal_error {
                        Some(error) => {
                            append_desktop_log(&format!(
                                "runtime 已退出但输出管道未关闭，提取真实错误: {error}"
                            ));
                            error
                        }
                        None => {
                            let phase = runtime_last_phase(&stdout_text).unwrap_or_else(|| "未收到首个心跳".to_string());
                            if terminal_for_ms.is_some() {
                                append_desktop_log(&format!(
                                    "runtime 任务结束后心跳停止，监督器终止进程 pid={pid} phase={phase}"
                                ));
                                format!("Cordis runtime 在任务结束后没有退出，已由监督器终止（阶段: {phase}）")
                            } else {
                                let signal = if process_heartbeat_seen {
                                    "process-heartbeat"
                                } else {
                                    "stdout-only"
                                };
                                append_desktop_log(&format!(
                                    "runtime 心跳超时，监督器终止进程 pid={pid} phase={phase} signal={signal}"
                                ));
                                format!("Cordis runtime 心跳超时，已由监督器终止（阶段: {phase}）")
                            }
                        }
                    };
                    stdout_error = Some(message);
                    if let Ok(_state_guard) = state.runtime_state_lock.lock() {
                        if let Ok(mut slots) = state.runtime_slots.lock() {
                            if let Some(slot) = slots.get_mut(&session_id) {
                                slot.job_handle = None;
                            }
                        }
                    }
                    let _ = reap_runtime_slot(pid, watchdog_job);
                    let _ = child.kill();
                    break;
                }
            }
        }
    }
    let status = child.wait().map_err(|error| {
        append_desktop_log(&format!("runtime 进程异常退出: {error}"));
        format!("Cordis runtime 进程异常退出: {error}")
    });
    match &status {
        Ok(value) => append_desktop_log(&format!("runtime child wait status={value:?}")),
        Err(error) => append_desktop_log(&format!("runtime child wait error={error}")),
    }
    let _ = stdout_thread.join();
    let stderr_text = stderr_thread.join().unwrap_or_default();
    if !stderr_text.trim().is_empty() {
        append_desktop_log(&format!("runtime stderr:\n{}", stderr_text.trim_end()));
    }
    let mut exit_job = None;
    let mut finished_worktree = None;
    if let Ok(_state_guard) = state.runtime_state_lock.lock() {
        if let Ok(mut slots) = state.runtime_slots.lock() {
            if slots.get(&session_id).is_some_and(|slot| slot.pid == Some(pid)) {
                if let Some(slot) = slots.remove(&session_id) {
                    exit_job = slot.job_handle;
                    finished_worktree = slot.worktree;
                }
            }
        }
    }
    if let Some(handle) = exit_job {
        close_job_handle(handle);
    }
    release_task_worktree(finished_worktree);
    if let Some(session_file) = session_store_file {
        let _ = fs::remove_file(&session_file);
        let _ = fs::remove_file(format!("{}.lock", session_file.display()));
    }
    if let Some(error) = stdout_error {
        append_desktop_log(&format!("runtime task stdout_error={error}"));
        return Err(error);
    }
    status?;
    let stdout = stdout_text;
    append_desktop_log(&format!(
        "runtime task stdout bytes={} lines={}",
        stdout.len(),
        stdout.lines().count()
    ));
    let line = stdout
        .lines()
        .rev()
        .find(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "Cordis runtime 没有返回结果{}",
                bounded_process_error(&stderr_text)
            )
        })?;
    let response = serde_json::from_str::<RuntimeTaskResponse>(line)
        .map_err(|error| format!("Cordis runtime 返回了无效结果: {error}"))?;
    append_desktop_log("runtime task parsed response");
    Ok(response)
}

/// Pure slot selection for approval routing. An explicit sessionId/runId is a
/// hard requirement — it must resolve to a live slot that recorded this exact
/// requestId, and any mismatch fails instead of falling back to a sibling's
/// approval. Targetless (legacy) routing only ever succeeds when the
/// requestId is recorded on exactly one live slot.
fn select_approval_slot<'a>(
    slots: &'a HashMap<String, RuntimeTaskSlot>,
    request_id: &str,
    session_id: Option<&str>,
    run_id: Option<&str>,
    is_live: impl Fn(&RuntimeTaskSlot) -> bool,
) -> Result<String, String> {
    let explicit_session = session_id.map(str::trim).filter(|value| !value.is_empty());
    let explicit_run = run_id.map(str::trim).filter(|value| !value.is_empty());
    let has_identity = |slot: &RuntimeTaskSlot| {
        explicit_session.map(|sid| sid == slot.session_id).unwrap_or(true)
            && explicit_run
                .map(|rid| slot.run_id.as_deref() == Some(rid))
                .unwrap_or(true)
    };
    if explicit_session.is_some() || explicit_run.is_some() {
        let slot = slots
            .values()
            .find(|slot| is_live(slot) && has_identity(slot))
            .ok_or_else(|| "审批目标会话不存在或已结束".to_string())?;
        if !slot.approval_request_ids.contains(request_id) {
            return Err("审批请求不属于目标任务".to_string());
        }
        return Ok(slot.session_id.clone());
    }
    let owners: Vec<&RuntimeTaskSlot> = slots
        .values()
        .filter(|slot| is_live(slot) && slot.approval_request_ids.contains(request_id))
        .collect();
    match owners.as_slice() {
        [slot] => Ok(slot.session_id.clone()),
        [] => Err("当前没有等待审批的运行时任务".to_string()),
        _ => Err("审批目标不唯一，请指定任务会话".to_string()),
    }
}

/// A clarification answer belongs to the slot that emitted that request.
/// It never falls through to a sibling task.
fn select_clarification_slot<'a>(
    slots: &'a HashMap<String, RuntimeTaskSlot>,
    request_id: &str,
    session_id: Option<&str>,
    run_id: Option<&str>,
    is_live: impl Fn(&RuntimeTaskSlot) -> bool,
) -> Result<String, String> {
    let explicit_session = session_id.map(str::trim).filter(|value| !value.is_empty());
    let explicit_run = run_id.map(str::trim).filter(|value| !value.is_empty());
    let has_identity = |slot: &RuntimeTaskSlot| {
        explicit_session.map(|sid| sid == slot.session_id).unwrap_or(true)
            && explicit_run
                .map(|rid| slot.run_id.as_deref() == Some(rid))
                .unwrap_or(true)
    };
    if explicit_session.is_some() || explicit_run.is_some() {
        let slot = slots
            .values()
            .find(|slot| is_live(slot) && has_identity(slot))
            .ok_or_else(|| "补充说明目标会话不存在或已结束".to_string())?;
        if !slot.clarification_request_ids.contains(request_id) {
            return Err("补充说明请求不属于目标任务".to_string());
        }
        return Ok(slot.session_id.clone());
    }
    let owners: Vec<&RuntimeTaskSlot> = slots
        .values()
        .filter(|slot| is_live(slot) && slot.clarification_request_ids.contains(request_id))
        .collect();
    match owners.as_slice() {
        [slot] => Ok(slot.session_id.clone()),
        [] => Err("当前没有等待补充说明的运行时任务".to_string()),
        _ => Err("补充说明目标不唯一，请指定任务会话".to_string()),
    }
}

/// Pure slot selection for cancellation. Explicit ids must resolve to a real
/// slot or the cancel is a no-op (`None`) — never a sibling fallback. Only a
/// targetless call keeps the legacy "most recent slot" behavior.
fn select_cancel_slot(
    slots: &HashMap<String, RuntimeTaskSlot>,
    session_id: Option<&str>,
    run_id: Option<&str>,
) -> Option<String> {
    let explicit_session = session_id.map(str::trim).filter(|value| !value.is_empty());
    let explicit_run = run_id.map(str::trim).filter(|value| !value.is_empty());
    if explicit_session.is_some() || explicit_run.is_some() {
        return slots
            .values()
            .find(|slot| {
                explicit_session.map(|sid| sid == slot.session_id).unwrap_or(true)
                    && explicit_run
                        .map(|rid| slot.run_id.as_deref() == Some(rid))
                        .unwrap_or(true)
            })
            .map(|slot| slot.session_id.clone());
    }
    slots
        .values()
        .max_by_key(|slot| slot.order)
        .map(|slot| slot.session_id.clone())
}

#[tauri::command]
fn resolve_runtime_approval(
    state: State<'_, AppState>,
    request_id: String,
    approved: bool,
    always_allow: Option<bool>,
    displayed_digest: String,
    session_id: Option<String>,
    run_id: Option<String>,
) -> Result<(), String> {
    if request_id.trim().is_empty() || displayed_digest.trim().is_empty() {
        return Err("审批回执缺少 requestId 或展示摘要".to_string());
    }
    let _state_guard = state
        .runtime_state_lock
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let mut slots = state
        .runtime_slots
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let target_key = select_approval_slot(
        &slots,
        &request_id,
        session_id.as_deref(),
        run_id.as_deref(),
        |slot| slot.stdin.is_some(),
    )?;
    let Some(stdin) = slots
        .get_mut(&target_key)
        .and_then(|slot| slot.stdin.as_mut())
    else {
        return Err("当前没有等待审批的运行时任务".to_string());
    };
    let payload = serde_json::json!({
        "type": "approval_response",
        "requestId": request_id,
        "approved": approved,
        "alwaysAllow": always_allow.unwrap_or(false),
        "displayedDigest": displayed_digest
    });
    use std::io::Write;
    writeln!(stdin, "{}", payload).map_err(|error| format!("审批回执发送失败: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("审批回执刷新失败: {error}"))
}

fn valid_clarification_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

fn valid_clarification_answer(value: &str) -> bool {
    let count = value.chars().count();
    (1..=4000).contains(&count)
        && !value
            .chars()
            .any(|character| character == '\u{0}' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t')))
}

#[tauri::command]
fn resolve_runtime_clarification(
    state: State<'_, AppState>,
    request_id: String,
    answer: String,
    selected_option_id: Option<String>,
    session_id: Option<String>,
    run_id: Option<String>,
) -> Result<(), String> {
    let answer = answer.trim();
    if !valid_clarification_request_id(request_id.trim()) || !valid_clarification_answer(&answer) {
        return Err("补充说明回执无效".to_string());
    }
    if let Some(option_id) = selected_option_id.as_deref() {
        if !matches!(option_id, "option-1" | "option-2" | "option-3" | "option-4") {
            return Err("补充说明选项无效".to_string());
        }
    }
    let _state_guard = state
        .runtime_state_lock
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let mut slots = state
        .runtime_slots
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let target_key = select_clarification_slot(
        &slots,
        request_id.trim(),
        session_id.as_deref(),
        run_id.as_deref(),
        |slot| slot.stdin.is_some(),
    )?;
    let Some(stdin) = slots
        .get_mut(&target_key)
        .and_then(|slot| slot.stdin.as_mut())
    else {
        return Err("当前没有等待补充说明的运行时任务".to_string());
    };
    let mut payload = serde_json::json!({
        "type": "clarification_response",
        "requestId": request_id.trim(),
        "answer": answer,
    });
    if let Some(option_id) = selected_option_id.as_deref() {
        payload["selectedOptionId"] = serde_json::Value::String(option_id.to_string());
    }
    use std::io::Write;
    writeln!(stdin, "{payload}").map_err(|error| format!("补充说明回执发送失败: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("补充说明回执刷新失败: {error}"))
}

fn join_runtime_values(values: &[String]) -> Result<String, String> {
    if values.len() > 32 {
        return Err("执行审批项过多".to_string());
    }
    if values.iter().any(|value| {
        value.is_empty()
            || value.len() > 256
            || value.contains(',')
            || value.chars().any(|character| character.is_control())
    }) {
        return Err("执行审批项无效".to_string());
    }
    Ok(values.join(","))
}

#[tauri::command]
fn cancel_model_task(
    state: State<'_, AppState>,
    session_id: Option<String>,
    run_id: Option<String>,
) -> Result<RuntimeCancellation, String> {
    cancel_runtime_slot(state.inner(), session_id.as_deref(), run_id.as_deref())
}

/// Kill the targeted runtime process tree and clear its host bookkeeping while
/// leaving any other parallel task processes running undisturbed.
fn cancel_runtime_slot(
    state: &AppState,
    session_id: Option<&str>,
    run_id: Option<&str>,
) -> Result<RuntimeCancellation, String> {
    append_desktop_log("cancel_runtime_process invoked");
    let target = {
        let _state_guard = state
            .runtime_state_lock
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        let mut slots = state
            .runtime_slots
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        let key = select_cancel_slot(&slots, session_id, run_id);
        let Some(key) = key else {
            return Ok(RuntimeCancellation { cancelled: false });
        };
        if slots
            .get(&key)
            .is_some_and(|slot| slot.pid.is_none() && slot.launching)
        {
            if let Some(slot) = slots.get_mut(&key) {
                slot.cancel_requested = true;
            }
            append_desktop_log(&format!(
                "cancel_runtime_process: reserved launch before spawn session={key}"
            ));
            return Ok(RuntimeCancellation { cancelled: true });
        }
        slots.remove(&key)
    };
    let Some(mut removed) = target else {
        return Ok(RuntimeCancellation { cancelled: false });
    };
    drop(removed.stdin.take());
    let Some(pid) = removed.pid else {
        if let Some(handle) = removed.job_handle {
            close_job_handle(handle);
        }
        return Ok(RuntimeCancellation { cancelled: false });
    };
    let job_handle = removed.job_handle.take();
    append_desktop_log(&format!(
        "cancel_runtime_process: killing session={} pid={pid}",
        removed.session_id
    ));

    match reap_runtime_slot(pid, job_handle) {
        Ok(true) => {
            release_task_worktree(removed.worktree.take());
            Ok(RuntimeCancellation { cancelled: true })
        }
        Ok(false) => {
            if let Ok(_state_guard) = state.runtime_state_lock.lock() {
                if let Ok(mut slots) = state.runtime_slots.lock() {
                    slots.entry(removed.session_id.clone()).or_insert(removed);
                }
            }
            Err("Cordis runtime 取消失败".to_string())
        }
        Err(error) => {
            if let Ok(_state_guard) = state.runtime_state_lock.lock() {
                if let Ok(mut slots) = state.runtime_slots.lock() {
                    slots.entry(removed.session_id.clone()).or_insert(removed);
                }
            }
            Err(format!("无法取消 Cordis runtime: {error}"))
        }
    }
}

fn cancel_all_runtime_processes(state: &AppState) -> Result<RuntimeCancellation, String> {
    let removed_list = {
        let _state_guard = state
            .runtime_state_lock
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        let mut slots = state
            .runtime_slots
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        let mut to_reap = Vec::new();
        let keys: Vec<String> = slots.keys().cloned().collect();
        for key in keys {
            if slots
                .get(&key)
                .is_some_and(|slot| slot.pid.is_none() && slot.launching)
            {
                if let Some(slot) = slots.get_mut(&key) {
                    slot.cancel_requested = true;
                }
            } else if let Some(slot) = slots.remove(&key) {
                to_reap.push(slot);
            }
        }
        to_reap
    };
    let mut cancelled_any = false;
    for mut slot in removed_list {
        drop(slot.stdin.take());
        if let Some(pid) = slot.pid {
            if reap_runtime_slot(pid, slot.job_handle.take()).unwrap_or(false) {
                cancelled_any = true;
                release_task_worktree(slot.worktree.take());
            }
        } else if let Some(handle) = slot.job_handle.take() {
            close_job_handle(handle);
            release_task_worktree(slot.worktree.take());
        }
    }
    Ok(RuntimeCancellation {
        cancelled: cancelled_any,
    })
}

fn runtime_entrypoint(app: &AppHandle) -> Result<PathBuf, String> {
    let resolve_entry = |candidate: PathBuf| {
        let resolved = normalize_existing_file(candidate);
        append_desktop_log(&(String::from("runtime entrypoint=") + &resolved.display().to_string()));
        resolved
    };
    if let Ok(path) = std::env::var("DDA_RUNTIME_ENTRY") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(resolve_entry(candidate));
        }
        return Err("DDA_RUNTIME_ENTRY 不是有效文件".to_string());
    }
    let current = std::env::current_dir().map_err(|error| format!("无法读取当前目录: {error}"))?;
    // Directly launched debug binaries must use their enclosing checkout,
    // rather than a stale resource copy from the last desktop build.
    if cfg!(debug_assertions) {
        if let Ok(executable) = std::env::current_exe() {
            for ancestor in executable.ancestors().skip(1) {
                let candidate = ancestor.join("runtime/src/index.mjs");
                if ancestor.join("desktop/src-tauri/Cargo.toml").is_file() && candidate.is_file() {
                    return Ok(resolve_entry(candidate));
                }
            }
        }
    }
    let mut candidates = Vec::with_capacity(8);
    // In development, prefer the caller's mapped-drive checkout. Tauri's
    // resource_dir may already be canonicalized to UNC and is slower.
    candidates.push(current.join("runtime/src/index.mjs"));
    // During `tauri dev` the resource directory can be laid out relative to
    // the target directory; keep the executable-relative lookup as a fallback
    // so launching the binary from a shortcut or installer still finds the
    // bundled runtime regardless of the process working directory.
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.extend([
                parent.join("runtime/src/index.mjs"),
                parent.join("_up_/_up_/runtime/src/index.mjs"),
                parent.join("../../../../runtime/src/index.mjs"),
            ]);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("runtime/src/index.mjs"));
    }
    candidates.extend([
        current.join("../runtime/src/index.mjs"),
        current.join("../../runtime/src/index.mjs"),
        current.join("../../../runtime/src/index.mjs"),
    ]);
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(resolve_entry)
        .ok_or_else(|| "找不到 runtime/src/index.mjs，请设置 DDA_RUNTIME_ENTRY".to_string())
}

fn normalize_existing_file(candidate: PathBuf) -> PathBuf {
    let resolved = if candidate.is_file() {
        candidate
    } else {
        candidate.canonicalize().unwrap_or(candidate)
    };
    prefer_mapped_path(resolved)
}

fn normalize_existing_dir(candidate: PathBuf) -> Result<PathBuf, std::io::Error> {
    let resolved = candidate.canonicalize()?;
    Ok(prefer_mapped_path(resolved))
}

fn prefer_mapped_path(candidate: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let Some((candidate_root, suffix)) = unc_root_and_suffix(&candidate) else {
            return candidate;
        };
        for drive in mapped_drive_letters() {
            let drive_root = PathBuf::from(format!("{drive}:\\"));
            let Ok(resolved_drive_root) = drive_root.canonicalize() else {
                continue;
            };
            let Some((resolved_root, _)) = unc_root_and_suffix(&resolved_drive_root) else {
                continue;
            };
            if normalize_windows_path(&resolved_root) == normalize_windows_path(&candidate_root) {
                let tail = if suffix.is_empty() {
                    "\\".to_string()
                } else {
                    suffix
                };
                return PathBuf::from(format!("{drive}:{tail}"));
            }
        }
    }
    candidate
}

#[cfg(windows)]
fn mapped_drive_letters() -> Vec<char> {
    static CACHE: OnceLock<Vec<char>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let Ok(output) = Command::new("net.exe")
                .creation_flags(CREATE_NO_WINDOW)
                .arg("use")
                .output()
            else {
                return Vec::new();
            };
            let text = String::from_utf8_lossy(&output.stdout);
            let mut drives = Vec::new();
            for token in text.split_whitespace() {
                let bytes = token.as_bytes();
                if bytes.len() == 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
                    let drive = (bytes[0] as char).to_ascii_uppercase();
                    if !drives.contains(&drive) {
                        drives.push(drive);
                    }
                }
            }
            drives
        })
        .clone()
}

#[cfg(windows)]
fn normalize_windows_path(value: &str) -> String {
    value
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

#[cfg(windows)]
fn unc_root_and_suffix(path: &Path) -> Option<(String, String)> {
    let raw = path.to_string_lossy().replace('/', "\\");
    let without_device_prefix = raw
        .strip_prefix(r"\\?\UNC\")
        .map(|rest| format!(r"\\{rest}"))
        .unwrap_or(raw);
    let rest = without_device_prefix.strip_prefix(r"\\")?;
    let mut parts = rest.splitn(3, '\\');
    let server = parts.next()?;
    let share = parts.next()?;
    if server.is_empty() || share.is_empty() {
        return None;
    }
    let root = format!(r"\\{server}\{share}");
    let suffix = parts
        .next()
        .filter(|value| !value.is_empty())
        .map(|value| format!(r"\{value}"))
        .unwrap_or_default();
    Some((root, suffix))
}

const CELLS_ENV_KEYS: [&str; 3] = [
    "DDA_KERNEL_CODE_CELLS",
    "DDA_KERNEL_WINDOWS_UNSANDBOXED",
    "DDA_KERNEL_WINDOWS_DESKTOP_CELLS",
];
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopSpawnMode {
    /// Fresh Node process. Must not inject resident or cells flags.
    PerInvoke,
    /// The desktop task child. Sets `DDA_RESIDENT_KERNEL` and, when the
    /// experimental toggle is on, the three cells variables. Not a second daemon.
    SessionKeep,
}

/// Production task spawn. Health, dashboard, and history stay `PerInvoke`.
const TASK_RUNTIME_SPAWN_MODE: DesktopSpawnMode = DesktopSpawnMode::SessionKeep;

#[derive(Clone, Debug, PartialEq, Eq)]
struct DesktopSpawnEnvPlan {
    set: Vec<(String, String)>,
    remove: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProcessReapPlan {
    JobKillOnClose,
    TaskkillTree,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettings {
    #[serde(default)]
    experimental_code_cells: bool,
}

fn local_app_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn desktop_settings_path_in(local_app_data: &Path) -> PathBuf {
    local_app_data.join("hmCodex").join("desktop-settings.json")
}

fn windows_desktop_journal_path(local_app_data: &Path, file_name: &str) -> PathBuf {
    local_app_data
        .join("hmCodex")
        .join("journal")
        .join("windows-desktop")
        .join(file_name)
}

fn load_desktop_settings_from(path: &Path) -> Result<DesktopSettings, String> {
    if !path.is_file() {
        return Ok(DesktopSettings {
            experimental_code_cells: false,
        });
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取桌面设置失败: {error}"))?;
    let value: Value = serde_json::from_str(content.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("桌面设置不是有效 JSON: {error}"))?;
    let experimental_code_cells = value
        .get("experimentalCodeCells")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(DesktopSettings {
        experimental_code_cells,
    })
}

fn load_desktop_settings() -> Result<DesktopSettings, String> {
    let Some(root) = local_app_data_dir() else {
        return Ok(DesktopSettings {
            experimental_code_cells: false,
        });
    };
    load_desktop_settings_from(&desktop_settings_path_in(&root))
}

fn persist_desktop_settings_at(path: &Path, settings: &DesktopSettings) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "桌面设置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建桌面设置目录失败: {error}"))?;
    let mut document = if path.is_file() {
        let content = fs::read_to_string(path)
            .map_err(|error| format!("读取桌面设置失败: {error}"))?;
        serde_json::from_str::<Value>(content.trim_start_matches('\u{feff}')).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let object = document
        .as_object_mut()
        .ok_or_else(|| "桌面设置不是 JSON 对象".to_string())?;
    object.insert(
        "experimentalCodeCells".to_string(),
        Value::Bool(settings.experimental_code_cells),
    );
    let body = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("序列化桌面设置失败: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, body).map_err(|error| format!("写入桌面设置失败: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("保存桌面设置失败: {error}"))?;
    Ok(())
}

fn persist_desktop_settings(settings: &DesktopSettings) -> Result<(), String> {
    let root = local_app_data_dir().ok_or_else(|| "LOCALAPPDATA 不可用，无法保存桌面设置".to_string())?;
    persist_desktop_settings_at(&desktop_settings_path_in(&root), settings)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettingsResponse {
    experimental_code_cells: bool,
    settings_path: String,
}

fn desktop_settings_response(settings: &DesktopSettings) -> DesktopSettingsResponse {
    DesktopSettingsResponse {
        experimental_code_cells: settings.experimental_code_cells,
        settings_path: local_app_data_dir()
            .map(|root| desktop_settings_path_in(&root).display().to_string())
            .unwrap_or_default(),
    }
}

#[tauri::command]
fn desktop_settings() -> Result<DesktopSettingsResponse, String> {
    Ok(desktop_settings_response(&load_desktop_settings()?))
}

#[tauri::command]
fn save_desktop_settings(experimental_code_cells: bool) -> Result<DesktopSettingsResponse, String> {
    let settings = DesktopSettings {
        experimental_code_cells,
    };
    persist_desktop_settings(&settings)?;
    Ok(desktop_settings_response(&settings))
}

/// Env ownership for every desktop runtime spawn.
///
/// Cells flags are injected only when the experimental toggle is on AND this
/// spawn is the session-keep path. Turning the toggle off removes only those
/// three variables. `DDA_PLATFORM` is always set and never removed.
/// `DDA_RESIDENT_KERNEL` is set only on the session-keep path.
fn plan_desktop_spawn_env(
    experimental_code_cells: bool,
    mode: DesktopSpawnMode,
    local_app_data: Option<&Path>,
) -> DesktopSpawnEnvPlan {
    let mut set = vec![("DDA_PLATFORM".to_string(), "windows-desktop".to_string())];
    let mut remove = vec!["DDA_KERNEL_SANDBOX".to_string()];
    if experimental_code_cells && mode == DesktopSpawnMode::SessionKeep {
        for key in CELLS_ENV_KEYS {
            set.push((key.to_string(), "1".to_string()));
        }
    } else if !experimental_code_cells {
        for key in CELLS_ENV_KEYS {
            remove.push(key.to_string());
        }
    }
    if mode == DesktopSpawnMode::SessionKeep {
        set.push(("DDA_RESIDENT_KERNEL".to_string(), "1".to_string()));
    }
    if let Some(root) = local_app_data {
        set.push((
            "DDA_KERNEL_EFFECT_JOURNAL".to_string(),
            windows_desktop_journal_path(root, "kernel-effect-journal.json")
                .display()
                .to_string(),
        ));
        set.push((
            "DDA_KERNEL_SESSION_STORE".to_string(),
            windows_desktop_journal_path(root, "kernel-session.json")
                .display()
                .to_string(),
        ));
    }
    DesktopSpawnEnvPlan { set, remove }
}

fn apply_desktop_spawn_env(command: &mut Command, plan: &DesktopSpawnEnvPlan) {
    for key in &plan.remove {
        command.env_remove(key);
    }
    for (key, value) in &plan.set {
        command.env(key, value);
    }
}

/// Node 24 is not vendored. 鹏飞 deferred frozen §8: use `resource_dir/node/node.exe`
/// when that file is already present, otherwise PATH `node`, unless `DDA_NODE` is set.
/// Cells still return `NODE_TOO_OLD` when the actual major is below 24.
fn resolve_node_program(dda_node: Option<&std::ffi::OsStr>, resource_dir: Option<&Path>) -> std::ffi::OsString {
    if let Some(override_node) = dda_node {
        if !override_node.is_empty() {
            return override_node.to_os_string();
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("node").join("node.exe");
        if bundled.is_file() {
            return bundled.into_os_string();
        }
    }
    std::ffi::OsString::from("node")
}

fn runtime_creation_flags(mode: DesktopSpawnMode) -> u32 {
    #[cfg(windows)]
    {
        match mode {
            DesktopSpawnMode::PerInvoke => CREATE_NO_WINDOW,
            DesktopSpawnMode::SessionKeep => CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = mode;
        0
    }
}

fn process_reap_plan(job_assigned: bool) -> ProcessReapPlan {
    if job_assigned {
        ProcessReapPlan::JobKillOnClose
    } else {
        ProcessReapPlan::TaskkillTree
    }
}

fn close_job_handle(handle: usize) -> bool {
    #[cfg(windows)]
    {
        windows_job::close_raw(handle)
    }
    #[cfg(not(windows))]
    {
        let _ = handle;
        false
    }
}

/// Assign a session-keep child to its own dedicated kill-on-close job handle so
/// stopping one task never terminates sibling parallel tasks.
fn bind_session_keep_reaper(pid: u32) -> Option<usize> {
    let handle = assign_kill_on_job_close_handle(pid, TASK_RUNTIME_SPAWN_MODE);
    if handle.is_some() {
        append_desktop_log(&format!("session-keep job assigned pid={pid}"));
    } else {
        append_desktop_log(&format!(
            "session-keep job not assigned pid={pid}; reap falls back to taskkill /T"
        ));
    }
    handle
}

fn assign_kill_on_job_close_handle(pid: u32, mode: DesktopSpawnMode) -> Option<usize> {
    if mode != DesktopSpawnMode::SessionKeep || pid == 0 {
        return None;
    }
    #[cfg(windows)]
    {
        windows_job::create_and_assign(pid)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(test)]
fn try_assign_kill_on_job_close(pid: u32, mode: DesktopSpawnMode) -> bool {
    if let Some(handle) = assign_kill_on_job_close_handle(pid, mode) {
        close_job_handle(handle);
        true
    } else {
        false
    }
}

fn taskkill_tree(pid: u32) -> std::io::Result<std::process::ExitStatus> {
    #[cfg(windows)]
    {
        Command::new("taskkill")
            .args(["/PID", pid.to_string().as_str(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
    }
    #[cfg(not(windows))]
    {
        Command::new("kill")
            .args(["-TERM", pid.to_string().as_str()])
            .status()
    }
}

/// Job-object close is the reap when a per-slot session-keep job was assigned.
/// Create failure, or no stored job, falls back to `taskkill /T`.
fn reap_runtime_slot(pid: u32, job_handle: Option<usize>) -> std::io::Result<bool> {
    let job_assigned = job_handle.is_some();
    if process_reap_plan(job_assigned) == ProcessReapPlan::JobKillOnClose {
        if let Some(handle) = job_handle {
            if close_job_handle(handle) {
                return Ok(true);
            }
        }
    }
    taskkill_tree(pid).map(|status| status.success())
}

#[cfg(windows)]
mod windows_job {
    use std::ffi::c_void;

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const PROCESS_TERMINATE: u32 = 0x0001;

    #[repr(C)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        #[cfg(target_pointer_width = "64")]
        _pad0: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        #[cfg(target_pointer_width = "64")]
        _pad1: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    extern "system" {
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: u32,
            info: *const c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    pub fn close_raw(handle: usize) -> bool {
        if handle == 0 {
            return false;
        }
        unsafe { CloseHandle(handle as *mut c_void) != 0 }
    }

    pub fn create_and_assign(pid: u32) -> Option<usize> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: ExtendedLimit = std::mem::zeroed();
            info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                &info as *const ExtendedLimit as *const c_void,
                std::mem::size_of::<ExtendedLimit>() as u32,
            );
            if configured == 0 {
                CloseHandle(job);
                return None;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                CloseHandle(job);
                return None;
            }
            let assigned = AssignProcessToJobObject(job, process);
            CloseHandle(process);
            if assigned == 0 {
                CloseHandle(job);
                return None;
            }
            Some(job as usize)
        }
    }
}

/// Short-lived queries (health, dashboard, history). Fresh health therefore
/// stops at `NODE_TOO_OLD` or `DESKTOP_SESSION_KEEP_REQUIRED`. The task child
/// uses `TASK_RUNTIME_SPAWN_MODE`.
fn runtime_command(runtime: &Path, resource_dir: Option<&Path>) -> Command {
    runtime_command_for(runtime, resource_dir, DesktopSpawnMode::PerInvoke)
}

fn add_runtime_env_proxy_arg(command: &mut Command, node_version: Option<&str>) {
    let major = node_version.and_then(|version| {
        version.trim().strip_prefix('v')?.split('.').next()?.parse::<u32>().ok()
    });
    // Older Node versions must still start so runtime health can report their
    // compatibility. Unknown versions also omit the unsupported CLI option.
    if major.is_some_and(|major| major >= 24) {
        command.arg("--use-env-proxy");
    }
}

fn runtime_command_for(
    runtime: &Path,
    resource_dir: Option<&Path>,
    mode: DesktopSpawnMode,
) -> Command {
    let program = resolve_node_program(std::env::var_os("DDA_NODE").as_deref(), resource_dir);
    let mut version_command = Command::new(&program);
    version_command.arg("--version");
    #[cfg(windows)]
    version_command.creation_flags(CREATE_NO_WINDOW);
    let node_version = version_command.output().ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok());
    let mut command = Command::new(program);
    add_runtime_env_proxy_arg(&mut command, node_version.as_deref());
    #[cfg(windows)]
    command.creation_flags(runtime_creation_flags(mode));
    if let Some(channel) = option_env!("DDA_BAKED_RELEASE_CHANNEL") {
        command.env("DDA_BAKED_RELEASE_CHANNEL", channel);
    }
    command.env(
        "DDA_RELEASE_CHANNEL",
        desktop_release_channel().unwrap_or_else(|_| "INVALID_CHANNEL".to_string()),
    );
    let cells_enabled = load_desktop_settings()
        .map(|settings| settings.experimental_code_cells)
        .unwrap_or(false);
    let plan = plan_desktop_spawn_env(cells_enabled, mode, local_app_data_dir().as_deref());
    apply_desktop_spawn_env(&mut command, &plan);
    // The Node child is node.exe. The locked build output is this desktop process.
    if let Ok(executable) = std::env::current_exe() {
        command.env("DDA_HOST_EXECUTABLE", executable);
    }
    if let Some(parent) = runtime.parent().and_then(Path::parent) {
        // Keep module resolution and any relative runtime data anchored at the
        // bundled runtime directory when the app is started from a shortcut.
        command.current_dir(parent);
    }
    command
}

fn workspace_root_label(root: &Path) -> String {
    root.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| root.display().to_string())
}

fn is_ephemeral_default_workspace(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    if normalized.starts_with("c:/windows") || normalized == "c:" {
        return true;
    }
    if normalized.contains("/appdata/local/dda/")
        || normalized.contains("/appdata/local/hmcodex")
        || normalized.contains("/appdata/roaming/hmcodex")
        || normalized.contains("/appdata/local/temp/")
        || normalized.contains("/desktop-builds/")
    {
        return true;
    }
    normalized
        .split('/')
        .any(|part| part == "target" || part == "cargo-target" || part == "node_modules" || part.starts_with("target-"))
}

fn default_workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("DDA_WORKSPACE_ROOT") {
        let candidate = PathBuf::from(value);
        if candidate.is_dir() {
            return normalize_existing_dir(candidate)
                .map_err(|error| format!("无法解析默认工作区: {error}"));
        }
    }

    let mut candidates = Vec::with_capacity(12);
    if let Ok(current) = std::env::current_dir() {
        candidates.extend([
            current.clone(),
            current.join(".."),
            current.join("../.."),
            current.join("../../.."),
            current.join("../../../.."),
        ]);
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.extend([
                parent.to_path_buf(),
                parent.join(".."),
                parent.join("../.."),
                parent.join("../../.."),
                parent.join("../../../.."),
            ]);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir);
    }

    let mut fallback = None;
    for candidate in candidates {
        let Ok(resolved) = candidate.canonicalize().map(prefer_mapped_path) else {
            continue;
        };
        if !resolved.is_dir() || is_ephemeral_default_workspace(&resolved) {
            continue;
        }
        if fallback.is_none() {
            fallback = Some(resolved.clone());
        }
        let looks_like_repo_root = resolved.join(".git").exists()
            || (resolved.join("desktop").is_dir() && resolved.join("runtime").is_dir())
            || resolved.join("contracts").is_dir();
        if looks_like_repo_root {
            return Ok(resolved);
        }
    }
    fallback.ok_or_else(|| {
        "找不到默认工作区，请设置 DDA_WORKSPACE_ROOT 或点击“打开项目”".to_string()
    })
}

fn ensure_default_workspace(app: &AppHandle, state: &AppState) -> Result<PathBuf, String> {
    if let Some(root) = state
        .workspace_root
        .lock()
        .map_err(|_| "工作区状态不可用".to_string())?
        .clone()
    {
        return Ok(root);
    }
    let root = default_workspace_root(app)?;
    let mut workspace_root = state
        .workspace_root
        .lock()
        .map_err(|_| "工作区状态不可用".to_string())?;
    if workspace_root.is_none() {
        *workspace_root = Some(root.clone());
    }
    Ok(workspace_root.clone().unwrap_or(root))
}

fn terminal_stdout_error(stdout_text: &str) -> Option<String> {
    // runtime 快速失败时会把 {"ok":false,...} 写进 stdout；若输出管道被
    // 子进程占用导致 EOF 未到达，监督器会误判为心跳超时。这里优先把真实
    // 的终态错误提取出来返回给用户。
    let lines: Vec<&str> = stdout_text.lines().rev().take(8).collect();
    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            if value.get("ok") == Some(&Value::Bool(false)) {
                if let Some(error) = value.get("error").and_then(Value::as_str) {
                    if !error.trim().is_empty() {
                        return Some(error.trim().to_string());
                    }
                }
            }
        }
    }
    None
}

fn runtime_last_phase(stdout_text: &str) -> Option<String> {
    for line in stdout_text.lines().rev() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if value.get("type").and_then(Value::as_str) != Some("runtime_event") { continue }
        let kind = value.get("kind").and_then(Value::as_str);
        let payload = value.get("payload");
        if kind == Some("runtime.phase") {
            if let Some(phase) = payload.and_then(|item| item.get("phase")).and_then(Value::as_str) {
                return Some(phase.to_string());
            }
        }
        if kind == Some("run.state_changed") {
            if let Some(state) = payload.and_then(|item| item.get("to")).and_then(Value::as_str) {
                return Some(format!("run.state_changed:{state}"));
            }
        }
    }
    None
}

fn bounded_process_error(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let suffix: String = trimmed.chars().take(500).collect();
    format!(": {suffix}")
}

const HARNESS_PROCESS_DEFER: &str = "任务还在使用运行时数据库，这次不会另开进程。任务结束后会自动刷新。";
const JEV_PROCESS_DEFER: &str = "JEV 判断现在不要另开进程。任务结束后会自动刷新。";

#[derive(Debug, PartialEq, Eq)]
enum SideProcessAdmission {
    /// No task is running, or this is the lightweight history reader.
    Spawn,
    /// A read that does not open the harness database. Jev chooses.
    AskJev,
    /// Would open the harness database while a task process is alive.
    Defer,
}

fn runtime_flag_value<'a>(args: &'a [&'a str], flag: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == flag && !pair[1].starts_with('-'))
        .map(|pair| pair[1])
}

fn memory_read_without_harness(args: &[&str]) -> bool {
    if !matches!(args.first().copied(), Some("memory" | "memories")) {
        return false;
    }
    let operation = runtime_flag_value(args, "--operation")
        .or_else(|| args.get(1).copied().filter(|value| !value.starts_with('-')))
        .unwrap_or("list");
    operation == "list" || operation == "get"
}

fn task_slot_active(state: &AppState) -> bool {
    state
        .runtime_slots
        .lock()
        .map(|slots| !slots.is_empty())
        .unwrap_or(false)
}

/// Host policy for a side process while a task may already be running.
/// Kept aligned with runtime/src/decision/process-admission.mjs.
fn side_process_admission(task_active: bool, args: &[&str]) -> SideProcessAdmission {
    if !task_active || is_history_read(args) {
        SideProcessAdmission::Spawn
    } else if memory_read_without_harness(args) {
        SideProcessAdmission::AskJev
    } else {
        SideProcessAdmission::Defer
    }
}

fn jev_process_admission(app: &AppHandle, args: &[&str]) -> Result<String, String> {
    let runtime = runtime_entrypoint(app)?;
    let script = runtime.with_file_name("process-admission.mjs");
    let resource_dir = app.path().resource_dir().ok();
    let operation = runtime_flag_value(args, "--operation").unwrap_or("list");
    let output = runtime_command(&script, resource_dir.as_deref())
        .arg(&script)
        .arg("--command")
        .arg(args.first().copied().unwrap_or(""))
        .arg("--operation")
        .arg(operation)
        .output()
        .map_err(|error| format!("无法启动进程准入: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|value| !value.trim().is_empty())
        .ok_or_else(|| "进程准入没有返回结果".to_string())?;
    let value = serde_json::from_str::<Value>(line)
        .map_err(|error| format!("进程准入结果无效: {error}"))?;
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("进程准入失败")
            .to_string());
    }
    value
        .get("decision")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "进程准入没有给出决定".to_string())
}

fn admit_side_process(app: &AppHandle, args: &[&str]) -> Result<(), String> {
    let state = app.state::<AppState>();
    match side_process_admission(task_slot_active(state.inner()), args) {
        SideProcessAdmission::Spawn => Ok(()),
        SideProcessAdmission::Defer => Err(HARNESS_PROCESS_DEFER.to_string()),
        SideProcessAdmission::AskJev => match jev_process_admission(app, args) {
            Ok(decision) if decision == "DEFER" => Err(JEV_PROCESS_DEFER.to_string()),
            Ok(decision) => {
                append_desktop_log(&format!("process admission decision={decision}"));
                Ok(())
            }
            Err(error) => {
                // The rule for this command is to open the read. A failed
                // Jev call must not hide the skill list.
                append_desktop_log(&format!("process admission fallback error={error}"));
                Ok(())
            }
        },
    }
}

fn is_history_read(args: &[&str]) -> bool {
    args.first() == Some(&"thread-events")
        || (args.first() == Some(&"dashboard") && args.windows(2).any(|pair| pair == ["--summary", "true"]))
        || (args.first() == Some(&"thread")
            && args.windows(2).any(|pair| pair == ["--summary", "true"])
            && args.windows(2).any(|pair| pair == ["--operation", "list"] || pair == ["--operation", "get"]))
}

fn run_runtime_json(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    // A live task opens the harness database and can stall before
    // RoleContextAllocated if another process runs an integrity check on it.
    // There is no process lock. Jev decides a side process that stays off
    // that database; any other side process waits until the task exits.
    let admission_started = Instant::now();
    admit_side_process(app, args)?;
    let admission_ms = admission_started.elapsed().as_millis();
    let command_name = args.first().copied().unwrap_or("unknown");
    append_desktop_log(&format!("runtime query start command={command_name} admission_ms={admission_ms}"));
    let runtime = runtime_entrypoint(app)?;
    let runtime = if is_history_read(args) { runtime.with_file_name("history-cli.mjs") } else { runtime };
    let resource_dir = app.path().resource_dir().ok();
    let output = runtime_command(&runtime, resource_dir.as_deref())
        .arg(runtime)
        .args(args)
        .output()
        .map_err(|error| {
            append_desktop_log(&format!("runtime 命令 spawn 失败: {error}"));
            format!("无法启动 Cordis runtime: {error}")
        })?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            append_desktop_log(&format!(
                "runtime query empty command={command_name} status={:?} stderr={}",
                output.status,
                bounded_process_error(&stderr)
            ));
            format!(
                "Cordis runtime 没有返回结果{}",
                bounded_process_error(&stderr)
            )
        })?;
    let value = serde_json::from_str::<Value>(line).map_err(|error| {
        append_desktop_log(&format!(
            "runtime query invalid-json command={command_name} error={error}"
        ));
        format!("Cordis runtime 返回了无效结果: {error}")
    })?;
    if !output.status.success() || value.get("ok").and_then(Value::as_bool) == Some(false) {
        let detail = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("runtime 命令失败");
        append_desktop_log(&format!(
            "runtime query failed command={command_name} status={:?} detail={detail}",
            output.status
        ));
        return Err(detail.to_string());
    }
    append_desktop_log(&format!("runtime query complete command={command_name}"));
    Ok(value)
}

fn run_runtime_json_owned(app: &AppHandle, args: &[String]) -> Result<Value, String> {
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    run_runtime_json(app, &borrowed)
}

fn validate_relative_path(relative_path: &str) -> Result<(), String> {
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("只允许工作区内的相对路径".to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) | Component::CurDir
        )
    }) {
        return Err("路径包含不允许的组件".to_string());
    }
    Ok(())
}

fn resolve_within(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    validate_relative_path(relative_path)?;
    let root = normalize_existing_dir(root.to_path_buf())
        .map_err(|error| format!("无法解析授权工作区: {error}"))?;
    let resolved = root
        .join(relative_path)
        .canonicalize()
        .map(prefer_mapped_path)
        .map_err(|error| format!("无法解析工作区路径: {error}"))?;
    if !path_is_within(&root, &resolved) {
        return Err("目标路径超出已授权工作区".to_string());
    }
    Ok(resolved)
}

fn path_is_within(root: &Path, candidate: &Path) -> bool {
    #[cfg(windows)]
    {
        // Windows mapped drives and UNC paths can differ only by drive/host
        // spelling or case after canonicalization. Compare normalized strings
        // case-insensitively while retaining a component boundary.
        let normalize = |path: &Path| {
            path.to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_ascii_lowercase()
        };
        let root = normalize(root);
        let candidate = normalize(candidate);
        candidate == root || candidate.starts_with(&(root + "\\"))
    }
    #[cfg(not(windows))]
    {
        candidate.starts_with(root)
    }
}

fn list_workspace_impl(
    root: Option<&Path>,
    relative_path: &str,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = root.ok_or_else(|| "尚未授权工作区".to_string())?;
    let directory = resolve_within(root, relative_path)?;
    if !directory.is_dir() {
        return Err("目标路径不是目录".to_string());
    }

    let mut entries = Vec::new();
    for entry_result in
        fs::read_dir(&directory).map_err(|error| format!("无法读取目录: {error}"))?
    {
        let entry = entry_result.map_err(|error| format!("无法读取目录项: {error}"))?;
        let logical_path = Path::new(relative_path).join(entry.file_name());
        let Ok(resolved_entry) = entry.path().canonicalize().map(prefer_mapped_path) else {
            continue;
        };
        if !path_is_within(root, &resolved_entry) {
            continue;
        }
        let metadata = fs::metadata(&resolved_entry)
            .map_err(|error| format!("无法读取目录项元数据: {error}"))?;
        let (kind, size_bytes) = if metadata.is_dir() {
            (WorkspaceEntryKind::Directory, 0)
        } else if metadata.is_file() {
            (WorkspaceEntryKind::File, metadata.len())
        } else {
            continue;
        };
        entries.push(WorkspaceEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            relative_path: path_for_contract(&logical_path),
            kind,
            size_bytes,
        });
        if entries.len() == MAX_DIRECTORY_ENTRIES {
            break;
        }
    }

    entries.sort_by(|left, right| {
        let left_is_file = left.kind == WorkspaceEntryKind::File;
        let right_is_file = right.kind == WorkspaceEntryKind::File;
        left_is_file
            .cmp(&right_is_file)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(entries)
}

fn read_workspace_file_impl(
    root: Option<&Path>,
    relative_path: &str,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    let root = root.ok_or_else(|| "尚未授权工作区".to_string())?;
    let resolved = resolve_within(root, relative_path)?;
    let metadata =
        fs::metadata(&resolved).map_err(|error| format!("无法读取文件元数据: {error}"))?;
    if !metadata.is_file() {
        return Err("目标路径不是文件".to_string());
    }

    let limit = max_bytes
        .unwrap_or(DEFAULT_PREVIEW_BYTES)
        .clamp(1, MAX_PREVIEW_BYTES);
    let mut bytes = Vec::with_capacity((limit + 1) as usize);
    File::open(&resolved)
        .map_err(|error| format!("无法打开文件: {error}"))?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取文件: {error}"))?;
    let truncated = metadata.len() > limit || bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);

    let content_digest = format!("sha256:{:x}", Sha256::digest(&bytes));
    let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
    let content = if binary {
        String::new()
    } else {
        String::from_utf8(bytes).expect("UTF-8 was validated")
    };

    Ok(WorkspaceFile {
        relative_path: path_for_contract(Path::new(relative_path)),
        content,
        content_digest,
        total_bytes: metadata.len(),
        truncated,
        binary,
    })
}

fn path_for_contract(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

static WEBVIEW_CREATE_FAILURE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn captured_webview_create_failure(level: log::Level, target: &str, message: &str) -> Option<String> {
    (level == log::Level::Error && target == "tauri_runtime_wry" && message.contains("failed to create webview"))
        .then(|| message.to_string())
}

struct DesktopLogger;
impl log::Log for DesktopLogger {
    fn enabled(&self, m: &log::Metadata) -> bool { m.level() <= log::Level::Warn }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            let message = format!("{}: {}", r.target(), r.args());
            eprintln!("[{}] {}", r.level(), message);
            append_desktop_log_at(&r.level().to_string(), &message);
            if let Some(failure) = captured_webview_create_failure(r.level(), r.target(), &r.args().to_string()) {
                if let Ok(mut slot) = WEBVIEW_CREATE_FAILURE.lock() {
                    *slot = Some(failure);
                }
            }
        }
    }
    fn flush(&self) {}
}
static DESKTOP_LOGGER: DesktopLogger = DesktopLogger;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardImagePayload {
    name: String,
    media_type: String,
    data_url: String,
    size_bytes: usize,
}

#[tauri::command]
async fn read_clipboard_images() -> Result<Vec<ClipboardImagePayload>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;
            let script = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$out = @()
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
  foreach ($f in $files) {
    if ($out.Count -ge 4) { break }
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
    $ext = [System.IO.Path]::GetExtension($f).ToLowerInvariant()
    $mime = switch ($ext) {
      '.png'  { 'image/png' }
      '.jpg'  { 'image/jpeg' }
      '.jpeg' { 'image/jpeg' }
      '.webp' { 'image/webp' }
      '.gif'  { 'image/gif' }
      default { $null }
    }
    if (-not $mime) { continue }
    $info = Get-Item -LiteralPath $f
    if ($info.Length -le 0 -or $info.Length -gt 10485760) { continue }
    $bytes = [System.IO.File]::ReadAllBytes($f)
    $b64 = [Convert]::ToBase64String($bytes)
    $out += @{
      name = $info.Name
      mediaType = $mime
      dataUrl = "data:$mime;base64,$b64"
      sizeBytes = [int]$bytes.Length
    }
  }
} elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  if ($img -ne $null) {
    $ms = New-Object System.IO.MemoryStream
    try {
      $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
      $bytes = $ms.ToArray()
      if ($bytes.Length -gt 0 -and $bytes.Length -le 10485760) {
        $b64 = [Convert]::ToBase64String($bytes)
        $out += @{
          name = '粘贴图片.png'
          mediaType = 'image/png'
          dataUrl = "data:image/png;base64,$b64"
          sizeBytes = [int]$bytes.Length
        }
      }
    } finally {
      $ms.Dispose()
      $img.Dispose()
    }
  }
}
ConvertTo-Json -InputObject @($out) -Compress
"#;
            let mut cmd = Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .creation_flags(CREATE_NO_WINDOW_FLAG);
            let child = cmd
                .spawn()
                .map_err(|e| format!("读取剪贴板图片失败: {e}"))?;
            let output = wait_child_output(child, Duration::from_secs(5))
                .map_err(|_| "读取剪贴板图片超时".to_string())?;
            if !output.status.success() {
                return Ok(Vec::new());
            }
            let text = String::from_utf8_lossy(&output.stdout);
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed == "null" {
                return Ok(Vec::new());
            }
            let parsed: Vec<ClipboardImagePayload> = serde_json::from_str(trimmed)
                .or_else(|_| serde_json::from_str::<ClipboardImagePayload>(trimmed).map(|one| vec![one]))
                .unwrap_or_default();
            let as_inputs: Vec<RuntimeImageInput> = parsed
                .iter()
                .map(|item| RuntimeImageInput {
                    name: Some(item.name.clone()),
                    media_type: item.media_type.clone(),
                    data_url: item.data_url.clone(),
                })
                .collect();
            validate_task_images(&as_inputs)?;
            Ok(parsed)
        })
        .await
        .map_err(|e| format!("剪贴板任务失败: {e}"))?
    }
}

#[tauri::command]
async fn access_mode() -> Result<computer_access::AccessStatus, String> {
    Ok(computer_access::access_mode())
}

#[tauri::command]
async fn set_access_mode(mode: String, confirmed: bool) -> Result<computer_access::AccessStatus, String> {
    let status = computer_access::set_access_mode(&mode, confirmed)?;
    append_desktop_log(&format!("computer-access | mode={mode} | confirmed={confirmed}"));
    Ok(status)
}

fn verify_main_window(app: &tauri::App) -> Result<(), String> {
    if let Some(failure) = WEBVIEW_CREATE_FAILURE.lock().ok().and_then(|slot| slot.clone()) {
        return Err(format!("WebView2 window creation failed: {failure}"));
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window was not created".to_string())?;
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|error| format!("main window handle unavailable: {error}"))?;
        if hwnd.0.is_null() {
            return Err("main window handle is null".to_string());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn report_webview_failure(detail: &str) {
    let message = format!(
        "dda 无法创建 WebView2 窗口。\n\nThe WebView2 window could not be created: {detail}\n\n\
         请使用 desktop\\launch.cmd 启动已暂存的构建，不要直接运行沙箱 target 目录中的 dda-desktop.exe。\n\
         Start the staged build with desktop\\launch.cmd instead of the sandboxed target folder."
    );
    rfd::MessageDialog::new()
        .set_title("dda")
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = log::set_logger(&DESKTOP_LOGGER).map(|()| log::set_max_level(log::LevelFilter::Warn));
    if let Ok(mut slot) = WEBVIEW_CREATE_FAILURE.lock() {
        *slot = None;
    }
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            if let Err(error) = verify_main_window(app) {
                log::error!("{error}");
                #[cfg(windows)]
                report_webview_failure(&error);
                return Err(error.into());
            }
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if runtime_entrypoint(&app_handle).is_ok() {
                    let status = local_context_status();
                    let _ = app_handle.emit("context-sidecar-status", &status);
                }
            });
            // Balloon notifications ride the main-window message pump. A
            // failed install must never abort startup.
            if let Err(error) = notifications::initialize(app) {
                log::warn!("desktop notifications unavailable: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Focus clears the taskbar attention flash a notice requested.
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                let _ = window.request_user_attention(None);
            }
        })
        .invoke_handler(tauri::generate_handler![
            runtime_snapshot,
            model_config,
            save_model_config,
            provider_model_catalog,
            fetch_provider_models,
            save_provider_model_catalog,
            configured_model_ids,
            runtime_process_status,
            context_sidecar_status,
            choose_workspace,
            set_workspace,
            default_workspace,
            list_workspace,
            read_workspace_file,
            list_threads,
            runtime_dashboard,
            runtime_timeline_page,
            get_thread,
            list_thread_events,
            archive_thread_events,
            archive_threads,
            vacuum_event_store,
            fork_thread,
            list_execution_state,
            get_execution_state,
            reconcile_execution_state,
            cancel_execution_approval,
            revoke_execution_lease,
            reconcile_runtime_state,
            export_data,
            save_task_result,
            list_memories,
            memory_action,
            list_dream_runs,
            run_dream,
            dream_maintenance_status,
            start_dream_maintenance,
            stop_dream_maintenance,
            list_plugin_governance,
            plugin_action,
            list_evolution,
            evolution_action,
            run_model_task,
            read_clipboard_images,
            cancel_model_task,
            resolve_runtime_approval,
            resolve_runtime_clarification,
            desktop_settings,
            save_desktop_settings,
            notifications::show_desktop_notification,
            access_mode,
            set_access_mode
        ])
        .build(tauri::generate_context!())
        .expect("error while building dda");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            let state = app_handle.state::<AppState>();
            let _ = cancel_all_runtime_processes(state.inner());
            let _ = stop_dream_maintenance_impl(&app_handle, &state.dream_maintenance);
            notifications::shutdown();
        }
    });
}

#[cfg(test)]
mod desktop_log_tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(18_993), (2022, 1, 1));
        assert_eq!(civil_from_days(19_000), (2022, 1, 8));
        // 2024 is a leap year: Feb 29 2024 = 19782 days after the epoch.
        assert_eq!(civil_from_days(19_781), (2024, 2, 28));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn iso_utc_from_ms_formats_known_instant() {
        // The famous 1234567890-second moment.
        assert_eq!(
            iso_utc_from_ms(1_234_567_890_123),
            "2009-02-13T23:31:30.123Z"
        );
        assert_eq!(iso_utc_from_ms(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn desktop_log_dir_targets_hmcodex_logs() {
        let dir = desktop_log_dir().expect("LOCALAPPDATA exists on Windows test hosts");
        assert!(dir.ends_with("hmCodex/logs"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_reads_stay_on_the_lightweight_reader() {
        assert!(is_history_read(&["thread-events", "--thread-id", "test", "--limit", "100"]));
        assert!(is_history_read(&["dashboard", "--summary", "true"]));
        assert!(is_history_read(&["thread", "--operation", "list", "--summary", "true"]));
        assert!(is_history_read(&["thread", "--operation", "get", "--summary", "true"]));
        for args in [vec!["dashboard"], vec!["dashboard", "--summary", "false"],
            vec!["recovery"], vec!["thread", "--operation", "fork", "--summary", "true"]] {
            assert!(!is_history_read(&args));
        }
    }

    #[test]
    fn side_process_admission_asks_jev_only_for_a_memory_read() {
        assert_eq!(
            side_process_admission(false, &["recovery"]),
            SideProcessAdmission::Spawn
        );
        assert_eq!(
            side_process_admission(true, &["thread-events", "--thread-id", "t"]),
            SideProcessAdmission::Spawn
        );
        assert_eq!(
            side_process_admission(true, &["memory", "--operation", "list"]),
            SideProcessAdmission::AskJev
        );
        assert_eq!(
            side_process_admission(true, &["memories", "get", "--memory-id", "m"]),
            SideProcessAdmission::AskJev
        );
        assert_eq!(
            side_process_admission(true, &["memory", "--operation", "retract"]),
            SideProcessAdmission::Defer
        );
        assert_eq!(
            side_process_admission(true, &["dashboard"]),
            SideProcessAdmission::Defer
        );
    }

    #[test]
    fn task_response_preserves_runtime_identity_for_desktop() {
        let response: RuntimeTaskResponse = serde_json::from_value(serde_json::json!({
            "ok": true, "runId": "runtime-run-1", "text": "done"
        }))
        .unwrap();
        assert_eq!(response.run_id.as_deref(), Some("runtime-run-1"));
        let forwarded = serde_json::to_value(response).unwrap();
        assert_eq!(forwarded["runId"], "runtime-run-1");
        let legacy: RuntimeTaskResponse =
            serde_json::from_value(serde_json::json!({ "ok": false, "error": "FAILED" })).unwrap();
        assert!(legacy.run_id.is_none());
    }

    #[test]
    fn release_gate_accepts_controlled_and_rejects_retired_or_invalid() {
        for channel in ["WINDOWS_PHASE1_READ_ONLY", "LINUX_CLI_READ_ONLY", "WINDOWS_MVP_PRE_PHASE1"] {
            assert_eq!(
                validate_release_mode(channel, None).unwrap_err(),
                "RELEASE_CHANNEL_RETIRED"
            );
        }
        for channel in ["", "phase1", "WINDOWS_PHASE1_5_CONTROlLED"] {
            assert_eq!(
                validate_release_mode(channel, None).unwrap_err(),
                "RELEASE_CHANNEL_INVALID"
            );
        }
        for channel in ["WINDOWS_PHASE1_5_CONTROLLED", "WINDOWS_FULL_LOCAL"] {
            assert!(validate_release_mode(channel, None).is_ok());
            assert!(validate_release_mode(channel, Some("CONTROLLED")).is_ok());
        }
        assert_eq!(
            validate_release_mode("WINDOWS_PHASE1_5_CONTROLLED", Some("READ_ONLY")).unwrap_err(),
            "EXECUTION_MODE_INVALID"
        );
        assert!(validate_release_mode("WINDOWS_FULL_LOCAL", Some("unknown")).is_err());
    }
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn configured_model_ids_respects_state_and_executor_allowlist() {
        let document = serde_json::json!({
            "model": "primary",
            "models": [
                { "modelId": "a", "model": "model-a" },
                { "modelId": "b", "model": "model-b", "state": "DISABLED" },
                { "modelId": "c", "model": "model-c" }
            ],
            "roleBindings": { "executor": { "allowList": ["a"] } }
        });
        assert_eq!(configured_model_ids_from(&document, "primary"), vec!["primary", "model-a", "a"]);
        let open = serde_json::json!({ "models": [{ "modelId": "c", "model": "model-c" }] });
        assert_eq!(configured_model_ids_from(&open, "primary"), vec!["primary", "model-c", "c"]);
    }

    #[test]
    fn model_config_uses_runtime_json_field_names() {
        let config: ModelConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": "1.0",
            "provider": "compatible",
            "protocol": "chat-completions",
            "model": "custom-model",
            "baseURL": "https://models.example/v1",
            "apiKeyEnv": "CUSTOM_API_KEY",
            "verifier": {
                "criteria": ["只输出结论"],
                "repetitions": 3,
                "maxComparisons": 8,
                "passThreshold": 0.95
            }
        }))
        .unwrap();
        assert_eq!(
            config.base_url.as_deref(),
            Some("https://models.example/v1")
        );
        let serialized = serde_json::to_value(config).unwrap();
        assert_eq!(serialized["baseURL"], "https://models.example/v1");
        assert!(serialized.get("baseUrl").is_none());
        assert_eq!(serialized["verifier"]["repetitions"], 3);
        assert_eq!(serialized["verifier"]["criteria"][0], "只输出结论");
        // 未配置时必须整体省略，避免写出空对象覆盖 runtime 默认值。
        let bare: ModelConfig = serde_json::from_value(serde_json::json!({
            "schemaVersion": "1.0",
            "provider": "compatible",
            "protocol": "chat-completions",
            "model": "custom-model",
            "apiKeyEnv": "CUSTOM_API_KEY"
        }))
        .unwrap();
        let bare_serialized = serde_json::to_value(bare).unwrap();
        assert!(bare_serialized.get("verifier").is_none());
    }

    #[test]
    fn model_config_migrates_retired_opencode_go_model_alias() {
        let mut config = default_model_config();
        config.model = "mimo-v2.6".to_string();
        let migrated = normalize_legacy_model_alias(config);
        assert_eq!(migrated.model, "mimo-v2.6-pro");

        let mut other_route = default_model_config();
        other_route.model = "mimo-v2.6".to_string();
        other_route.base_url = Some("https://gateway.example/v1".to_string());
        assert_eq!(normalize_legacy_model_alias(other_route).model, "mimo-v2.6");
    }

    #[test]
    fn model_config_save_preserves_advanced_fields_and_replaces_existing_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("model-config.json");
        fs::write(
            &path,
            r#"{"models":[{"modelId":"backup"}],"roleBindings":{"executor":"backup"}}"#,
        )
        .unwrap();
        let mut config = default_model_config();
        config.model = "first-model".to_string();
        persist_model_config(&path, &config).unwrap();
        config.model = "second-model".to_string();
        persist_model_config(&path, &config).unwrap();

        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["model"], "second-model");
        assert_eq!(saved["models"][0]["modelId"], "backup");
        assert_eq!(saved["roleBindings"]["executor"], "backup");
        assert!(saved.get("verifier").is_none());
    }

    #[test]
    fn model_config_save_preserves_provider_model_catalogs() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("model-config.json");
        fs::write(
            &path,
            r#"{"schemaVersion":"1.0","provider":"deepseek","protocol":"deepseek-harness","model":"deepseek-chat","baseURL":"https://api.deepseek.com","apiKeyEnv":"DEEPSEEK_API_KEY","headers":{"X-Tenant":"a"},"sessionHeader":"x-session","models":[{"modelId":"keep-me"}],"roleBindings":{"executor":"keep-me"},"providerModelCatalogs":[{"providerKey":"opencode-go","models":[{"id":"old","displayName":"Old"}]}]}"#,
        )
        .unwrap();
        let mut config = default_model_config();
        config.model = "changed-model".to_string();
        persist_model_config(&path, &config).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["model"], "changed-model");
        assert_eq!(saved["providerModelCatalogs"][0]["providerKey"], "opencode-go");
        assert_eq!(saved["providerModelCatalogs"][0]["models"][0]["displayName"], "Old");
        assert_eq!(saved["models"][0]["modelId"], "keep-me");
        assert_eq!(saved["roleBindings"]["executor"], "keep-me");
        assert_eq!(saved["headers"]["X-Tenant"], "a");
        assert_eq!(redact_catalog_message("Bearer sk-secret"), "获取可用模型失败。");
        assert_eq!(
            redact_catalog_message("获取可用模型失败（HTTP 404）。"),
            "获取可用模型失败（HTTP 404）。"
        );
    }

    #[test]
    fn model_config_save_round_trips_verifier_section() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("model-config.json");
        let mut config = default_model_config();
        config.verifier = Some(serde_json::json!({
            "criteria": ["只输出结论", "禁止编造路径"],
            "repetitions": 4,
            "maxComparisons": 16,
            "pivots": 2,
            "maxPromptChars": 60000,
            "seed": 2026,
            "passThreshold": 0.9,
            "failThreshold": 0.5
        }));
        persist_model_config(&path, &config).unwrap();

        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["verifier"]["repetitions"], 4);
        assert_eq!(saved["verifier"]["criteria"].as_array().unwrap().len(), 2);
        assert_eq!(saved["verifier"]["passThreshold"], 0.9);

        // 写回时也要能原样读回，并在清空后从文件中删除。
        let reloaded: ModelConfig = serde_json::from_value(saved.clone()).unwrap();
        assert!(reloaded.verifier.is_some());
        config.verifier = None;
        persist_model_config(&path, &config).unwrap();
        let cleared: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(cleared.get("verifier").is_none());
        assert_eq!(cleared["model"], config.model);
    }

    #[test]
    fn model_config_custom_instructions_round_trip_and_clear() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("model-config.json");
        fs::write(&path, r#"{"models":[{"modelId":"backup"}],"roleBindings":{"executor":"backup"}}"#).unwrap();
        let mut config = default_model_config();
        config.custom_instructions = Some("  每次回复都使用中文。\n\t先给结论。  ".to_string());
        let config = validate_model_config(config).unwrap();
        persist_model_config(&path, &config).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["customInstructions"], "每次回复都使用中文。\n\t先给结论。");
        assert_eq!(saved["roleBindings"]["executor"], "backup");
        let mut reloaded: ModelConfig = serde_json::from_value(saved).unwrap();
        assert_eq!(reloaded.custom_instructions, config.custom_instructions);
        reloaded.custom_instructions = Some("  \n".to_string());
        let cleared = validate_model_config(reloaded).unwrap();
        persist_model_config(&path, &cleared).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(saved.get("customInstructions").is_none());
        assert_eq!(saved["models"][0]["modelId"], "backup");
        let mut config = default_model_config();
        config.custom_instructions = Some("中".repeat(8000));
        assert!(validate_model_config(config.clone()).is_ok());
        config.custom_instructions = Some("😀".repeat(4001));
        assert!(validate_model_config(config.clone()).is_err());
        config.custom_instructions = Some("a\0b".to_string());
        assert!(validate_model_config(config).is_err());
    }

    #[test]
    fn model_config_rejects_embedded_credentials_and_invalid_env_names() {
        let mut config = default_model_config();
        config.base_url = Some("https://secret@example.com/v1".to_string());
        assert!(validate_model_config(config).is_err());

        let mut config = default_model_config();
        config.api_key_env = "actual-key-value".to_string();
        assert!(validate_model_config(config).is_err());
    }

    #[test]
    fn rejects_ungranted_workspace() {
        let error = list_workspace_impl(None, "").unwrap_err();
        assert!(error.contains("尚未授权"));
    }

    #[test]
    fn rejects_absolute_and_parent_paths() {
        let directory = tempdir().unwrap();
        assert!(resolve_within(directory.path(), "../outside").is_err());
        assert!(resolve_within(directory.path(), "./inside").is_err());
        assert!(resolve_within(
            directory.path(),
            directory.path().to_string_lossy().as_ref()
        )
        .is_err());
    }

    #[test]
    fn lists_directories_before_files() {
        let directory = tempdir().unwrap();
        fs::create_dir(directory.path().join("z-dir")).unwrap();
        fs::write(directory.path().join("a-file.txt"), b"hello").unwrap();
        let root = directory.path().canonicalize().unwrap();

        let entries = list_workspace_impl(Some(&root), "").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "z-dir");
        assert_eq!(entries[1].name, "a-file.txt");
    }

    #[test]
    fn truncates_preview_and_hashes_returned_bytes() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("sample.txt"), b"abcdef").unwrap();
        let root = directory.path().canonicalize().unwrap();

        let file = read_workspace_file_impl(Some(&root), "sample.txt", Some(3)).unwrap();
        assert_eq!(file.content, "abc");
        assert_eq!(file.total_bytes, 6);
        assert!(file.truncated);
        assert_eq!(
            file.content_digest,
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn suppresses_binary_content() {
        let directory = tempdir().unwrap();
        let mut file = File::create(directory.path().join("image.bin")).unwrap();
        file.write_all(&[0, 159, 146, 150]).unwrap();
        let root = directory.path().canonicalize().unwrap();

        let result = read_workspace_file_impl(Some(&root), "image.bin", None).unwrap();
        assert!(result.binary);
        assert!(result.content.is_empty());
    }

    #[test]
    fn rejects_links_that_resolve_outside_the_workspace() {
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, b"outside").unwrap();
        let link = workspace.path().join("linked.txt");

        if create_file_symlink(&outside_file, &link).is_err() {
            // Windows may require Developer Mode or elevated symlink privileges.
            return;
        }
        let root = workspace.path().canonicalize().unwrap();
        let error = resolve_within(&root, "linked.txt").unwrap_err();
        assert!(error.contains("超出"));
    }

    #[test]
    fn parses_runtime_health_route_without_credentials() {
        let health = parse_runtime_health_line(
            r#"{"ok":true,"runtime":{"node":"v22.1.0","platform":"win32"},"config":{"path":"C:\\Users\\tester\\AppData\\Local\\hmCodex\\model-config.json","loaded":true},"model":{"provider":"openai","protocol":"responses","model":"gpt-4.1-mini"}}"#,
        )
        .unwrap();
        assert!(health.ok);
        assert_eq!(health.runtime.unwrap().node.as_deref(), Some("v22.1.0"));
        assert!(health.config.unwrap().loaded);
        assert_eq!(health.model.unwrap().provider, "openai");
        assert!(health.error.is_none());
    }

    #[test]
    fn reports_idle_runtime_process_status() {
        let state = AppState::default();
        let status = runtime_process_status_impl(&state).unwrap();
        assert!(!status.running);
        assert_eq!(status.pid, None);
        assert_eq!(status.started_at_ms, None);
        assert_eq!(status.last_heartbeat_at_ms, None);
        assert!(!status.healthy);
    }

    #[test]
    fn detects_a_stale_runtime_heartbeat_with_a_bounded_timeout() {
        assert!(!runtime_heartbeat_is_stale(Some(10_000), 39_999));
        assert!(runtime_heartbeat_is_stale(Some(10_000), 40_001));
        assert!(runtime_heartbeat_is_stale(None, 1));
    }

    #[test]
    fn process_heartbeat_line_is_the_side_channel_marker_only() {
        assert!(process_heartbeat_line(
            "{\"type\":\"runtime_heartbeat\",\"emittedAtMs\":1}\n"
        ));
        assert!(!process_heartbeat_line(
            "{\"type\":\"runtime_event\",\"kind\":\"runtime.heartbeat\"}\n"
        ));
        assert!(!process_heartbeat_line("workspace-failure\n"));
        let padded = format!(
            "{{\"type\":\"runtime_heartbeat\",\"pad\":\"{}\"}}\n",
            "x".repeat(300)
        );
        assert!(!process_heartbeat_line(&padded));
    }

    #[test]
    fn live_process_heartbeat_tolerates_a_blocked_event_loop_until_the_stall_ceiling() {
        let now = Instant::now();
        let started = now.checked_sub(Duration::from_secs(10)).unwrap();
        let recent_process = now.checked_sub(Duration::from_secs(1)).unwrap();
        let blocked_stdout = now.checked_sub(Duration::from_secs(40)).unwrap();
        assert!(!runtime_liveness_is_stale(
            true,
            Some(started),
            Some(blocked_stdout),
            true,
            Some(recent_process),
            now,
        ));
        let stalled_stdout = now
            .checked_sub(Duration::from_millis(RUNTIME_EVENT_LOOP_STALL_MS + 1))
            .unwrap();
        assert!(runtime_liveness_is_stale(
            true,
            Some(started),
            Some(stalled_stdout),
            true,
            Some(recent_process),
            now,
        ));
        let dead_process = now
            .checked_sub(Duration::from_millis(RUNTIME_HEARTBEAT_TIMEOUT_MS + 1))
            .unwrap();
        assert!(runtime_liveness_is_stale(
            true,
            Some(started),
            Some(now),
            true,
            Some(dead_process),
            now,
        ));
        assert!(runtime_liveness_is_stale(
            true,
            Some(started),
            Some(dead_process),
            false,
            None,
            now,
        ));
    }

    #[test]
    fn watchdog_preserves_live_run_heartbeat_timeout() {
        assert!(!runtime_watchdog_should_stop(false, None));
        assert!(runtime_watchdog_should_stop(true, None));
    }

    #[test]
    fn watchdog_keeps_heartbeating_terminal_process_alive_after_grace() {
        for elapsed in [0, RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS, RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS + 1, u64::MAX] {
            assert!(!runtime_watchdog_should_stop(false, Some(elapsed)));
        }
    }

    #[test]
    fn watchdog_stops_stale_terminal_process_only_after_grace() {
        for elapsed in [0, RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS - 1, RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS] {
            assert!(!runtime_watchdog_should_stop(true, Some(elapsed)));
        }
        assert!(runtime_watchdog_should_stop(true, Some(RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS + 1)));
    }

    #[test]
    fn watchdog_requires_current_staleness_after_terminal_grace() {
        let now_ms = RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS + RUNTIME_HEARTBEAT_TIMEOUT_MS + 1;
        let terminal_for_ms = Some(now_ms);
        assert!(runtime_watchdog_should_stop(runtime_heartbeat_is_stale(Some(0), now_ms), terminal_for_ms));
        assert!(!runtime_watchdog_should_stop(runtime_heartbeat_is_stale(Some(now_ms), now_ms), terminal_for_ms));
        let last_heartbeat = Some(now_ms - RUNTIME_HEARTBEAT_TIMEOUT_MS);
        assert!(!runtime_watchdog_should_stop(runtime_heartbeat_is_stale(last_heartbeat, now_ms), terminal_for_ms));
        assert!(runtime_watchdog_should_stop(runtime_heartbeat_is_stale(last_heartbeat, now_ms + 1), terminal_for_ms));
    }

    #[test]
    fn watchdog_monotonic_staleness_ignores_wall_clock_jumps() {
        let state = AppState::default();
        let session = reserve_runtime_launch(&state, Some("clock-jump")).unwrap();
        let base = Instant::now();
        {
            let mut slots = state.runtime_slots.lock().unwrap();
            let slot = slots.get_mut(&session).unwrap();
            slot.pid = Some(16244);
            // Simulate VMAgent jumping unix_time_ms forward by 6+ minutes while
            // monotonic Instant only advanced by 2 seconds since last heartbeat.
            slot.started_at_ms = Some(1_000);
            slot.last_heartbeat_at_ms = Some(1_000);
            slot.started_at = Some(base);
            slot.last_heartbeat_at = Some(base);
            slot.heartbeat_seen = true;
        }
        assert!(!runtime_slot_is_stale(
            true,
            Some(base),
            Some(base),
            base + Duration::from_secs(2),
        ));
        let status = runtime_process_status_impl(&state).unwrap();
        assert!(status.running);
        assert!(status.healthy);
    }

    #[test]
    fn watchdog_extends_parallel_slots_after_host_or_vm_suspend_and_still_times_out_if_hung() {
        assert!(!runtime_watchdog_poll_was_suspended(RUNTIME_WATCHDOG_POLL_MS));
        assert!(!runtime_watchdog_poll_was_suspended(RUNTIME_WATCHDOG_SUSPEND_GAP_MS));
        assert!(runtime_watchdog_poll_was_suspended(RUNTIME_WATCHDOG_SUSPEND_GAP_MS + 1));

        let state = AppState::default();
        let s1 = reserve_runtime_launch(&state, Some("waiting-approval")).unwrap();
        let s2 = reserve_runtime_launch(&state, Some("starting-up")).unwrap();
        let base = Instant::now();
        let pre_suspend_startup = Duration::from_secs(10);
        {
            let mut slots = state.runtime_slots.lock().unwrap();
            let slot1 = slots.get_mut(&s1).unwrap();
            slot1.pid = Some(101);
            slot1.started_at = Some(base);
            slot1.last_heartbeat_at = Some(base + Duration::from_secs(2));
            slot1.started_at_ms = Some(100_000);
            slot1.last_heartbeat_at_ms = Some(102_000);
            slot1.heartbeat_seen = true;

            let slot2 = slots.get_mut(&s2).unwrap();
            slot2.pid = Some(102);
            slot2.started_at = Some(base);
            slot2.last_heartbeat_at = Some(base);
            slot2.started_at_ms = Some(100_000);
            slot2.last_heartbeat_at_ms = Some(100_000);
            slot2.heartbeat_seen = false;
        }

        // Host/VM pauses for 382,387 ms (~6m22s), matching the VMAgent suspend scenario.
        let poll_gap_ms = 382_387;
        assert!(runtime_watchdog_poll_was_suspended(poll_gap_ms));
        let suspended = Duration::from_millis(poll_gap_ms - RUNTIME_WATCHDOG_POLL_MS);
        let resume_at = base + pre_suspend_startup + Duration::from_millis(poll_gap_ms);
        let mut terminal_seen = Some(base + Duration::from_secs(5));

        assert!(extend_runtime_slot_after_suspend(
            &state,
            &s1,
            101,
            resume_at,
            482_387,
            suspended,
            &mut terminal_seen,
        ));
        assert!(extend_runtime_slot_after_suspend(
            &state,
            &s2,
            102,
            resume_at,
            482_387,
            suspended,
            &mut None,
        ));

        let slots = state.runtime_slots.lock().unwrap();
        let slot1 = slots.get(&s1).unwrap();
        assert_eq!(slot1.last_heartbeat_at_ms, Some(482_387));
        assert!(!runtime_slot_is_stale(
            slot1.heartbeat_seen,
            slot1.started_at,
            slot1.last_heartbeat_at,
            resume_at,
        ));
        // If the child genuinely stops heartbeating after resume, it still expires after 30s.
        assert!(!runtime_slot_is_stale(
            slot1.heartbeat_seen,
            slot1.started_at,
            slot1.last_heartbeat_at,
            resume_at + Duration::from_millis(RUNTIME_HEARTBEAT_TIMEOUT_MS),
        ));
        assert!(runtime_slot_is_stale(
            slot1.heartbeat_seen,
            slot1.started_at,
            slot1.last_heartbeat_at,
            resume_at + Duration::from_millis(RUNTIME_HEARTBEAT_TIMEOUT_MS + 1),
        ));

        // Startup grace preserves the 10s spent before suspend without counting the 382s pause.
        let slot2 = slots.get(&s2).unwrap();
        assert!(!runtime_slot_is_stale(
            slot2.heartbeat_seen,
            slot2.started_at,
            slot2.last_heartbeat_at,
            resume_at,
        ));
        let remaining_startup_ms = RUNTIME_STARTUP_GRACE_MS - duration_ms(pre_suspend_startup) - RUNTIME_WATCHDOG_POLL_MS;
        assert!(!runtime_slot_is_stale(
            slot2.heartbeat_seen,
            slot2.started_at,
            slot2.last_heartbeat_at,
            resume_at + Duration::from_millis(remaining_startup_ms),
        ));
        assert!(runtime_slot_is_stale(
            slot2.heartbeat_seen,
            slot2.started_at,
            slot2.last_heartbeat_at,
            resume_at + Duration::from_millis(remaining_startup_ms + 1),
        ));

        // Terminal shutdown grace also excludes the suspended interval.
        let terminal_for_ms = duration_ms(resume_at.saturating_duration_since(terminal_seen.unwrap()));
        assert!(terminal_for_ms < RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS);
    }

    #[test]
    fn extracts_last_runtime_phase_for_watchdog_diagnostics() {
        let stdout = r#"{"type":"runtime_event","kind":"run.started","payload":{}}
{"type":"runtime_event","kind":"runtime.phase","payload":{"phase":"LEGACY_MIGRATION_CHECK"}}
"#;
        assert_eq!(runtime_last_phase(stdout).as_deref(), Some("LEGACY_MIGRATION_CHECK"));
    }

    #[test]
    fn a_running_task_does_not_need_a_command_lock_to_admit_a_side_process() {
        let state = AppState::default();
        assert!(!task_slot_active(&state));
        reserve_runtime_launch(&state, Some("session")).unwrap();
        assert!(task_slot_active(&state));
        assert_eq!(
            side_process_admission(true, &["memory", "--operation", "list"]),
            SideProcessAdmission::AskJev
        );
    }

    #[test]
    fn forwards_runtime_events_only_for_active_processes() {
        let state = AppState::default();
        let s1 = reserve_runtime_launch(&state, Some("s1")).unwrap();
        let s2 = reserve_runtime_launch(&state, Some("s2")).unwrap();
        state.runtime_slots.lock().unwrap().get_mut(&s1).unwrap().pid = Some(41);
        state.runtime_slots.lock().unwrap().get_mut(&s2).unwrap().pid = Some(42);
        assert!(runtime_process_is_active(&state, 41));
        assert!(runtime_process_is_active(&state, 42));
        assert!(!runtime_process_is_active(&state, 99));

        state.runtime_slots.lock().unwrap().remove(&s1);
        assert!(!runtime_process_is_active(&state, 41));
        assert!(runtime_process_is_active(&state, 42));
    }

    #[test]
    fn cancellation_targets_individual_parallel_slots_without_disturbing_siblings() {
        let state = AppState::default();
        let s1 = reserve_runtime_launch(&state, Some("session-a")).unwrap();
        let s2 = reserve_runtime_launch(&state, Some("session-b")).unwrap();
        assert_eq!(state.runtime_slots.lock().unwrap().len(), 2);

        let result = cancel_runtime_slot(&state, Some(&s1), None).unwrap();
        assert!(result.cancelled);
        assert!(slot_cancel_requested(&state, &s1).unwrap());
        assert!(!slot_cancel_requested(&state, &s2).unwrap());

        clear_runtime_launch_reservation(&state, &s1);
        assert!(!state.runtime_slots.lock().unwrap().contains_key(&s1));
        assert!(state.runtime_slots.lock().unwrap().contains_key(&s2));
    }

    #[test]
    fn cancelling_without_an_active_runtime_is_a_noop() {
        let state = AppState::default();
        let result = cancel_runtime_slot(&state, None, None).unwrap();
        assert!(!result.cancelled);
    }

    #[test]
    fn desktop_spawn_env_owns_platform_cells_and_resident_separately() {
        let root = PathBuf::from(r"C:\Users\tester\AppData\Local");
        let off = plan_desktop_spawn_env(false, DesktopSpawnMode::PerInvoke, Some(&root));
        assert!(off.set.iter().any(|(key, value)| key == "DDA_PLATFORM" && value == "windows-desktop"));
        assert!(off.remove.iter().any(|key| key == "DDA_KERNEL_SANDBOX"));
        for key in CELLS_ENV_KEYS {
            assert!(off.remove.iter().any(|item| item == key), "{key} removed when toggle is off");
            assert!(off.set.iter().all(|(name, _)| name != key));
        }
        assert!(off.set.iter().all(|(key, _)| key != "DDA_RESIDENT_KERNEL"));
        assert!(off.remove.iter().all(|key| key != "DDA_PLATFORM"));
        assert!(off.remove.iter().all(|key| key != "DDA_RESIDENT_KERNEL"));
        let journal = off.set.iter().find(|(key, _)| key == "DDA_KERNEL_EFFECT_JOURNAL").unwrap();
        let session = off.set.iter().find(|(key, _)| key == "DDA_KERNEL_SESSION_STORE").unwrap();
        assert!(journal.1.replace('/', "\\").ends_with(r"hmCodex\journal\windows-desktop\kernel-effect-journal.json"));
        assert!(session.1.replace('/', "\\").ends_with(r"hmCodex\journal\windows-desktop\kernel-session.json"));
        assert!(!journal.1.replace('/', "\\").ends_with(r"hmCodex\kernel-effect-journal.json"));

        let per_invoke_on = plan_desktop_spawn_env(true, DesktopSpawnMode::PerInvoke, Some(&root));
        for key in CELLS_ENV_KEYS {
            assert!(per_invoke_on.set.iter().all(|(name, _)| name != key));
            assert!(per_invoke_on.remove.iter().all(|name| name != key));
        }
        assert!(per_invoke_on.set.iter().all(|(key, _)| key != "DDA_RESIDENT_KERNEL"));
        assert!(per_invoke_on.remove.iter().all(|key| key != "DDA_PLATFORM"));

        let session_keep = plan_desktop_spawn_env(true, DesktopSpawnMode::SessionKeep, Some(&root));
        for key in CELLS_ENV_KEYS {
            assert!(session_keep.set.iter().any(|(name, value)| name == key && value == "1"));
            assert!(session_keep.remove.iter().all(|name| name != key));
        }
        assert!(session_keep.set.iter().any(|(key, value)| key == "DDA_RESIDENT_KERNEL" && value == "1"));
        assert!(session_keep.remove.iter().any(|key| key == "DDA_KERNEL_SANDBOX"));
        assert!(session_keep.remove.iter().all(|key| key != "DDA_PLATFORM"));

        let session_keep_off = plan_desktop_spawn_env(false, DesktopSpawnMode::SessionKeep, None);
        assert!(session_keep_off.set.iter().any(|(key, value)| key == "DDA_RESIDENT_KERNEL" && value == "1"));
        for key in CELLS_ENV_KEYS {
            assert!(session_keep_off.remove.iter().any(|name| name == key));
        }
        assert!(session_keep_off.set.iter().all(|(key, _)| key != "DDA_KERNEL_EFFECT_JOURNAL"));
        assert_eq!(TASK_RUNTIME_SPAWN_MODE, DesktopSpawnMode::SessionKeep);
    }

    #[test]
    fn task_runtime_spawn_is_session_keep_and_queries_stay_per_invoke() {
        let task = runtime_command_for(
            Path::new("index.mjs"),
            None,
            TASK_RUNTIME_SPAWN_MODE,
        );
        let health = runtime_command(Path::new("index.mjs"), None);
        let resident = |command: &Command, key: &str| {
            command.get_envs().find(|(name, _)| *name == key).map(|(_, value)| {
                value.map(|item| item.to_string_lossy().into_owned())
            })
        };
        assert_eq!(
            resident(&task, "DDA_RESIDENT_KERNEL"),
            Some(Some("1".to_string()))
        );
        assert_eq!(resident(&task, "DDA_PLATFORM"), Some(Some("windows-desktop".to_string())));
        assert_eq!(resident(&task, "DDA_KERNEL_SANDBOX"), Some(None));
        assert_eq!(resident(&health, "DDA_RESIDENT_KERNEL"), None);
        assert_eq!(
            resident(&health, "DDA_PLATFORM"),
            Some(Some("windows-desktop".to_string()))
        );
        assert_eq!(runtime_creation_flags(TASK_RUNTIME_SPAWN_MODE), runtime_creation_flags(DesktopSpawnMode::SessionKeep));
        let host = resident(&task, "DDA_HOST_EXECUTABLE");
        assert!(host.as_ref().is_some_and(|value| value.as_ref().is_some_and(|path| !path.is_empty())));
    }

    #[test]
    fn runtime_commands_enable_environment_proxy_only_on_node_24_or_newer() {
        for (version, expected) in [
            (Some("v20.19.0"), false),
            (Some("v22.23.4"), false),
            (Some("v23.11.0"), false),
            (Some("v24.0.0\r\n"), true),
            (Some("v25.0.0"), true),
            (Some("invalid"), false),
            (Some(""), false),
            (None, false),
        ] {
            let mut command = Command::new("node");
            add_runtime_env_proxy_arg(&mut command, version);
            command.arg("index.mjs");
            let args: Vec<_> = command.get_args().collect();
            let expected_args = if expected {
                vec!["--use-env-proxy", "index.mjs"]
            } else {
                vec!["index.mjs"]
            };
            assert_eq!(args, expected_args, "Node version: {version:?}");
        }
    }

    #[test]
    fn desktop_settings_default_off_and_round_trip_without_touching_model_config() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("hmCodex").join("desktop-settings.json");
        let missing = load_desktop_settings_from(&path).unwrap();
        assert!(!missing.experimental_code_cells);
        persist_desktop_settings_at(&path, &DesktopSettings { experimental_code_cells: true }).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["experimentalCodeCells"], true);
        assert!(saved.get("model").is_none());
        assert_ne!(path.file_name().unwrap(), "model-config.json");
        persist_desktop_settings_at(&path, &DesktopSettings { experimental_code_cells: false }).unwrap();
        assert!(!load_desktop_settings_from(&path).unwrap().experimental_code_cells);
    }

    #[test]
    fn bundled_node_exe_is_used_unless_dda_node_is_set() {
        let directory = tempdir().unwrap();
        let bundled = directory.path().join("node").join("node.exe");
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"node").unwrap();
        assert_eq!(
            resolve_node_program(None, Some(directory.path())),
            bundled.as_os_str()
        );
        assert_eq!(
            resolve_node_program(Some(std::ffi::OsStr::new("custom-node")), Some(directory.path())),
            std::ffi::OsString::from("custom-node")
        );
        assert_eq!(
            resolve_node_program(None, None),
            std::ffi::OsString::from("node")
        );
    }

    #[test]
    fn job_object_reap_falls_back_when_assignment_fails() {
        assert_eq!(CREATE_BREAKAWAY_FROM_JOB, 0x0100_0000);
        assert!(!try_assign_kill_on_job_close(0, DesktopSpawnMode::PerInvoke));
        assert!(!try_assign_kill_on_job_close(0, DesktopSpawnMode::SessionKeep));
        assert_eq!(process_reap_plan(false), ProcessReapPlan::TaskkillTree);
        assert_eq!(process_reap_plan(true), ProcessReapPlan::JobKillOnClose);
        #[cfg(windows)]
        {
            assert_eq!(runtime_creation_flags(DesktopSpawnMode::PerInvoke), CREATE_NO_WINDOW);
            assert_eq!(
                runtime_creation_flags(DesktopSpawnMode::SessionKeep),
                CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB
            );
        }
        #[cfg(not(windows))]
        {
            assert_eq!(runtime_creation_flags(DesktopSpawnMode::PerInvoke), 0);
            assert_eq!(runtime_creation_flags(DesktopSpawnMode::SessionKeep), 0);
        }
    }

    #[test]
    fn health_payload_keeps_cells_availability_optional() {
        let bare = parse_runtime_health_line(
            r#"{"ok":true,"runtime":{"node":"v24.0.0"},"config":{"loaded":true},"model":{"provider":"openai","protocol":"responses","model":"gpt"}}"#,
        )
        .unwrap();
        assert!(bare.cells_availability.is_none());
        let with_cells = parse_runtime_health_line(
            r#"{"ok":true,"runtime":{"node":"v22.0.0"},"cellsAvailability":{"available":false,"reason":"NODE_TOO_OLD","source":"fresh-health","sandboxAvailable":false}}"#,
        )
        .unwrap();
        let cells = with_cells.cells_availability.unwrap();
        assert!(!cells.available);
        assert_eq!(cells.reason.as_deref(), Some("NODE_TOO_OLD"));
        assert_eq!(cells.source.as_deref(), Some("fresh-health"));
        assert_eq!(cells.sandbox_available, Some(false));
    }

    #[cfg(windows)]
    fn create_file_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(source, link)
    }

    #[cfg(unix)]
    fn create_file_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(source, link)
    }
}

#[cfg(test)]
mod webview_failure_capture_tests {
    use super::*;

    #[test]
    fn captures_only_the_wry_webview_creation_error() {
        let message = "failed to create webview: WebView2 error: WindowsError(Error { code: HRESULT(0x800700AA) })";
        assert_eq!(
            captured_webview_create_failure(log::Level::Error, "tauri_runtime_wry", message),
            Some(message.to_string())
        );
    }

    #[test]
    fn ignores_warnings_other_targets_and_unrelated_errors() {
        let message = "failed to create webview: WebView2 error";
        assert_eq!(captured_webview_create_failure(log::Level::Warn, "tauri_runtime_wry", message), None);
        assert_eq!(captured_webview_create_failure(log::Level::Error, "dda_desktop_lib", message), None);
        assert_eq!(
            captured_webview_create_failure(log::Level::Error, "tauri_runtime_wry", "window closed"),
            None
        );
    }
}

#[cfg(test)]
mod slot_selector_tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn slot(session_id: &str, order: u64) -> RuntimeTaskSlot {
        RuntimeTaskSlot {
            session_id: session_id.to_string(),
            pid: None,
            run_id: None,
            approval_request_ids: HashSet::new(),
            clarification_request_ids: HashSet::new(),
            stdin: None,
            started_at_ms: None,
            last_heartbeat_at_ms: None,
            started_at: None,
            last_heartbeat_at: None,
            heartbeat_seen: false,
            last_process_heartbeat_at_ms: None,
            last_process_heartbeat_at: None,
            process_heartbeat_seen: false,
            launching: false,
            cancel_requested: false,
            job_handle: None,
            order,
            workspace_root: None,
            worktree: None,
        }
    }

    fn slots_with(entries: Vec<RuntimeTaskSlot>) -> HashMap<String, RuntimeTaskSlot> {
        entries
            .into_iter()
            .map(|slot| (slot.session_id.clone(), slot))
            .collect()
    }

    #[test]
    fn approval_resolves_to_the_recorded_owner_session() {
        let mut a = slot("session-a", 1);
        a.approval_request_ids.insert("req-1".to_string());
        let b = slot("session-b", 2);
        let slots = slots_with(vec![a, b]);
        let key = select_approval_slot(&slots, "req-1", Some("session-a"), None, |_| true).unwrap();
        assert_eq!(key, "session-a");
    }

    #[test]
    fn approval_fails_when_request_does_not_belong_to_explicit_session() {
        let mut a = slot("session-a", 1);
        a.approval_request_ids.insert("req-1".to_string());
        let mut b = slot("session-b", 2);
        b.approval_request_ids.insert("req-2".to_string());
        let slots = slots_with(vec![a, b]);
        // Explicit session exists and is live, but the request is owned by the sibling.
        let result = select_approval_slot(&slots, "req-1", Some("session-b"), None, |_| true);
        assert!(result.is_err());
    }

    #[test]
    fn approval_fails_for_a_vanished_explicit_session() {
        let mut a = slot("session-a", 1);
        a.approval_request_ids.insert("req-1".to_string());
        let slots = slots_with(vec![a]);
        let result = select_approval_slot(&slots, "req-1", Some("session-gone"), None, |_| true);
        assert!(result.is_err());
    }

    #[test]
    fn targetless_approval_requires_a_unique_recorded_owner() {
        let mut a = slot("session-a", 1);
        a.approval_request_ids.insert("req-1".to_string());
        let mut b = slot("session-b", 2);
        b.approval_request_ids.insert("req-1".to_string());
        let slots = slots_with(vec![a, b]);
        assert!(select_approval_slot(&slots, "req-1", None, None, |_| true).is_err());
        // A unique owner still resolves without an explicit target.
        let mut sole = slot("session-a", 1);
        sole.approval_request_ids.insert("req-1".to_string());
        let owned = slots_with(vec![sole]);
        assert_eq!(select_approval_slot(&owned, "req-1", None, None, |_| true).unwrap(), "session-a");
        assert!(select_approval_slot(&slots, "req-missing", None, None, |_| true).is_err());
    }

    #[test]
    fn explicit_cancel_never_falls_back_to_a_sibling() {
        let slots = slots_with(vec![slot("session-a", 1), slot("session-b", 2)]);
        assert_eq!(select_cancel_slot(&slots, Some("session-a"), None).as_deref(), Some("session-a"));
        assert_eq!(select_cancel_slot(&slots, Some("session-gone"), None), None);
        // run_id must match the same slot as session_id.
        let mut with_run = slot("session-b", 2);
        with_run.run_id = Some("run-b".to_string());
        let slots = slots_with(vec![slot("session-a", 1), with_run]);
        assert_eq!(select_cancel_slot(&slots, Some("session-b"), Some("run-other")), None);
        assert_eq!(select_cancel_slot(&slots, Some("session-b"), Some("run-b")).as_deref(), Some("session-b"));
    }

    #[test]
    fn clarification_does_not_answer_another_tasks_question() {
        let mut a = slot("session-a", 1);
        a.clarification_request_ids.insert("clarify-1".to_string());
        let mut b = slot("session-b", 2);
        b.approval_request_ids.insert("clarify-1".to_string());
        let slots = slots_with(vec![a, b]);
        assert_eq!(
            select_clarification_slot(&slots, "clarify-1", Some("session-a"), None, |_| true).unwrap(),
            "session-a"
        );
        assert!(select_clarification_slot(&slots, "clarify-1", Some("session-b"), None, |_| true).is_err());
        assert_eq!(valid_clarification_answer("按 API 调用"), true);
        assert_eq!(valid_clarification_answer(""), false);
        assert_eq!(valid_clarification_answer(&"字".repeat(4001)), false);
    }

    #[test]
    fn targetless_cancel_picks_the_most_recent_slot() {
        let slots = slots_with(vec![slot("session-a", 1), slot("session-b", 2)]);
        assert_eq!(select_cancel_slot(&slots, None, None).as_deref(), Some("session-b"));
    }

    #[test]
    fn cancel_before_spawn_marks_only_the_target_slot() {
        let state = AppState::default();
        let s1 = reserve_runtime_launch(&state, Some("session-a")).unwrap();
        let s2 = reserve_runtime_launch(&state, Some("session-b")).unwrap();
        let result = cancel_runtime_slot(&state, Some(&s1), None).unwrap();
        assert!(result.cancelled);
        assert!(slot_cancel_requested(&state, &s1).unwrap());
        assert!(!slot_cancel_requested(&state, &s2).unwrap());
        // The sibling reservation stays intact for its own launch.
        assert!(state.runtime_slots.lock().unwrap().contains_key(&s2));
    }
}
