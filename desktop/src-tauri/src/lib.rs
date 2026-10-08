use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};

/// Windows GUI 程序派生控制台子进程时必须隐藏新控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

mod dream_maintenance;
use dream_maintenance::{
    start as start_dream_maintenance_impl, status as dream_maintenance_status_impl,
    stop as stop_dream_maintenance_impl, DreamMaintenanceState, DreamMaintenanceStatus,
};

const DEFAULT_PREVIEW_BYTES: u64 = 256 * 1024;
const MAX_PREVIEW_BYTES: u64 = 256 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 200;
const RUNTIME_HEARTBEAT_TIMEOUT_MS: u64 = 30_000;
// A terminal state is emitted before the runtime flushes durable stores and
// disposes provider fibers. Keep a bounded grace period for that final
// shutdown so slow workspace/database writes are not reported as a live-run
// heartbeat failure.
const RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS: u64 = 120_000;
const RUNTIME_STARTUP_GRACE_MS: u64 = 120_000;
const RUNTIME_WATCHDOG_POLL_MS: u64 = 250;

#[derive(Clone, Default)]
struct AppState {
    workspace_root: Arc<Mutex<Option<PathBuf>>>,
    active_runtime_pid: Arc<Mutex<Option<u32>>>,
    active_runtime_stdin: Arc<Mutex<Option<ChildStdin>>>,
    active_runtime_started_at_ms: Arc<Mutex<Option<u64>>>,
    active_runtime_last_heartbeat_at_ms: Arc<Mutex<Option<u64>>>,
    // A runtime can spend time in synchronous database validation before its
    // JavaScript heartbeat timer gets a chance to run. Keep startup grace
    // separate from the steady-state heartbeat timeout.
    active_runtime_heartbeat_seen: Arc<Mutex<bool>>,
    active_runtime_launching: Arc<Mutex<bool>>,
    active_runtime_cancel_requested: Arc<Mutex<bool>>,
    runtime_state_lock: Arc<Mutex<()>>,
    // Serialize short-lived runtime queries with the long-lived task child.
    // Both processes open the same Harness SQLite database; allowing them to
    // start concurrently can leave the task blocked before its first role event.
    runtime_command_lock: Arc<Mutex<()>>,
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
    model: Option<RuntimeModelSummary>,
    config_loaded: bool,
    context_sidecar: LocalContextStatus,
    dream_maintenance: DreamMaintenanceStatus,
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
}

impl Default for ModelConfig {
    fn default() -> Self {
        default_model_config()
    }
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeHealthResponse {
    ok: bool,
    runtime: Option<RuntimeHealthRuntime>,
    config: Option<RuntimeConfigSummary>,
    model: Option<RuntimeModelSummary>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RuntimeHealthRuntime {
    node: Option<String>,
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
    if let Ok(path) = std::env::var("HMCODEX_MODEL_CONFIG") {
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
    let line = format!("[{}] [ERROR] {}\n", iso_utc_from_ms(now_ms), message);
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
    let pid = state
        .active_runtime_pid
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?
        .to_owned();
    let started_at_ms = state
        .active_runtime_started_at_ms
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?
        .to_owned();
    let last_heartbeat_at_ms = state
        .active_runtime_last_heartbeat_at_ms
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?
        .to_owned();
    Ok(RuntimeProcessStatus {
        running: pid.is_some(),
        pid,
        started_at_ms,
        last_heartbeat_at_ms,
        healthy: pid.is_some() && !runtime_heartbeat_is_stale(last_heartbeat_at_ms, unix_time_ms()),
    })
}

fn runtime_heartbeat_is_stale(last_heartbeat_at_ms: Option<u64>, now_ms: u64) -> bool {
    last_heartbeat_at_ms.map_or(true, |heartbeat| {
        now_ms.saturating_sub(heartbeat) > RUNTIME_HEARTBEAT_TIMEOUT_MS
    })
}

/// Return whether stdout emitted by `pid` still belongs to the active runtime
/// invocation.  Cancellation clears the active PID before taskkill returns so
/// a late buffered line from the cancelled child cannot be forwarded to the
/// frontend (or accidentally become the next run's `run.started` binding).
fn runtime_process_is_active(state: &AppState, pid: u32) -> bool {
    let Ok(_state_guard) = state.runtime_state_lock.lock() else {
        return false;
    };
    state
        .active_runtime_pid
        .lock()
        .map(|active_pid| *active_pid == Some(pid))
        .unwrap_or(false)
}

fn handle_runtime_stdout_line(
    app: &AppHandle,
    state: &AppState,
    pid: u32,
    line: &str,
    stdout_text: &mut String,
) {
    stdout_text.push_str(line);
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("runtime_event")
        || !runtime_process_is_active(state, pid)
    {
        return;
    }
    // 任何 runtime 事件都证明进程存活；只认 heartbeat 会在事件流动的
    // 静默阶段（如 git 观测）误杀进程。
    if let Ok(mut heartbeat_at_ms) = state.active_runtime_last_heartbeat_at_ms.lock() {
        *heartbeat_at_ms = Some(unix_time_ms());
    }
    if value.get("kind").and_then(Value::as_str) == Some("runtime.heartbeat") {
        if let Ok(mut heartbeat_seen) = state.active_runtime_heartbeat_seen.lock() {
            *heartbeat_seen = true;
        }
    }
    let _ = app.emit("runtime-event", value);
}

/// Reserve the single runtime slot before the blocking worker is scheduled.
/// This lets an immediate Cancel request target a launch that has not spawned
/// its child process yet.
fn reserve_runtime_launch(state: &AppState) -> Result<(), String> {
    let _state_guard = state
        .runtime_state_lock
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let active_pid = state
        .active_runtime_pid
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let mut launching = state
        .active_runtime_launching
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    if active_pid.is_some() || *launching {
        return Err("已有 Cordis runtime 任务正在运行".to_string());
    }
    drop(active_pid);
    let mut cancel_requested = state
        .active_runtime_cancel_requested
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    *cancel_requested = false;
    drop(cancel_requested);
    *launching = true;
    Ok(())
}

fn clear_runtime_launch_reservation(state: &AppState) {
    if let Ok(mut launching) = state.active_runtime_launching.lock() {
        *launching = false;
    }
    if let Ok(mut cancel_requested) = state.active_runtime_cancel_requested.lock() {
        *cancel_requested = false;
    }
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
    let output = runtime_command(&runtime)
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
    let node_version = health.runtime.and_then(|runtime| runtime.node);
    let config_loaded = health.config.map(|config| config.loaded).unwrap_or(false);
    Ok(RuntimeSnapshot {
        release_channel,
        platform: "WINDOWS",
        version: env!("CARGO_PKG_VERSION"),
        read_only: true,
        workspace_read: true,
        command_execution: false,
        network_side_effects: false,
        runtime_ready: true,
        node_version,
        model: health.model,
        config_loaded,
        context_sidecar: local_context_status(),
        dream_maintenance: dream_maintenance_status_impl(&state.dream_maintenance),
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
fn list_workspace(
    app: AppHandle,
    state: State<'_, AppState>,
    relative_path: String,
) -> Result<Vec<WorkspaceEntry>, String> {
    let root = ensure_default_workspace(&app, state.inner())?;
    list_workspace_impl(Some(&root), &relative_path)
}

#[tauri::command]
fn read_workspace_file(
    app: AppHandle,
    state: State<'_, AppState>,
    relative_path: String,
    max_bytes: Option<u64>,
) -> Result<WorkspaceFile, String> {
    let root = ensure_default_workspace(&app, state.inner())?;
    read_workspace_file_impl(Some(&root), &relative_path, max_bytes)
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
fn runtime_timeline_page(app: AppHandle, cursor: u32, limit: u32) -> Result<Value, String> {
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
}

#[tauri::command]
fn get_thread(app: AppHandle, thread_id: String) -> Result<Value, String> {
    if thread_id.trim().is_empty() {
        return Err("threadId 不能为空".to_string());
    }
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
fn fork_thread(app: AppHandle, thread_id: String, title: Option<String>) -> Result<Value, String> {
    if thread_id.trim().is_empty() {
        return Err("threadId 不能为空".to_string());
    }
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
fn get_execution_state(app: AppHandle, record_id: String) -> Result<Value, String> {
    if record_id.trim().is_empty() {
        return Err("recordId 不能为空".to_string());
    }
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
}

#[tauri::command]
fn reconcile_execution_state(app: AppHandle) -> Result<Value, String> {
    let _ = 1;
    // Governance adapters are hosted by the runtime process.
    run_runtime_json(&app, &["execution-state", "--operation", "reconcile"])
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
fn cancel_execution_approval(
    app: AppHandle,
    record_id: String,
    expected_digest: Option<String>,
) -> Result<Value, String> {
    mutate_execution_record(&app, "cancel-approval", record_id, expected_digest, "USER_RECOVERY_CANCELLED")
}

#[tauri::command]
fn revoke_execution_lease(
    app: AppHandle,
    record_id: String,
    expected_digest: Option<String>,
) -> Result<Value, String> {
    mutate_execution_record(&app, "revoke-lease", record_id, expected_digest, "USER_RECOVERY_REVOKED")
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
fn export_data(app: AppHandle, scope: String) -> Result<Value, String> {
    let scope = required_runtime_argument(Some(scope), "scope")?;
    if !["all", "runs", "settings"].contains(&scope.as_str()) {
        return Err("导出范围无效".to_string());
    }
    let dir = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录: {error}"))?.join("exports");
    fs::create_dir_all(&dir).map_err(|error| format!("创建导出目录失败: {error}"))?;
    let output = dir.join(format!("export-{}-{}.json", scope, SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()));
    let output_string = output.to_string_lossy().to_string();
    let args = vec!["export-data".to_string(), "--scope".to_string(), scope, "--output".to_string(), output_string.clone()];
    let mut result = run_runtime_json_owned(&app, &args)?;
    if let Some(object) = result.as_object_mut() { object.insert("output".to_string(), Value::String(output_string)); }
    Ok(result)
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
fn memory_action(
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
fn run_dream(
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
    run_runtime_json_owned(&app, &args)
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
    let active_runtime_pid = state.active_runtime_pid.clone();
    let active_runs: Arc<dyn Fn() -> u32 + Send + Sync> = Arc::new(move || {
        active_runtime_pid
            .lock()
            .map(|pid| if pid.is_some() { 1 } else { 0 })
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
fn plugin_action(
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
    run_runtime_json_owned(&app, &args)
}

#[tauri::command]
async fn list_evolution(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_runtime_json(&app, &["evolution", "--operation", "list"]))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn evolution_action(
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
    run_runtime_json_owned(&app, &args)
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
) -> Result<RuntimeTaskResponse, String> {
    let state = state.inner().clone();
    reserve_runtime_launch(&state)?;
    let cleanup_state = state.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        run_model_task_blocking(
            app,
            state,
            prompt,
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
                clear_runtime_launch_reservation(&cleanup_state);
            }
            result
        }
        Err(error) => {
            // The worker can panic before it reaches its normal cleanup path.
            // Do not leave a launch reservation wedged in that case.
            clear_runtime_launch_reservation(&cleanup_state);
            Err(format!("Cordis runtime 后台任务异常: {error}"))
        }
    }
}

fn desktop_release_channel() -> Result<String, String> {
    if let Some(channel) = option_env!("HMCODEX_BAKED_RELEASE_CHANNEL") {
        validate_release_mode(channel, None)?;
        return Ok(channel.to_string());
    }
    let channel = match std::env::var("HMCODEX_RELEASE_CHANNEL") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => "WINDOWS_MVP_PRE_PHASE1".to_string(),
        Err(_) => return Err("RELEASE_CHANNEL_INVALID".to_string()),
    };
    validate_release_mode(&channel, None)?;
    Ok(channel)
}

fn validate_release_mode(channel: &str, mode: Option<&str>) -> Result<(), String> {
    match channel {
        "WINDOWS_MVP_PRE_PHASE1"
        | "WINDOWS_PHASE1_READ_ONLY"
        | "WINDOWS_PHASE1_5_CONTROLLED"
        | "WINDOWS_FULL_LOCAL" => {}
        _ => return Err("RELEASE_CHANNEL_INVALID".to_string()),
    }
    let mode = mode.unwrap_or("READ_ONLY");
    if channel == "WINDOWS_PHASE1_READ_ONLY" && mode != "READ_ONLY" {
        return Err("RELEASE_CHANNEL_READ_ONLY".to_string());
    }
    if !matches!(mode, "READ_ONLY" | "CONTROLLED") {
        return Err("EXECUTION_MODE_INVALID".to_string());
    }
    Ok(())
}

fn run_model_task_blocking(
    app: AppHandle,
    state: AppState,
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
) -> Result<RuntimeTaskResponse, String> {
    // Hold this for the full task lifetime. Runtime dashboard/list commands
    // acquire the same lock, so a startup read finishes before the task can
    // open the Harness database and no read can interrupt event persistence.
    let lock_wait_started = Instant::now();
    // std::sync::Mutex::lock() cannot be interrupted. Poll try_lock instead so
    // Cancel can be observed while another dashboard/task command owns the lock.
    let _runtime_command_guard = loop {
        match state.runtime_command_lock.try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err("运行时命令状态不可用".to_string());
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                let cancelled = *state
                    .active_runtime_cancel_requested
                    .lock()
                    .map_err(|_| "运行时状态不可用".to_string())?;
                if cancelled {
                    return Err("Cordis runtime 已在启动前取消".to_string());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    };
    let lock_wait_ms = lock_wait_started.elapsed().as_millis();
    if lock_wait_ms > 0 {
        append_desktop_log(&format!("runtime task waited for command lock {lock_wait_ms}ms"));
    }
    // A queued task can be cancelled while a dashboard owns the command lock.
    // Do not spawn a child for that cancelled reservation.
    if *state.active_runtime_cancel_requested.lock()
        .map_err(|_| "运行时状态不可用".to_string())? {
        return Err("Cordis runtime 已在启动前取消".to_string());
    }
    let channel = desktop_release_channel()?;
    validate_release_mode(&channel, execution_mode.as_deref())?;
    let root = ensure_default_workspace(&app, &state)?;
    let runtime = runtime_entrypoint(&app)?;
    let _ = app.emit("context-sidecar-status", &local_context_status());
    let mut command = runtime_command(&runtime);
    command
        .arg(runtime)
        .arg("task")
        .arg("--prompt")
        .arg(prompt)
        .arg("--workspace")
        .arg(root);
    let execution_mode = execution_mode.unwrap_or_else(|| "READ_ONLY".to_string());
    if execution_mode != "READ_ONLY" && execution_mode != "CONTROLLED" {
        return Err("执行模式无效".to_string());
    }
    command.arg("--execution-mode").arg(&execution_mode);
    if execution_mode == "CONTROLLED" {
        command.arg("--agent-mode").arg("multi");
    }
    command.arg("--events").arg("stdout");
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
    // Reserve the runtime slot before spawning while holding the same lock
    // used by Cancel. This closes the startup window where Cancel could see
    // no PID and return before the child had been registered.
    let mut child = {
        let _state_guard = state
            .runtime_state_lock
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        let mut active_pid = state
            .active_runtime_pid
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        if active_pid.is_some() {
            return Err("已有 Cordis runtime 任务正在运行".to_string());
        }
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
        let child_stdin = child.stdin.take();
        *active_pid = Some(pid);
        if let Ok(mut heartbeat_seen) = state.active_runtime_heartbeat_seen.lock() {
            *heartbeat_seen = false;
        }
        if let Ok(mut started_at_ms) = state.active_runtime_started_at_ms.lock() {
            let started = unix_time_ms();
            *started_at_ms = Some(started);
            if let Ok(mut heartbeat_at_ms) = state.active_runtime_last_heartbeat_at_ms.lock() {
                *heartbeat_at_ms = Some(started);
            }
        }
        let mut active_stdin = match state.active_runtime_stdin.lock() {
            Ok(value) => value,
            Err(_) => {
                *active_pid = None;
                if let Ok(mut started_at_ms) = state.active_runtime_started_at_ms.lock() {
                    *started_at_ms = None;
                }
                if let Ok(mut heartbeat_at_ms) = state.active_runtime_last_heartbeat_at_ms.lock() {
                    *heartbeat_at_ms = None;
                }
                if let Ok(mut heartbeat_seen) = state.active_runtime_heartbeat_seen.lock() {
                    *heartbeat_seen = false;
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err("运行时状态不可用".to_string());
            }
        };
        *active_stdin = child_stdin;
        let cancel_requested = state
            .active_runtime_cancel_requested
            .lock()
            .map(|requested| *requested)
            .unwrap_or(true);
        if cancel_requested {
            *active_pid = None;
            *active_stdin = None;
            if let Ok(mut started_at_ms) = state.active_runtime_started_at_ms.lock() {
                *started_at_ms = None;
            }
            if let Ok(mut heartbeat_at_ms) = state.active_runtime_last_heartbeat_at_ms.lock() {
                *heartbeat_at_ms = None;
            }
            if let Ok(mut heartbeat_seen) = state.active_runtime_heartbeat_seen.lock() {
                *heartbeat_seen = false;
            }
            if let Ok(mut launching) = state.active_runtime_launching.lock() {
                *launching = false;
            }
            if let Ok(mut requested) = state.active_runtime_cancel_requested.lock() {
                *requested = false;
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cordis runtime 已在启动前取消".to_string());
        }
        if let Ok(mut launching) = state.active_runtime_launching.lock() {
            *launching = false;
        }
        child
    };
    let pid = child.id();
    append_desktop_log(&format!("runtime task spawned pid={pid}"));
    let stderr = child.stderr.take();
    let stderr_thread = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr);
            let _ = reader.read_to_string(&mut text);
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
    let mut terminal_seen_at_ms = None;
    loop {
        match stdout_receiver.recv_timeout(Duration::from_millis(RUNTIME_WATCHDOG_POLL_MS)) {
            Ok(Ok(Some(line))) => {
                handle_runtime_stdout_line(&app, &state, pid, &line, &mut stdout_text);
                if runtime_last_phase(&stdout_text).is_some_and(|phase| {
                    matches!(phase.as_str(), "run.state_changed:SUCCEEDED" | "run.state_changed:FAILED" | "run.state_changed:CANCELLED")
                }) {
                    terminal_seen_at_ms.get_or_insert(unix_time_ms());
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
                let now_ms = unix_time_ms();
                let heartbeat_seen = state
                    .active_runtime_heartbeat_seen
                    .lock()
                    .map(|value| *value)
                    .unwrap_or(false);
                let startup_elapsed_ms = state
                    .active_runtime_started_at_ms
                    .lock()
                    .ok()
                    .and_then(|value| *value)
                    .map(|started| now_ms.saturating_sub(started))
                    .unwrap_or(RUNTIME_STARTUP_GRACE_MS + 1);
                let stale = if heartbeat_seen {
                    state
                        .active_runtime_last_heartbeat_at_ms
                        .lock()
                        .map(|value| runtime_heartbeat_is_stale(*value, now_ms))
                        .unwrap_or(true)
                } else {
                    startup_elapsed_ms > RUNTIME_STARTUP_GRACE_MS
                };
                let terminal_shutdown_expired = terminal_seen_at_ms
                    .is_some_and(|seen| now_ms.saturating_sub(seen) > RUNTIME_TERMINAL_SHUTDOWN_GRACE_MS);
                if (stale && terminal_seen_at_ms.is_none() || terminal_shutdown_expired)
                    && runtime_process_is_active(&state, pid)
                {
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
                            append_desktop_log(&format!(
                                "runtime 心跳超时，监督器终止进程 pid={pid} phase={phase}"
                            ));
                            format!("Cordis runtime 心跳超时，已由监督器终止（阶段: {phase}）")
                        }
                    };
                    stdout_error = Some(message);
                    let pid_text = pid.to_string();
                    #[cfg(windows)]
                    let _ = Command::new("taskkill")
                        .args(["/PID", pid_text.as_str(), "/T", "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .status();
                    #[cfg(not(windows))]
                    let _ = Command::new("kill")
                        .args(["-TERM", pid_text.as_str()])
                        .status();
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
    if let Ok(_state_guard) = state.runtime_state_lock.lock() {
        if let Ok(mut active_pid) = state.active_runtime_pid.lock() {
            if *active_pid == Some(pid) {
                *active_pid = None;
                if let Ok(mut active_stdin) = state.active_runtime_stdin.lock() {
                    *active_stdin = None;
                }
                if let Ok(mut started_at_ms) = state.active_runtime_started_at_ms.lock() {
                    *started_at_ms = None;
                }
                if let Ok(mut heartbeat_at_ms) = state.active_runtime_last_heartbeat_at_ms.lock() {
                    *heartbeat_at_ms = None;
                }
                if let Ok(mut heartbeat_seen) = state.active_runtime_heartbeat_seen.lock() {
                    *heartbeat_seen = false;
                }
            }
        }
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

#[tauri::command]
fn resolve_runtime_approval(
    state: State<'_, AppState>,
    request_id: String,
    approved: bool,
    displayed_digest: String,
) -> Result<(), String> {
    if request_id.trim().is_empty() || displayed_digest.trim().is_empty() {
        return Err("审批回执缺少 requestId 或展示摘要".to_string());
    }
    let _state_guard = state
        .runtime_state_lock
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let mut stdin = state
        .active_runtime_stdin
        .lock()
        .map_err(|_| "运行时状态不可用".to_string())?;
    let Some(stdin) = stdin.as_mut() else {
        return Err("当前没有等待审批的运行时任务".to_string());
    };
    let payload = serde_json::json!({
        "type": "approval_response",
        "requestId": request_id,
        "approved": approved,
        "displayedDigest": displayed_digest
    });
    use std::io::Write;
    writeln!(stdin, "{}", payload).map_err(|error| format!("审批回执发送失败: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("审批回执刷新失败: {error}"))
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
fn cancel_model_task(state: State<'_, AppState>) -> Result<RuntimeCancellation, String> {
    cancel_runtime_process(state.inner())
}

/// Kill the active runtime process tree and clear its host bookkeeping.
///
/// This is shared by the explicit Cancel command and the application shutdown
/// hook. Clearing stdin before taskkill prevents an approval response from
/// racing with teardown; restoring the PID on failure keeps a subsequent
/// status/cancel call truthful.
fn cancel_runtime_process(state: &AppState) -> Result<RuntimeCancellation, String> {
    append_desktop_log("cancel_runtime_process invoked");
    let pid = {
        let _state_guard = state
            .runtime_state_lock
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        let pid = state
            .active_runtime_pid
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?
            .take();
        let mut launching = state
            .active_runtime_launching
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        let mut cancel_requested = state
            .active_runtime_cancel_requested
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        if pid.is_none() && *launching {
            // The worker has been reserved but has not spawned its child yet.
            // Leave the reservation in place; the worker will observe this
            // bit after spawn and terminate before forwarding any event.
            *cancel_requested = true;
            append_desktop_log("cancel_runtime_process: reserved launch before spawn");
            return Ok(RuntimeCancellation { cancelled: true });
        }
        *cancel_requested = false;
        *launching = false;
        let mut stdin = state
            .active_runtime_stdin
            .lock()
            .map_err(|_| "运行时状态不可用".to_string())?;
        *stdin = None;
        if let Ok(mut started_at_ms) = state.active_runtime_started_at_ms.lock() {
            *started_at_ms = None;
        }
        if let Ok(mut heartbeat_at_ms) = state.active_runtime_last_heartbeat_at_ms.lock() {
            *heartbeat_at_ms = None;
        }
        if let Ok(mut heartbeat_seen) = state.active_runtime_heartbeat_seen.lock() {
            *heartbeat_seen = false;
        }
        pid
    };
    let Some(pid) = pid else {
        return Ok(RuntimeCancellation { cancelled: false });
    };
    append_desktop_log(&format!("cancel_runtime_process: killing pid={pid}"));

    let pid_text = pid.to_string();
    #[cfg(windows)]
    let status = Command::new("taskkill")
        .args(["/PID", pid_text.as_str(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    #[cfg(not(windows))]
    let status = Command::new("kill")
        .args(["-TERM", pid_text.as_str()])
        .status();
    let status = match status {
        Ok(status) => status,
        Err(error) => {
            if let Ok(_state_guard) = state.runtime_state_lock.lock() {
                if let Ok(mut active_pid) = state.active_runtime_pid.lock() {
                    if active_pid.is_none() {
                        *active_pid = Some(pid);
                    }
                }
                if let Ok(mut started_at_ms) = state.active_runtime_started_at_ms.lock() {
                    if started_at_ms.is_none() {
                        *started_at_ms = Some(unix_time_ms());
                    }
                }
            }
            return Err(format!("无法取消 Cordis runtime: {error}"));
        }
    };
    if status.success() {
        return Ok(RuntimeCancellation { cancelled: true });
    }
    if let Ok(_state_guard) = state.runtime_state_lock.lock() {
        if let Ok(mut active_pid) = state.active_runtime_pid.lock() {
            if active_pid.is_none() {
                *active_pid = Some(pid);
            }
        }
        if let Ok(mut started_at_ms) = state.active_runtime_started_at_ms.lock() {
            if started_at_ms.is_none() {
                *started_at_ms = Some(unix_time_ms());
            }
        }
    }
    Err("Cordis runtime 取消失败".to_string())
}

fn runtime_entrypoint(app: &AppHandle) -> Result<PathBuf, String> {
    let resolve_entry = |candidate: PathBuf| {
        let resolved = normalize_existing_file(candidate);
        append_desktop_log(&(String::from("runtime entrypoint=") + &resolved.display().to_string()));
        resolved
    };
    if let Ok(path) = std::env::var("HMCODEX_RUNTIME_ENTRY") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Ok(resolve_entry(candidate));
        }
        return Err("HMCODEX_RUNTIME_ENTRY 不是有效文件".to_string());
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
        .ok_or_else(|| "找不到 runtime/src/index.mjs，请设置 HMCODEX_RUNTIME_ENTRY".to_string())
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

fn runtime_command(runtime: &Path) -> Command {
    let mut command =
        Command::new(std::env::var_os("HMCODEX_NODE").unwrap_or_else(|| "node".into()));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    if let Some(channel) = option_env!("HMCODEX_BAKED_RELEASE_CHANNEL") {
        command.env("HMCODEX_BAKED_RELEASE_CHANNEL", channel);
    }
    command.env(
        "HMCODEX_RELEASE_CHANNEL",
        desktop_release_channel().unwrap_or_else(|_| "INVALID_CHANNEL".to_string()),
    );
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

fn default_workspace_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("HMCODEX_WORKSPACE_ROOT") {
        let candidate = PathBuf::from(value);
        if candidate.is_dir() {
            return normalize_existing_dir(candidate)
                .map_err(|error| format!("无法解析默认工作区: {error}"));
        }
    }

    let mut candidates = Vec::with_capacity(8);
    if let Ok(current) = std::env::current_dir() {
        candidates.extend([current.clone(), current.join(".."), current.join("../..")]);
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.extend([
                parent.to_path_buf(),
                parent.join(".."),
                parent.join("../.."),
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
        if !resolved.is_dir() {
            continue;
        }
        if fallback.is_none() {
            fallback = Some(resolved.clone());
        }
        let looks_like_workspace = ["desktop", "contracts", "README.md"]
            .iter()
            .any(|name| resolved.join(name).exists());
        if looks_like_workspace {
            return Ok(resolved);
        }
    }
    fallback.ok_or_else(|| {
        "找不到默认工作区，请设置 HMCODEX_WORKSPACE_ROOT 或点击“打开项目”".to_string()
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

fn is_history_read(args: &[&str]) -> bool {
    args.first() == Some(&"thread-events")
        || (args.first() == Some(&"dashboard") && args.windows(2).any(|pair| pair == ["--summary", "true"]))
        || (args.first() == Some(&"thread")
            && args.windows(2).any(|pair| pair == ["--summary", "true"])
            && args.windows(2).any(|pair| pair == ["--operation", "list"] || pair == ["--operation", "get"]))
}

fn run_runtime_json(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    // Dashboard, recovery and governance commands use the same Harness store
    // as a live task. Serialize the process lifetime here instead of relying
    // on SQLite's busy timeout, which can otherwise stall the task before it
    // emits RoleContextAllocated.
    let lock_wait_started = Instant::now();
    let state = app.state::<AppState>();
    // These commands open a read-only transaction and never recover or rebuild.
    // Keep writes serialized without queuing history behind an entire recovery.
    let _runtime_command_guard = if is_history_read(args) { None } else {
        Some(state.runtime_command_lock.lock()
            .map_err(|_| "运行时命令状态不可用".to_string())?)
    };
    let lock_wait_ms = lock_wait_started.elapsed().as_millis();
    let command_name = args.first().copied().unwrap_or("unknown");
    append_desktop_log(&format!("runtime query start command={command_name} lock_wait_ms={lock_wait_ms}"));
    let runtime = runtime_entrypoint(app)?;
    let runtime = if is_history_read(args) { runtime.with_file_name("history-cli.mjs") } else { runtime };
    let output = runtime_command(&runtime)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                if runtime_entrypoint(&app_handle).is_ok() {
                    let status = local_context_status();
                    let _ = app_handle.emit("context-sidecar-status", &status);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_snapshot,
            model_config,
            save_model_config,
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
            cancel_model_task,
            resolve_runtime_approval
        ])
        .build(tauri::generate_context!())
        .expect("error while building dda");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            let state = app_handle.state::<AppState>();
            let _ = cancel_runtime_process(state.inner());
            let _ = stop_dream_maintenance_impl(&app_handle, &state.dream_maintenance);
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
    fn only_read_only_history_commands_bypass_the_runtime_write_lock() {
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
    fn phase1_release_gate_rejects_controlled_and_invalid_channels() {
        assert!(validate_release_mode("WINDOWS_PHASE1_READ_ONLY", None).is_ok());
        assert!(validate_release_mode("WINDOWS_PHASE1_READ_ONLY", Some("READ_ONLY")).is_ok());
        for mode in ["CONTROLLED", "CONTROLLED_WRITE", "unknown"] {
            assert_eq!(
                validate_release_mode("WINDOWS_PHASE1_READ_ONLY", Some(mode)).unwrap_err(),
                "RELEASE_CHANNEL_READ_ONLY"
            );
        }
        for channel in ["", "phase1", "WINDOWS_PHASE1_READ_ONlY"] {
            assert_eq!(
                validate_release_mode(channel, None).unwrap_err(),
                "RELEASE_CHANNEL_INVALID"
            );
        }
        assert!(validate_release_mode("WINDOWS_PHASE1_5_CONTROLLED", None).is_ok());
        assert!(validate_release_mode("WINDOWS_PHASE1_5_CONTROLLED", Some("READ_ONLY")).is_ok());
        assert!(validate_release_mode("WINDOWS_PHASE1_5_CONTROLLED", Some("CONTROLLED")).is_ok());
        assert!(validate_release_mode("WINDOWS_MVP_PRE_PHASE1", Some("CONTROLLED")).is_ok());
        assert!(validate_release_mode("WINDOWS_FULL_LOCAL", Some("unknown")).is_err());
    }
    use std::io::Write;
    use tempfile::tempdir;

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
    fn extracts_last_runtime_phase_for_watchdog_diagnostics() {
        let stdout = r#"{"type":"runtime_event","kind":"run.started","payload":{}}
{"type":"runtime_event","kind":"runtime.phase","payload":{"phase":"LEGACY_MIGRATION_CHECK"}}
"#;
        assert_eq!(runtime_last_phase(stdout).as_deref(), Some("LEGACY_MIGRATION_CHECK"));
    }

    #[test]
    fn runtime_command_lock_serializes_dashboard_and_task_slots() {
        let state = AppState::default();
        let guard = state.runtime_command_lock.lock().unwrap();
        let (ready_sender, ready_receiver) = std::sync::mpsc::channel();
        let worker_state = state.clone();
        let worker = std::thread::spawn(move || {
            let _worker_guard = worker_state.runtime_command_lock.lock().unwrap();
            ready_sender.send(()).unwrap();
        });

        assert!(ready_receiver
            .recv_timeout(Duration::from_millis(50))
            .is_err());
        drop(guard);
        assert!(ready_receiver
            .recv_timeout(Duration::from_secs(1))
            .is_ok());
        worker.join().unwrap();
    }

    #[test]
    fn forwards_runtime_events_only_for_the_active_process() {
        let state = AppState::default();
        *state.active_runtime_pid.lock().unwrap() = Some(41);
        assert!(runtime_process_is_active(&state, 41));
        assert!(!runtime_process_is_active(&state, 42));

        *state.active_runtime_pid.lock().unwrap() = None;
        assert!(!runtime_process_is_active(&state, 41));
    }

    #[test]
    fn cancellation_can_target_a_reserved_runtime_launch() {
        let state = AppState::default();
        reserve_runtime_launch(&state).unwrap();
        assert!(*state.active_runtime_launching.lock().unwrap());

        let result = cancel_runtime_process(&state).unwrap();
        assert!(result.cancelled);
        assert!(*state.active_runtime_cancel_requested.lock().unwrap());
        assert!(*state.active_runtime_launching.lock().unwrap());

        clear_runtime_launch_reservation(&state);
        assert!(!*state.active_runtime_launching.lock().unwrap());
        assert!(!*state.active_runtime_cancel_requested.lock().unwrap());
    }

    #[test]
    fn cancelling_without_an_active_runtime_is_a_noop() {
        let state = AppState::default();
        let result = cancel_runtime_process(&state).unwrap();
        assert!(!result.cancelled);
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
