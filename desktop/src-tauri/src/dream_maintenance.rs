use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Windows GUI 程序派生控制台子进程时必须隐藏新控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const DEFAULT_INTERVAL_MS: u64 = 15 * 60 * 1000;
const DEFAULT_FAILURE_LIMIT: u32 = 3;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamMaintenanceStatus {
    pub enabled: bool,
    pub state: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub project_id: Option<String>,
    pub interval_ms: u64,
    pub failure_limit: u32,
    pub started_at_ms: Option<u64>,
    pub last_event_at_ms: Option<u64>,
    pub cycle_count: u64,
    pub consecutive_failures: u32,
    pub last_error_code: Option<String>,
}

impl Default for DreamMaintenanceStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            state: "DISABLED".to_string(),
            running: false,
            pid: None,
            project_id: None,
            interval_ms: DEFAULT_INTERVAL_MS,
            failure_limit: DEFAULT_FAILURE_LIMIT,
            started_at_ms: None,
            last_event_at_ms: None,
            cycle_count: 0,
            consecutive_failures: 0,
            last_error_code: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct DreamMaintenanceState {
    status: Arc<Mutex<DreamMaintenanceStatus>>,
}

#[derive(Debug, Deserialize)]
struct DreamMaintenanceEvent {
    state: Option<String>,
    cycle: Option<u64>,
    started_at_ms: Option<u64>,
    finished_at_ms: Option<u64>,
    consecutive_failures: Option<u32>,
    error_code: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn emit_status(app: &AppHandle, status: DreamMaintenanceStatus) {
    let _ = app.emit("dream-maintenance-status", status);
}

fn with_status<F>(
    state: &DreamMaintenanceState,
    app: &AppHandle,
    mutate: F,
) -> DreamMaintenanceStatus
where
    F: FnOnce(&mut DreamMaintenanceStatus),
{
    let snapshot = if let Ok(mut status) = state.status.lock() {
        mutate(&mut status);
        status.clone()
    } else {
        DreamMaintenanceStatus {
            enabled: true,
            state: "FAILED".to_string(),
            last_error_code: Some("DREAM_MAINTENANCE_STATE_UNAVAILABLE".to_string()),
            ..DreamMaintenanceStatus::default()
        }
    };
    emit_status(app, snapshot.clone());
    snapshot
}

pub fn status(state: &DreamMaintenanceState) -> DreamMaintenanceStatus {
    state
        .status
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| DreamMaintenanceStatus {
            enabled: true,
            state: "FAILED".to_string(),
            last_error_code: Some("DREAM_MAINTENANCE_STATE_UNAVAILABLE".to_string()),
            ..DreamMaintenanceStatus::default()
        })
}

fn write_active_runs(path: &Path, active_runs: &Arc<dyn Fn() -> u32 + Send + Sync>) {
    let value = active_runs().min(1024);
    let temporary = path.with_extension("tmp");
    if fs::write(&temporary, format!("{value}\n")).is_err() {
        return;
    }
    #[cfg(windows)]
    {
        let _ = fs::remove_file(path);
    }
    let _ = fs::rename(&temporary, path);
}

fn monitor_active_runs(
    path: PathBuf,
    stop: Arc<Mutex<bool>>,
    active_runs: Arc<dyn Fn() -> u32 + Send + Sync>,
) {
    loop {
        let should_stop = stop.lock().map(|value| *value).unwrap_or(true);
        if should_stop {
            break;
        }
        write_active_runs(&path, &active_runs);
        thread::sleep(Duration::from_millis(250));
    }
    let _ = fs::remove_file(path);
}

fn apply_event(state: &DreamMaintenanceState, app: &AppHandle, event: DreamMaintenanceEvent) {
    let _ = with_status(state, app, |status| {
        if let Some(value) = event.state {
            status.state = value;
        }
        if let Some(cycle) = event.cycle {
            status.cycle_count = cycle;
        }
        if let Some(started_at_ms) = event.started_at_ms {
            status.started_at_ms = Some(started_at_ms);
        }
        status.last_event_at_ms = event.finished_at_ms.or_else(|| Some(now_ms()));
        if let Some(failures) = event.consecutive_failures {
            status.consecutive_failures = failures;
        }
        if event.error_code.is_some() {
            status.last_error_code = event.error_code;
        }
    });
}

fn consume_stdout(
    state: DreamMaintenanceState,
    app: AppHandle,
    stdout: impl std::io::Read + Send + 'static,
) {
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("dream_maintenance") {
            continue;
        }
        if let Ok(event) = serde_json::from_value::<DreamMaintenanceEvent>(value) {
            apply_event(&state, &app, event);
        }
    }
}

fn consume_stderr(stderr: impl std::io::Read + Send + 'static) {
    let _ = thread::spawn(move || {
        for _line in BufReader::new(stderr).lines() {
            // Drain stderr so a failing daemon cannot block on a full pipe.
        }
    });
}

pub fn start(
    app: &AppHandle,
    state: &DreamMaintenanceState,
    runtime: &Path,
    project_id: String,
    interval_ms: u64,
    failure_limit: u32,
    active_runs_file: PathBuf,
    active_runs: Arc<dyn Fn() -> u32 + Send + Sync>,
) -> Result<DreamMaintenanceStatus, String> {
    let current = status(state);
    if current.running || current.pid.is_some() {
        return Err("Dream maintenance 已在运行".to_string());
    }
    if let Some(parent) = active_runs_file.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 Dream 状态目录: {error}"))?;
    }
    write_active_runs(&active_runs_file, &active_runs);
    let mut command =
        Command::new(std::env::var_os("HMCODEX_NODE").unwrap_or_else(|| "node".into()));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.env("HMCODEX_RELEASE_CHANNEL", crate::desktop_release_channel()?);
    if let Some(parent) = runtime.parent().and_then(Path::parent) {
        command.current_dir(parent);
    }
    command
        .arg(runtime)
        .arg("dream")
        .arg("--operation")
        .arg("daemon")
        .arg("--project-id")
        .arg(&project_id)
        .arg("--interval-ms")
        .arg(interval_ms.to_string())
        .arg("--failure-limit")
        .arg(failure_limit.to_string())
        .arg("--active-runs-file")
        .arg(&active_runs_file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Dream maintenance: {error}"))?;
    let pid = child.id();
    let started_at_ms = now_ms();
    let snapshot = with_status(state, app, |status| {
        status.enabled = true;
        status.state = "RUNNING".to_string();
        status.running = true;
        status.pid = Some(pid);
        status.project_id = Some(project_id);
        status.interval_ms = interval_ms;
        status.failure_limit = failure_limit;
        status.started_at_ms = Some(started_at_ms);
        status.last_event_at_ms = Some(started_at_ms);
        status.cycle_count = 0;
        status.consecutive_failures = 0;
        status.last_error_code = None;
    });

    if let Some(stdout) = child.stdout.take() {
        let reader_state = state.clone();
        let reader_app = app.clone();
        thread::spawn(move || consume_stdout(reader_state, reader_app, stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        consume_stderr(stderr);
    }

    let monitor_state = state.clone();
    let monitor_app = app.clone();
    let monitor_path = active_runs_file.clone();
    let active_stop = Arc::new(Mutex::new(false));
    let active_stop_for_thread = active_stop.clone();
    thread::spawn(move || monitor_active_runs(monitor_path, active_stop_for_thread, active_runs));
    thread::spawn(move || {
        let result = child.wait();
        if let Ok(mut value) = active_stop.lock() {
            *value = true;
        }
        let success = result.map(|status| status.success()).unwrap_or(false);
        let _ = with_status(&monitor_state, &monitor_app, |status| {
            let was_stopping = status.state == "STOPPING";
            status.running = false;
            status.pid = None;
            status.last_event_at_ms = Some(now_ms());
            status.state = if success || was_stopping {
                "STOPPED".to_string()
            } else {
                status.last_error_code = Some("DREAM_MAINTENANCE_PROCESS_EXITED".to_string());
                "FAILED".to_string()
            };
        });
        let _ = fs::remove_file(&active_runs_file);
    });
    Ok(snapshot)
}

pub fn stop(
    app: &AppHandle,
    state: &DreamMaintenanceState,
) -> Result<DreamMaintenanceStatus, String> {
    let current = status(state);
    let Some(pid) = current.pid else {
        return Ok(current);
    };
    let snapshot = with_status(state, app, |status| {
        status.state = "STOPPING".to_string();
        status.last_event_at_ms = Some(now_ms());
    });
    terminate_process_tree(pid)?;
    Ok(snapshot)
}

fn terminate_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|error| format!("无法终止 Dream maintenance: {error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            let lower = detail.to_ascii_lowercase();
            if !lower.contains("not found") && !lower.contains("no running instance") {
                return Err("无法终止 Dream maintenance 进程".to_string());
            }
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let status = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|error| format!("无法终止 Dream maintenance: {error}"))?;
        if !status.success() {
            return Err("无法终止 Dream maintenance 进程".to_string());
        }
        Ok(())
    }
}
