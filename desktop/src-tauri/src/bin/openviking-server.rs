use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SERVICE_VERSION: &str = "0.1.0";
const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 1933;
const DEFAULT_MAX_BODY_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES: usize = 256 * 1024;
const DEFAULT_MAX_STORE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MAX_MEMORIES: usize = 2048;

#[derive(Clone, Debug)]
struct ServerConfig {
    host: String,
    port: u16,
    data_dir: PathBuf,
    max_body_bytes: usize,
    max_response_bytes: usize,
    max_store_bytes: usize,
    max_memories: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Request {
    method: String,
    path: String,
    authorization: Option<String>,
    peer: Option<String>,
    body: Value,
}

struct State {
    config: ServerConfig,
    degraded: bool,
    store: Mutex<Value>,
}

fn unix_time_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_text(value: &str) -> String {
    hex(&Sha256::digest(value.as_bytes()))
}

fn positive_usize(
    value: Option<&Value>,
    fallback: usize,
    maximum: usize,
) -> Result<usize, &'static str> {
    let Some(value) = value else {
        return Ok(fallback);
    };
    let parsed = value.as_u64().ok_or("OPENVIKING_SIDECAR_CONFIG_INVALID")?;
    if parsed == 0 || parsed > maximum as u64 {
        return Err("OPENVIKING_SIDECAR_CONFIG_INVALID");
    }
    Ok(parsed as usize)
}

fn default_data_dir() -> Result<PathBuf, &'static str> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or("OPENVIKING_SIDECAR_DATA_DIR_INVALID")?;
    Ok(PathBuf::from(base).join("hmCodex").join("openviking"))
}

fn read_config(path: &Path) -> Result<Value, &'static str> {
    let text = fs::read_to_string(path).map_err(|_| "OPENVIKING_SIDECAR_CONFIG_INVALID")?;
    let value: Value =
        serde_json::from_str(&text).map_err(|_| "OPENVIKING_SIDECAR_CONFIG_INVALID")?;
    if !value.is_object() {
        return Err("OPENVIKING_SIDECAR_CONFIG_INVALID");
    }
    Ok(value)
}

fn parse_args() -> Result<ServerConfig, &'static str> {
    let mut host = DEFAULT_HOST.to_string();
    let mut port = DEFAULT_PORT;
    let mut config_path = None;
    let mut max_body_bytes = DEFAULT_MAX_BODY_BYTES;
    let mut max_response_bytes = DEFAULT_MAX_RESPONSE_BYTES;
    let mut max_store_bytes = DEFAULT_MAX_STORE_BYTES;
    let mut max_memories = DEFAULT_MAX_MEMORIES;
    let mut data_dir = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--host" => host = args.next().ok_or("OPENVIKING_SIDECAR_ARGS_INVALID")?,
            "--port" => {
                port = args
                    .next()
                    .ok_or("OPENVIKING_SIDECAR_ARGS_INVALID")?
                    .parse()
                    .map_err(|_| "OPENVIKING_SIDECAR_ARGS_INVALID")?;
            }
            "--config" => {
                config_path = Some(PathBuf::from(
                    args.next().ok_or("OPENVIKING_SIDECAR_ARGS_INVALID")?,
                ))
            }
            _ => return Err("OPENVIKING_SIDECAR_ARGS_INVALID"),
        }
    }
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Err("OPENVIKING_SIDECAR_HOST_INVALID");
    }
    if let Some(path) = config_path {
        let value = read_config(&path)?;
        if let Some(candidate) = value.get("dataDir") {
            let candidate = candidate
                .as_str()
                .ok_or("OPENVIKING_SIDECAR_CONFIG_INVALID")?;
            let path = PathBuf::from(candidate);
            if !path.is_absolute() {
                return Err("OPENVIKING_SIDECAR_CONFIG_INVALID");
            }
            data_dir = Some(path);
        }
        max_body_bytes =
            positive_usize(value.get("maxBodyBytes"), max_body_bytes, 4 * 1024 * 1024)?;
        max_response_bytes = positive_usize(
            value.get("maxResponseBytes"),
            max_response_bytes,
            1024 * 1024,
        )?;
        max_store_bytes = positive_usize(
            value.get("maxStoreBytes"),
            max_store_bytes,
            256 * 1024 * 1024,
        )?;
        max_memories = positive_usize(value.get("maxMemories"), max_memories, 65536)?;
    }
    let data_dir = data_dir
        .or_else(|| std::env::var_os("HMCODEX_OPENVIKING_DATA_DIR").map(PathBuf::from))
        .map(Ok)
        .unwrap_or_else(default_data_dir)?;
    Ok(ServerConfig {
        host,
        port,
        data_dir,
        max_body_bytes,
        max_response_bytes,
        max_store_bytes,
        max_memories,
    })
}

fn backup_corrupt_store(path: &Path) -> Result<(), std::io::Error> {
    let target = path.with_extension(format!("corrupt-{}.json", unix_time_ms()));
    fs::rename(path, target)
}

fn load_store(config: &ServerConfig) -> Result<(Value, bool), &'static str> {
    fs::create_dir_all(&config.data_dir).map_err(|_| "OPENVIKING_SIDECAR_DATA_DIR_INVALID")?;
    let path = config.data_dir.join("openviking-store.json");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((json!({"version": 1}), false))
        }
        Err(_) => return Err("OPENVIKING_SIDECAR_DATA_DIR_INVALID"),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(value) if value.is_object() => Ok((value, false)),
        _ => {
            backup_corrupt_store(&path).map_err(|_| "OPENVIKING_SIDECAR_DATA_DIR_INVALID")?;
            Ok((json!({"version": 1, "degraded": true}), true))
        }
    }
}

fn save_store(config: &ServerConfig, store: &Value) -> Result<(), &'static str> {
    let serialized = serde_json::to_vec(store).map_err(|_| "OPENVIKING_SIDECAR_STORE_FAILED")?;
    if serialized.len() > config.max_store_bytes {
        return Err("OPENVIKING_SIDECAR_STORE_LIMIT");
    }
    let path = config.data_dir.join("openviking-store.json");
    let temporary = path.with_extension(format!("tmp-{}.json", unix_time_ms()));
    let mut file = fs::File::create(&temporary).map_err(|_| "OPENVIKING_SIDECAR_STORE_FAILED")?;
    file.write_all(&serialized)
        .map_err(|_| "OPENVIKING_SIDECAR_STORE_FAILED")?;
    file.sync_all()
        .map_err(|_| "OPENVIKING_SIDECAR_STORE_FAILED")?;
    drop(file);
    fs::rename(&temporary, &path).map_err(|_| "OPENVIKING_SIDECAR_STORE_FAILED")
}

fn valid_peer(value: Option<&str>) -> Result<String, &'static str> {
    let peer = value.ok_or("OPENVIKING_ACTOR_PEER_REQUIRED")?;
    if peer.len() < 8 || peer.len() > 128 || !peer.starts_with("hmcodex-workspace-") {
        return Err("OPENVIKING_ACTOR_PEER_INVALID");
    }
    if !peer
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err("OPENVIKING_ACTOR_PEER_INVALID");
    }
    Ok(peer.to_string())
}

fn bearer_token() -> Option<String> {
    std::env::var("HMCODEX_OPENVIKING_API_KEY")
        .or_else(|_| std::env::var("OPENVIKING_API_KEY"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn peer_section_mut<'a>(store: &'a mut Value, peer: &str) -> Result<&'a mut Value, &'static str> {
    let peers = store
        .as_object_mut()
        .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?;
    let section = peers
        .entry("peers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?;
    Ok(section
        .entry(peer.to_string())
        .or_insert_with(|| json!({ "memories": [], "sessions": {} })))
}

fn ensure_session(
    store: &mut Value,
    peer: &str,
    desired: &str,
    time_ms: u128,
) -> Result<String, &'static str> {
    let normalized = desired.trim();
    if normalized.len() < 4 || normalized.len() > 96 {
        return Err("OPENVIKING_SESSION_ID_INVALID");
    }
    if !normalized
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
        || normalized.starts_with(['-', '_', '.'])
    {
        return Err("OPENVIKING_SESSION_ID_INVALID");
    }
    let section = peer_section_mut(store, peer)?;
    let sessions = section
        .as_object_mut()
        .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?
        .entry("sessions")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?;
    if sessions.contains_key(normalized) {
        return Ok(normalized.to_string());
    }
    if sessions.len() >= 512 {
        return Err("OPENVIKING_SESSION_LIMIT");
    }
    sessions.insert(
        normalized.to_string(),
        json!({
            "createdAtMs": time_ms,
            "messages": [],
            "usedContexts": [],
            "committedTaskIds": []
        }),
    );
    Ok(normalized.to_string())
}

fn add_memory(
    section: &mut Value,
    session: &str,
    statement: &str,
    time_ms: u128,
) -> Result<String, &'static str> {
    let config = current_config();
    let memories = section
        .as_object_mut()
        .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?
        .entry("memories")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?;
    if memories.len() >= config.max_memories {
        return Err("OPENVIKING_MEMORY_LIMIT");
    }
    let uri = format!(
        "viking://hmcodex/memories/{}.md",
        sha256_text(&format!("{session}:{statement}"))
    );
    if memories
        .iter()
        .any(|memory| memory.get("uri") == Some(&Value::String(uri.clone())))
    {
        return Ok(uri);
    }
    memories.push(json!({
        "uri": uri,
        "statement": statement,
        "category": "memory",
        "createdAtMs": time_ms,
        "sessionId": session
    }));
    Ok(uri)
}

fn current_config() -> ServerConfig {
    CONFIG
        .get_or_init(|| ServerConfig {
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT,
            data_dir: PathBuf::from("."),
            max_body_bytes: DEFAULT_MAX_BODY_BYTES,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
            max_store_bytes: DEFAULT_MAX_STORE_BYTES,
            max_memories: DEFAULT_MAX_MEMORIES,
        })
        .clone()
}

static CONFIG: std::sync::OnceLock<ServerConfig> = std::sync::OnceLock::new();

fn bounded_string(value: &Value, maximum: usize) -> Option<String> {
    let text = value
        .as_str()?
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(text.chars().take(maximum).collect::<String>())
}

fn search_memories(section: &Value, query: &str, max_tokens: usize) -> Result<Value, &'static str> {
    let terms = query
        .split_whitespace()
        .map(|term| term.to_ascii_lowercase())
        .filter(|term| term.len() >= 2)
        .take(32)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Ok(
            json!({"entries": [], "rendered": "", "stats": {"rewrite": "no_relevant", "used_tokens": 0}}),
        );
    }
    let mut entries = Vec::new();
    let memories = section
        .get("memories")
        .and_then(Value::as_array)
        .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?;
    let limit = (max_tokens / 64).clamp(1, 64);
    for memory in memories {
        let statement = memory
            .get("statement")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let lowered = statement.to_ascii_lowercase();
        let matches = terms.iter().filter(|term| lowered.contains(*term)).count();
        if matches == 0 {
            continue;
        }
        entries.push(json!({
            "uri": memory.get("uri"),
            "text": statement,
            "category": memory.get("category"),
            "score": 0.5 + f64::min(0.49, matches as f64 * 0.1)
        }));
        if entries.len() >= limit {
            break;
        }
    }
    let used_tokens = entries
        .iter()
        .map(|entry| entry.to_string().len() / 4)
        .sum::<usize>();
    Ok(json!({"entries": entries, "rendered": "", "stats": {"used_tokens": used_tokens}}))
}

fn handle_session(state: &mut State, request: &Request) -> Result<Value, &'static str> {
    let peer = valid_peer(request.peer.as_deref())?;
    let mut store = state
        .store
        .lock()
        .map_err(|_| "OPENVIKING_SIDECAR_STATE_FAILED")?;
    let desired = request
        .body
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("hmcodex-session");
    let session = ensure_session(&mut store, &peer, desired, unix_time_ms())?;
    save_store(&state.config, &store)?;
    Ok(json!({"session_id": session}))
}

fn handle_search(state: &mut State, request: &Request) -> Result<Value, &'static str> {
    let peer = valid_peer(request.peer.as_deref())?;
    let query = request
        .body
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if query.chars().count() > 4000 {
        return Err("OPENVIKING_QUERY_LIMIT");
    }
    let max_tokens = request
        .body
        .get("max_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(1500)
        .clamp(64, 24000) as usize;
    let store = state
        .store
        .lock()
        .map_err(|_| "OPENVIKING_SIDECAR_STATE_FAILED")?;
    let section = store
        .pointer(&format!("/peers/{peer}"))
        .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?;
    search_memories(section, query, max_tokens)
}

fn handle_messages(state: &mut State, request: &Request) -> Result<Value, &'static str> {
    let peer = valid_peer(request.peer.as_deref())?;
    let session = request
        .path
        .split('/')
        .nth(4)
        .ok_or("OPENVIKING_SESSION_ID_INVALID")?;
    let messages = request
        .body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or("OPENVIKING_MESSAGES_INVALID")?;
    if messages.is_empty() || messages.len() > 128 {
        return Err("OPENVIKING_MESSAGES_INVALID");
    }
    let statements = messages
        .iter()
        .map(|message| bounded_string(message.get("content").unwrap_or(&Value::Null), 2000))
        .collect::<Option<Vec<_>>>()
        .ok_or("OPENVIKING_MESSAGES_INVALID")?;
    if statements.iter().any(String::is_empty) {
        return Err("OPENVIKING_MESSAGES_INVALID");
    }
    let time_ms = unix_time_ms();
    let mut store = state
        .store
        .lock()
        .map_err(|_| "OPENVIKING_SIDECAR_STATE_FAILED")?;
    let section = peer_section_mut(&mut store, &peer)?;
    let added_count = statements.len();
    {
        let sessions = section
            .get_mut("sessions")
            .and_then(Value::as_object_mut)
            .ok_or("OPENVIKING_SESSION_ID_INVALID")?;
        let target = sessions
            .get_mut(session)
            .and_then(Value::as_object_mut)
            .ok_or("OPENVIKING_SESSION_ID_INVALID")?;
        let stored = target
            .entry("messages")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?;
        if stored.len() + statements.len() > 4096 {
            return Err("OPENVIKING_SESSION_LIMIT");
        }
        for statement in &statements {
            stored.push(json!({"role": "assistant", "content": statement, "atMs": time_ms}));
        }
    }
    for statement in &statements {
        add_memory(section, session, statement, time_ms)?;
    }
    save_store(&state.config, &store)?;
    Ok(json!({"added": added_count}))
}

fn handle_used(state: &mut State, request: &Request) -> Result<Value, &'static str> {
    let peer = valid_peer(request.peer.as_deref())?;
    let session = request
        .path
        .split('/')
        .nth(4)
        .ok_or("OPENVIKING_SESSION_ID_INVALID")?;
    let contexts = request
        .body
        .get("contexts")
        .and_then(Value::as_array)
        .ok_or("OPENVIKING_CONTEXTS_INVALID")?;
    if contexts.len() > 64 {
        return Err("OPENVIKING_CONTEXTS_INVALID");
    }
    let mut accepted = Vec::new();
    for context in contexts {
        let uri = context.as_str().ok_or("OPENVIKING_CONTEXTS_INVALID")?;
        if !uri.starts_with("viking://") || uri.len() > 1000 || accepted.contains(&uri.to_string())
        {
            return Err("OPENVIKING_CONTEXTS_INVALID");
        }
        accepted.push(uri.to_string());
    }
    let mut store = state
        .store
        .lock()
        .map_err(|_| "OPENVIKING_SIDECAR_STATE_FAILED")?;
    {
        let section = peer_section_mut(&mut store, &peer)?;
        let session = section
            .pointer_mut(&format!("/sessions/{session}"))
            .and_then(Value::as_object_mut)
            .ok_or("OPENVIKING_SESSION_ID_INVALID")?;
        let used = session
            .entry("usedContexts")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?;
        for uri in &accepted {
            used.push(Value::String(uri.to_string()));
        }
    }
    save_store(&state.config, &store)?;
    Ok(json!({"contexts_used": accepted.len()}))
}

fn handle_commit(state: &mut State, request: &Request) -> Result<Value, &'static str> {
    let peer = valid_peer(request.peer.as_deref())?;
    let session = request
        .path
        .split('/')
        .nth(4)
        .ok_or("OPENVIKING_SESSION_ID_INVALID")?;
    let time_ms = unix_time_ms();
    let mut store = state
        .store
        .lock()
        .map_err(|_| "OPENVIKING_SIDECAR_STATE_FAILED")?;
    let task_id = {
        let section = peer_section_mut(&mut store, &peer)?;
        let target = section
            .pointer_mut(&format!("/sessions/{session}"))
            .and_then(Value::as_object_mut)
            .ok_or("OPENVIKING_SESSION_ID_INVALID")?;
        let task_id = format!(
            "hmcodex-commit-{}",
            sha256_text(&format!("{peer}:{session}:{time_ms}"))[..32].to_string()
        );
        target
            .entry("committedTaskIds")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or("OPENVIKING_SIDECAR_STORE_FAILED")?
            .push(Value::String(task_id.clone()));
        task_id
    };
    save_store(&state.config, &store)?;
    Ok(json!({"status": "accepted", "task_id": task_id}))
}

fn handle_request(state: &mut State, request: &Request) -> Result<Value, &'static str> {
    if request.method == "GET" && request.path == "/ready" {
        return Ok(json!({"ready": true, "version": SERVICE_VERSION, "degraded": state.degraded}));
    }
    let token = bearer_token().ok_or("OPENVIKING_UNAUTHENTICATED")?;
    if request.authorization.as_deref() != Some(format!("Bearer {token}").as_str()) {
        return Err("OPENVIKING_UNAUTHENTICATED");
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/api/v1/sessions") => handle_session(state, request),
        ("POST", "/api/v1/search/search") => handle_search(state, request),
        ("POST", path)
            if path.starts_with("/api/v1/sessions/") && path.ends_with("/messages/batch") =>
        {
            handle_messages(state, request)
        }
        ("POST", path) if path.starts_with("/api/v1/sessions/") && path.ends_with("/used") => {
            handle_used(state, request)
        }
        ("POST", path) if path.starts_with("/api/v1/sessions/") && path.ends_with("/commit") => {
            handle_commit(state, request)
        }
        _ => Err("OPENVIKING_ROUTE_NOT_FOUND"),
    }
}

fn error_status(code: &str) -> u16 {
    match code {
        "OPENVIKING_UNAUTHENTICATED" => 401,
        "OPENVIKING_ACTOR_PEER_INVALID" | "OPENVIKING_ACTOR_PEER_REQUIRED" => 403,
        "OPENVIKING_ROUTE_NOT_FOUND" => 404,
        "OPENVIKING_STORE_FAILED"
        | "OPENVIKING_SIDECAR_STATE_FAILED"
        | "OPENVIKING_SIDECAR_STORE_FAILED" => 503,
        _ => 400,
    }
}

fn parse_request(stream: &mut TcpStream, maximum: usize) -> Result<Option<Request>, &'static str> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    let header_end;
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| "OPENVIKING_REQUEST_INVALID")?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            header_end = position + 4;
            break;
        }
        if buffer.len() > 16 * 1024 {
            return Err("OPENVIKING_REQUEST_TOO_LARGE");
        }
    }
    let text = String::from_utf8(buffer[..header_end].to_vec())
        .map_err(|_| "OPENVIKING_REQUEST_INVALID")?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or("OPENVIKING_REQUEST_INVALID")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or("OPENVIKING_REQUEST_INVALID")?
        .to_string();
    let target = request_parts.next().ok_or("OPENVIKING_REQUEST_INVALID")?;
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| "OPENVIKING_REQUEST_INVALID")
        })
        .transpose()?
        .unwrap_or(0);
    if content_length > maximum {
        return Err("OPENVIKING_REQUEST_TOO_LARGE");
    }
    while buffer.len() < header_end + content_length {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| "OPENVIKING_REQUEST_INVALID")?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > header_end + maximum + 1024 {
            return Err("OPENVIKING_REQUEST_TOO_LARGE");
        }
    }
    let body = if content_length == 0 {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&buffer[header_end..header_end + content_length])
            .map_err(|_| "OPENVIKING_REQUEST_INVALID")?
    };
    let path = target.split('?').next().unwrap_or_default().to_string();
    if target.contains('?') || target.contains('#') {
        return Err("OPENVIKING_REQUEST_INVALID");
    }
    Ok(Some(Request {
        method,
        path,
        authorization: headers.get("authorization").cloned(),
        peer: headers.get("x-openviking-actor-peer").cloned(),
        body,
    }))
}

fn response(status: u16, body: &Value, maximum: usize) -> Vec<u8> {
    let serialized = serde_json::to_vec(body).unwrap_or_else(|_| b"{}".to_vec());
    if serialized.len() > maximum {
        let body = json!({"status": "error", "error": {"code": "OPENVIKING_RESPONSE_TOO_LARGE"}});
        let serialized = serde_json::to_vec(&body).unwrap();
        return format!("HTTP/1.1 413 Content Too Large\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", serialized.len()).into_bytes().into_iter().chain(serialized).collect();
    }
    let reason = if status < 400 { "OK" } else { "ERROR" };
    format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", serialized.len()).into_bytes().into_iter().chain(serialized).collect()
}

fn serve_once(state: &Arc<Mutex<State>>, stream: &mut TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_nodelay(true);
    let request = match parse_request(
        stream,
        state
            .lock()
            .map(|state| state.config.max_body_bytes)
            .unwrap_or(DEFAULT_MAX_BODY_BYTES),
    ) {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(code) => {
            let body = json!({"status": "error", "error": {"code": code}});
            let _ = stream.write_all(&response(
                error_status(code),
                &body,
                DEFAULT_MAX_RESPONSE_BYTES,
            ));
            return;
        }
    };
    let mut guard = state
        .lock()
        .map_err(|_| "OPENVIKING_SIDECAR_STATE_FAILED")
        .ok();
    let Some(state) = guard.as_mut() else {
        let body = json!({"status": "error", "error": {"code": "OPENVIKING_SIDECAR_STATE_FAILED"}});
        let _ = stream.write_all(&response(503, &body, DEFAULT_MAX_RESPONSE_BYTES));
        return;
    };
    let maximum = state.config.max_response_bytes;
    match handle_request(state, &request) {
        Ok(result) => {
            let _ = stream.write_all(&response(
                200,
                &json!({"status": "ok", "result": result}),
                maximum,
            ));
        }
        Err(code) => {
            let _ = stream.write_all(&response(
                error_status(code),
                &json!({"status": "error", "error": {"code": code}}),
                maximum,
            ));
        }
    }
}

fn run() -> Result<(), &'static str> {
    let config = parse_args()?;
    let (store, degraded) = load_store(&config)?;
    let listener = TcpListener::bind((config.host.as_str(), config.port))
        .map_err(|_| "OPENVIKING_SIDECAR_BIND_FAILED")?;
    let state = Arc::new(Mutex::new(State {
        config: config.clone(),
        degraded,
        store: Mutex::new(store),
    }));
    CONFIG
        .set(config.clone())
        .map_err(|_| "OPENVIKING_SIDECAR_STATE_FAILED")?;
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let state = Arc::clone(&state);
        std::thread::spawn(move || serve_once(&state, &mut stream));
    }
    Ok(())
}

fn main() {
    if let Err(code) = run() {
        let _ = std::io::stderr().write_all(format!("{code}\n").as_bytes());
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bounded_hmcodex_peers() {
        assert_eq!(
            valid_peer(Some("hmcodex-workspace-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).unwrap(),
            "hmcodex-workspace-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert!(valid_peer(Some("hmcodex-workspace-../escape")).is_err());
        assert!(valid_peer(Some("external-peer-12345678")).is_err());
    }

    #[test]
    fn parses_bounded_requests() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .write_all(b"POST /ready HTTP/1.1\r\ncontent-length: 2\r\n\r\n{}")
                .unwrap();
        });
        let (mut stream, _) = listener.accept().unwrap();
        let request = parse_request(&mut stream, 1024).unwrap().unwrap();
        client.join().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/ready");
        assert_eq!(request.body, json!({}));
    }

    #[test]
    fn requires_a_non_empty_bearer_token() {
        std::env::remove_var("HMCODEX_OPENVIKING_API_KEY");
        std::env::remove_var("OPENVIKING_API_KEY");
        assert_eq!(bearer_token(), None);
        std::env::set_var("HMCODEX_OPENVIKING_API_KEY", "loopback-key");
        assert_eq!(bearer_token(), Some("loopback-key".to_string()));
        std::env::set_var("HMCODEX_OPENVIKING_API_KEY", " ");
        assert_eq!(bearer_token(), None);
        std::env::remove_var("HMCODEX_OPENVIKING_API_KEY");
    }
}
