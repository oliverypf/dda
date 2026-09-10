use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Windows GUI 程序派生控制台子进程时必须隐藏新控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;

const DEFAULT_URL: &str = "http://127.0.0.1:1933";
const DEFAULT_START_TIMEOUT_MS: u64 = 30_000;
const PROBE_TIMEOUT_MS: u64 = 1_000;
const START_POLL_MS: u64 = 250;
const MAX_HEALTH_BYTES: u64 = 64 * 1024;

#[derive(Clone, Default)]
pub struct OpenVikingSidecarState {
    child: Arc<Mutex<Option<Child>>>,
    started_at_ms: Arc<Mutex<Option<u64>>>,
    last_error_code: Arc<Mutex<Option<String>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenVikingSidecarStatus {
    pub enabled: bool,
    pub state: &'static str,
    pub managed: bool,
    pub running: bool,
    pub ready: bool,
    pub pid: Option<u32>,
    pub started_at_ms: Option<u64>,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LocalEndpoint {
    host: String,
    port: u16,
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn enabled() -> bool {
    if let Ok(value) = std::env::var("HMCODEX_CONTEXT_PROVIDER") {
        return value.trim().eq_ignore_ascii_case("openviking");
    }
    std::env::current_exe()
        .ok()
        .and_then(|executable| {
            executable.parent().map(|parent| {
                [
                    parent.join("sidecar").join("openviking-server.exe"),
                    parent.join("openviking-server.exe"),
                ]
            })
        })
        .is_some_and(|candidates| candidates.iter().any(|candidate| candidate.is_file()))
}

fn parse_endpoint(value: &str) -> Result<LocalEndpoint, &'static str> {
    let parsed = Url::parse(value).map_err(|_| "OPENVIKING_SIDECAR_URL_INVALID")?;
    let host = parsed
        .host_str()
        .ok_or("OPENVIKING_SIDECAR_URL_INVALID")?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if parsed.scheme() != "http"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || !matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1")
    {
        return Err("OPENVIKING_SIDECAR_URL_INVALID");
    }
    Ok(LocalEndpoint {
        host: if host == "localhost" {
            "127.0.0.1".to_string()
        } else {
            host
        },
        port: parsed
            .port_or_known_default()
            .ok_or("OPENVIKING_SIDECAR_URL_INVALID")?,
    })
}

fn configured_endpoint() -> Result<LocalEndpoint, &'static str> {
    parse_endpoint(
        std::env::var("HMCODEX_OPENVIKING_URL")
            .as_deref()
            .unwrap_or(DEFAULT_URL),
    )
}

fn configured_start_timeout_ms() -> u64 {
    std::env::var("HMCODEX_OPENVIKING_START_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (1_000..=120_000).contains(value))
        .unwrap_or(DEFAULT_START_TIMEOUT_MS)
}

fn random_api_key() -> Result<String, &'static str> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| "OPENVIKING_SIDECAR_STATE_UNAVAILABLE")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn probe_ready(endpoint: &LocalEndpoint) -> bool {
    let Ok(addresses) = (endpoint.host.as_str(), endpoint.port).to_socket_addrs() else {
        return false;
    };
    for address in addresses.filter(|address| address.ip().is_loopback()) {
        let Ok(mut stream) =
            TcpStream::connect_timeout(&address, Duration::from_millis(PROBE_TIMEOUT_MS))
        else {
            continue;
        };
        let timeout = Some(Duration::from_millis(PROBE_TIMEOUT_MS));
        if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
            continue;
        }
        let host_header = if endpoint.host.contains(':') {
            format!("[{}]:{}", endpoint.host, endpoint.port)
        } else {
            format!("{}:{}", endpoint.host, endpoint.port)
        };
        let request = format!(
            "GET /ready HTTP/1.1\r\nHost: {host_header}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        if stream.write_all(request.as_bytes()).is_err() {
            continue;
        }
        let mut bytes = Vec::new();
        if stream
            .take(MAX_HEALTH_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_HEALTH_BYTES
        {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        let Some((headers, body)) = text.split_once("\r\n\r\n") else {
            continue;
        };
        if !headers
            .lines()
            .next()
            .is_some_and(|line| line.split_whitespace().nth(1) == Some("200"))
        {
            continue;
        }
        if serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|value| {
                value
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            == Some("ok")
        {
            return true;
        }
    }
    false
}

fn reap_owned_process(state: &OpenVikingSidecarState) -> (bool, Option<u32>) {
    let Ok(mut child) = state.child.lock() else {
        return (false, None);
    };
    let Some(process) = child.as_mut() else {
        return (false, None);
    };
    match process.try_wait() {
        Ok(None) => (true, Some(process.id())),
        Ok(Some(_)) | Err(_) => {
            *child = None;
            if let Ok(mut started) = state.started_at_ms.lock() {
                *started = None;
            }
            if let Ok(mut error) = state.last_error_code.lock() {
                *error = Some("OPENVIKING_SIDECAR_EXITED".to_string());
            }
            (false, None)
        }
    }
}

pub fn sidecar_status(state: &OpenVikingSidecarState) -> OpenVikingSidecarStatus {
    if !enabled() {
        return OpenVikingSidecarStatus {
            enabled: false,
            state: "DISABLED",
            managed: false,
            running: false,
            ready: false,
            pid: None,
            started_at_ms: None,
            error_code: None,
        };
    }
    let endpoint = match configured_endpoint() {
        Ok(endpoint) => endpoint,
        Err(code) => {
            return OpenVikingSidecarStatus {
                enabled: true,
                state: "MISCONFIGURED",
                managed: false,
                running: false,
                ready: false,
                pid: None,
                started_at_ms: None,
                error_code: Some(code.to_string()),
            };
        }
    };
    let (running, pid) = reap_owned_process(state);
    let ready = probe_ready(&endpoint);
    let started_at_ms = state.started_at_ms.lock().ok().and_then(|value| *value);
    let error_code = state
        .last_error_code
        .lock()
        .ok()
        .and_then(|value| value.clone());
    let current_state = if ready {
        if running {
            "READY"
        } else {
            "EXTERNAL"
        }
    } else if running {
        if started_at_ms.is_some_and(|started| {
            unix_time_ms().saturating_sub(started) > configured_start_timeout_ms()
        }) {
            "DEGRADED"
        } else {
            "STARTING"
        }
    } else if error_code.is_some() {
        "DEGRADED"
    } else {
        "UNAVAILABLE"
    };
    OpenVikingSidecarStatus {
        enabled: true,
        state: current_state,
        managed: running,
        running: running || ready,
        ready,
        pid,
        started_at_ms,
        error_code: if ready { None } else { error_code },
    }
}

fn default_executable_candidates(runtime_entrypoint: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join("sidecar").join("openviking-server.exe"));
            candidates.push(parent.join("openviking-server.exe"));
        }
    }
    if let Some(runtime_root) = runtime_entrypoint.parent().and_then(Path::parent) {
        if let Some(resource_root) = runtime_root.parent() {
            candidates.push(resource_root.join("sidecar").join("openviking-server.exe"));
            candidates.push(resource_root.join("openviking-server.exe"));
        }
    }
    candidates
}

fn default_config_candidates(runtime_entrypoint: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(runtime_root) = runtime_entrypoint.parent().and_then(Path::parent) {
        candidates.push(runtime_root.join("openviking").join("config.json"));
        if let Some(resource_root) = runtime_root.parent() {
            candidates.push(
                resource_root
                    .join("runtime")
                    .join("openviking")
                    .join("config.json"),
            );
        }
    }
    candidates
}

fn bundled_executable(runtime_entrypoint: &Path) -> Option<PathBuf> {
    default_executable_candidates(runtime_entrypoint)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn configure_bundled_environment(runtime_entrypoint: &Path) {
    if std::env::var_os("HMCODEX_OPENVIKING_EXECUTABLE").is_none() {
        if let Some(executable) = bundled_executable(runtime_entrypoint) {
            std::env::set_var("HMCODEX_OPENVIKING_EXECUTABLE", executable);
        }
    }
    if std::env::var_os("HMCODEX_OPENVIKING_CONFIG").is_none() {
        if let Some(config) = default_config_candidates(runtime_entrypoint)
            .into_iter()
            .find(|candidate| candidate.is_file())
        {
            std::env::set_var("HMCODEX_OPENVIKING_CONFIG", config);
        }
    }
    if std::env::var_os("HMCODEX_OPENVIKING_WORKING_DIR").is_none() {
        if let Some(parent) = std::env::var_os("HMCODEX_OPENVIKING_EXECUTABLE")
            .map(PathBuf::from)
            .as_ref()
            .and_then(|path| path.parent())
        {
            std::env::set_var("HMCODEX_OPENVIKING_WORKING_DIR", parent);
        }
    }
    if let Some(existing_key) = std::env::var_os("OPENVIKING_API_KEY") {
        if std::env::var_os("HMCODEX_OPENVIKING_API_KEY").is_none() {
            std::env::set_var("HMCODEX_OPENVIKING_API_KEY", existing_key);
        }
    }
    if std::env::var_os("HMCODEX_OPENVIKING_API_KEY").is_none() {
        if let Ok(generated_key) = random_api_key() {
            std::env::set_var("HMCODEX_OPENVIKING_API_KEY", generated_key);
        }
    }
    if std::env::var_os("HMCODEX_OPENVIKING_API_KEY_ENV").is_none() {
        std::env::set_var(
            "HMCODEX_OPENVIKING_API_KEY_ENV",
            "HMCODEX_OPENVIKING_API_KEY",
        );
    }
}

fn validate_executable() -> Result<PathBuf, &'static str> {
    let path = std::env::var_os("HMCODEX_OPENVIKING_EXECUTABLE")
        .map(PathBuf::from)
        .ok_or("OPENVIKING_SIDECAR_NOT_CONFIGURED")?;
    if !path.is_absolute()
        || !path.is_file()
        || path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| !value.eq_ignore_ascii_case("exe"))
            .unwrap_or(true)
    {
        return Err("OPENVIKING_SIDECAR_EXECUTABLE_INVALID");
    }
    Ok(path)
}

fn set_error(state: &OpenVikingSidecarState, code: &str) {
    if let Ok(mut error) = state.last_error_code.lock() {
        *error = Some(code.to_string());
    }
}

pub fn ensure_sidecar(
    runtime_entrypoint: &Path,
    state: &OpenVikingSidecarState,
) -> OpenVikingSidecarStatus {
    configure_bundled_environment(runtime_entrypoint);
    if std::env::var("HMCODEX_CONTEXT_PROVIDER").is_err()
        && bundled_executable(runtime_entrypoint).is_some()
    {
        std::env::set_var("HMCODEX_CONTEXT_PROVIDER", "openviking");
    }
    let initial = sidecar_status(state);
    if !initial.enabled || initial.ready || initial.state == "MISCONFIGURED" {
        return initial;
    }
    if !initial.managed {
        if let Err(code) = validate_executable() {
            set_error(state, code);
            return sidecar_status(state);
        }
        let supervisor = runtime_entrypoint.with_file_name("openviking-sidecar-supervisor.mjs");
        if !supervisor.is_file() {
            set_error(state, "OPENVIKING_SIDECAR_SUPERVISOR_MISSING");
            return sidecar_status(state);
        }
        let mut command =
            Command::new(std::env::var_os("HMCODEX_NODE").unwrap_or_else(|| "node".into()));
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .arg(&supervisor)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(runtime_root) = runtime_entrypoint.parent().and_then(Path::parent) {
            command.current_dir(runtime_root);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        match command.spawn() {
            Ok(child) => {
                if let Ok(mut slot) = state.child.lock() {
                    *slot = Some(child);
                } else {
                    set_error(state, "OPENVIKING_SIDECAR_STATE_UNAVAILABLE");
                    return sidecar_status(state);
                }
                if let Ok(mut started) = state.started_at_ms.lock() {
                    *started = Some(unix_time_ms());
                }
                if let Ok(mut error) = state.last_error_code.lock() {
                    *error = None;
                }
            }
            Err(_) => {
                set_error(state, "OPENVIKING_SIDECAR_START_FAILED");
                return sidecar_status(state);
            }
        }
    }
    let attempts = configured_start_timeout_ms().saturating_add(START_POLL_MS - 1) / START_POLL_MS;
    for _ in 0..attempts {
        let status = sidecar_status(state);
        if status.ready || !status.managed {
            return status;
        }
        std::thread::sleep(Duration::from_millis(START_POLL_MS));
    }
    set_error(state, "OPENVIKING_SIDECAR_START_TIMEOUT");
    sidecar_status(state)
}

pub fn stop_sidecar(state: &OpenVikingSidecarState) {
    let child = state.child.lock().ok().and_then(|mut slot| slot.take());
    let Some(mut child) = child else {
        return;
    };
    let pid = child.id().to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    let _ = child.kill();
    let _ = child.kill();
    let _ = child.wait();
    if let Ok(mut started) = state.started_at_ms.lock() {
        *started = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_bounded_hex_api_keys() {
        let key = random_api_key().unwrap();
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|character| character.is_ascii_hexdigit()));
    }
    use std::io::Write;
    use std::net::TcpListener;

    #[test]
    fn parses_only_loopback_http_endpoints() {
        assert_eq!(
            parse_endpoint("http://localhost:1933").unwrap(),
            LocalEndpoint {
                host: "127.0.0.1".to_string(),
                port: 1933
            }
        );
        assert_eq!(
            parse_endpoint("http://[::1]:8000/").unwrap(),
            LocalEndpoint {
                host: "::1".to_string(),
                port: 8000
            }
        );
        assert!(parse_endpoint("https://127.0.0.1:1933").is_err());
        assert!(parse_endpoint("http://example.com:1933").is_err());
        assert!(parse_endpoint("http://127.0.0.1:1933/api").is_err());
    }

    #[test]
    fn probes_a_bounded_ready_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 512];
            let _ = stream.read(&mut request);
            let body = r#"{"status":"ok","result":{"ready":true}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        assert!(probe_ready(&LocalEndpoint {
            host: "127.0.0.1".to_string(),
            port: address.port()
        }));
        server.join().unwrap();
    }
}
