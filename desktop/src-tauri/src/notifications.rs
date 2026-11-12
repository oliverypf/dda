//! Native Windows balloon notifications via Shell_NotifyIconW.
//!
//! Privacy rule: notification title/body are fixed strings chosen per kind.
//! Command text, paths, prompts and model errors never leave the app.
//! Clicking a balloon raises the window and emits
//! `desktop-notification-activated`; it never approves or executes anything.

use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};

const APPROVAL_TITLE: &str = "dda：需要你确认操作";
const APPROVAL_BODY: &str = "任务正在等待一次性审批。点击通知返回应用核对；不会自动批准。";
const COMPLETED_TITLE: &str = "dda：任务已完成";
const COMPLETED_BODY: &str = "任务已完成。点击通知返回应用查看结果。";
const FAILED_TITLE: &str = "dda：任务未完成";
const FAILED_BODY: &str = "任务停止或未通过验收。点击通知返回应用查看原因。";
const DEDUP_LIMIT: usize = 512;

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    #[serde(rename = "APPROVAL_REQUIRED")]
    ApprovalRequired,
    #[serde(rename = "TASK_COMPLETED")]
    TaskCompleted,
    #[serde(rename = "TASK_FAILED")]
    TaskFailed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNoticeRequest {
    pub kind: NoticeKind,
    pub run_id: String,
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeAck {
    pub accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Debug)]
struct NoticeTarget {
    kind_label: &'static str,
    run_id: String,
    request_id: Option<String>,
    title: &'static str,
    body: &'static str,
    warning: bool,
    dedup_key: String,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.is_ascii()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn validate(request: &DesktopNoticeRequest) -> Result<NoticeTarget, String> {
    if !valid_id(&request.run_id) {
        return Err("runId".to_string());
    }
    let (title, body, warning, kind_label) = match request.kind {
        NoticeKind::ApprovalRequired => (APPROVAL_TITLE, APPROVAL_BODY, true, "APPROVAL_REQUIRED"),
        NoticeKind::TaskCompleted => (COMPLETED_TITLE, COMPLETED_BODY, false, "TASK_COMPLETED"),
        NoticeKind::TaskFailed => (FAILED_TITLE, FAILED_BODY, true, "TASK_FAILED"),
    };
    let request_id = match &request.request_id {
        Some(value) => {
            if !valid_id(value) {
                return Err("requestId".to_string());
            }
            Some(value.clone())
        }
        None => None,
    };
    // Approval dedup is scoped to (run, request): the same request id must
    // notify again when it belongs to a different run.
    let dedup_key = match request.kind {
        NoticeKind::ApprovalRequired => {
            let id = request_id.clone().ok_or_else(|| "requestId".to_string())?;
            format!("approval:{}:{id}", request.run_id)
        }
        _ => format!("terminal:{}", request.run_id),
    };
    Ok(NoticeTarget { kind_label, run_id: request.run_id.clone(), request_id, title, body, warning, dedup_key })
}

struct Dedup {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl Dedup {
    fn new() -> Self {
        Self { seen: HashSet::new(), order: VecDeque::new() }
    }
    /// Returns true the first time a key is seen; evicts oldest past the cap.
    fn mark(&mut self, key: &str) -> bool {
        if !self.seen.insert(key.to_string()) {
            return false;
        }
        self.order.push_back(key.to_string());
        while self.order.len() > DEDUP_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        true
    }
}

#[derive(Default)]
struct NotifyState {
    dedup: Option<Dedup>,
    hwnd: isize,
    active_icon: u32,
    next_icon: u32,
    target: Option<(String, String, Option<String>)>,
}

static NOTIFY: LazyLock<Mutex<NotifyState>> = LazyLock::new(|| Mutex::new(NotifyState::default()));

/// Pure click-target check: only the currently registered icon id activates.
fn activation_target(state: &NotifyState, icon: u32) -> Option<(String, String, Option<String>)> {
    if state.active_icon == icon && icon != 0 {
        state.target.clone()
    } else {
        None
    }
}

/// Fill a fixed-size UTF-16 field, stopping at a char boundary so surrogate
/// pairs are never split and the value stays NUL-terminated.
fn bounded_utf16(text: &str, out: &mut [u16]) {
    out.fill(0);
    let mut used = 0usize;
    for ch in text.chars() {
        let mut buf = [0u16; 2];
        let len = ch.encode_utf16(&mut buf).len();
        if used + len >= out.len() {
            break;
        }
        out[used..used + len].copy_from_slice(&buf[..len]);
        used += len;
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use serde_json::json;
    use tauri::{AppHandle, Emitter, Manager};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{
        DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass, Shell_NotifyIconW, NIF_ICON,
        NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIIF_WARNING, NIM_ADD, NIM_DELETE, NIM_MODIFY,
        NIN_BALLOONUSERCLICK, NIN_BALLOONTIMEOUT, NOTIFYICONDATAW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        LoadIconW, IDI_APPLICATION, WM_APP, WM_LBUTTONDBLCLK, WM_LBUTTONUP, WM_NCDESTROY,
    };

    const WM_DDA_NOTIFY: u32 = WM_APP + 0x44;
    const SUBCLASS_ID: usize = 0xDDA1;

    struct SubclassCtx {
        app: AppHandle,
    }

    fn icon_data(hwnd: HWND, id: u32) -> NOTIFYICONDATAW {
        NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: id,
            ..Default::default()
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uidsubclass: usize,
        dwrefdata: usize,
    ) -> LRESULT {
        let ctx = &*(dwrefdata as *const SubclassCtx);
        match msg {
            WM_DDA_NOTIFY => {
                let icon = wparam.0 as u32;
                let code = (lparam.0 as u32) & 0xFFFF;
                let clicked = lparam.0 as u32 == NIN_BALLOONUSERCLICK
                    || code == NIN_BALLOONUSERCLICK
                    || code == WM_LBUTTONDBLCLK
                    || code == WM_LBUTTONUP;
                if clicked && code != NIN_BALLOONTIMEOUT {
                    let target = NOTIFY
                        .lock()
                        .ok()
                        .and_then(|state| activation_target(&state, icon));
                    if let Some((kind, run_id, request_id)) = target {
                        if let Some(window) = ctx.app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = window.request_user_attention(None);
                        }
                        let _ = ctx.app.emit(
                            "desktop-notification-activated",
                            json!({ "kind": kind, "runId": run_id, "requestId": request_id }),
                        );
                    }
                }
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
                if let Ok(mut state) = NOTIFY.lock() {
                    if state.active_icon != 0 {
                        let data = icon_data(hwnd, state.active_icon);
                        let _ = Shell_NotifyIconW(NIM_DELETE, &data);
                        state.active_icon = 0;
                    }
                    state.hwnd = 0;
                }
                let _ = Box::from_raw(dwrefdata as *mut SubclassCtx);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// Install the notification subclass on the main window. Failure is
    /// logged by the caller and never aborts startup.
    pub fn install(app: &tauri::App) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window missing".to_string())?;
        let hwnd = window.hwnd().map_err(|_| "main hwnd unavailable".to_string())?;
        let ctx = Box::new(SubclassCtx { app: app.handle().clone() });
        let raw = Box::into_raw(ctx) as usize;
        let ok = unsafe { SetWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID, raw) };
        if !ok.as_bool() {
            // The context was not adopted; reclaim it instead of leaking.
            let _ = unsafe { Box::from_raw(raw as *mut SubclassCtx) };
            return Err("SetWindowSubclass failed".to_string());
        }
        if let Ok(mut state) = NOTIFY.lock() {
            state.hwnd = hwnd.0 as isize;
            state.next_icon = 0;
        }
        Ok(())
    }

    /// Runs on the main event thread (serialized with the message pump), so
    /// icon allocate/add/modify can never interleave with a second request.
    /// Never holds the state lock across Shell or Tauri calls.
    pub fn show(target: &NoticeTarget) -> Result<(), String> {
        let (hwnd, previous, icon) = {
            let mut state = NOTIFY.lock().map_err(|_| "notification state poisoned")?;
            if state.hwnd == 0 {
                return Err("unavailable".to_string());
            }
            let previous = if state.active_icon != 0 { Some(state.active_icon) } else { None };
            let icon = state
                .next_icon
                .checked_add(1)
                .ok_or_else(|| "notification ids exhausted".to_string())?;
            state.next_icon = icon;
            state.active_icon = icon;
            state.target =
                Some((target.kind_label.to_string(), target.run_id.clone(), target.request_id.clone()));
            (HWND(state.hwnd as *mut _), previous, icon)
        };
        let cleanup_if_current = |hwnd: HWND, icon: u32| {
            unsafe {
                let data = icon_data(hwnd, icon);
                let _ = Shell_NotifyIconW(NIM_DELETE, &data);
            }
            if let Ok(mut state) = NOTIFY.lock() {
                if state.active_icon == icon {
                    state.active_icon = 0;
                    state.target = None;
                }
            }
        };
        unsafe {
            if let Some(old) = previous {
                let old_data = icon_data(hwnd, old);
                let _ = Shell_NotifyIconW(NIM_DELETE, &old_data);
            }
            let mut data = icon_data(hwnd, icon);
            data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
            data.uCallbackMessage = WM_DDA_NOTIFY;
            data.hIcon = LoadIconW(None, IDI_APPLICATION).unwrap_or_default();
            bounded_utf16("dda", &mut data.szTip);
            if !Shell_NotifyIconW(NIM_ADD, &data).as_bool() {
                cleanup_if_current(hwnd, icon);
                return Err("NIM_ADD failed".to_string());
            }
            data.uFlags |= NIF_INFO;
            bounded_utf16(target.title, &mut data.szInfoTitle);
            bounded_utf16(target.body, &mut data.szInfo);
            data.dwInfoFlags = if target.warning { NIIF_WARNING } else { NIIF_INFO };
            if !Shell_NotifyIconW(NIM_MODIFY, &data).as_bool() {
                cleanup_if_current(hwnd, icon);
                return Err("NIM_MODIFY failed".to_string());
            }
        }
        Ok(())
    }

    pub fn remove_active_icon() {
        let (hwnd, icon) = match NOTIFY.lock() {
            Ok(mut state) => {
                let icon = state.active_icon;
                state.active_icon = 0;
                (state.hwnd, icon)
            }
            Err(_) => return,
        };
        if hwnd != 0 && icon != 0 {
            unsafe {
                let data = icon_data(HWND(hwnd as *mut _), icon);
                let _ = Shell_NotifyIconW(NIM_DELETE, &data);
            }
        }
    }
}

/// Called from `setup` after the main window is verified. On non-Windows this
/// is a no-op; Windows failures must not fail startup.
pub fn initialize(app: &tauri::App) -> Result<(), String> {
    #[cfg(windows)]
    {
        return win::install(app);
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}

/// Remove the tray icon when the app shuts down (Windows only).
pub fn shutdown() {
    #[cfg(windows)]
    win::remove_active_icon();
}

#[tauri::command]
pub async fn show_desktop_notification(
    app: tauri::AppHandle,
    request: DesktopNoticeRequest,
) -> Result<NoticeAck, String> {
    let target = validate(&request)?;
    #[cfg(not(windows))]
    {
        let _ = app;
        return Ok(NoticeAck { accepted: false, reason: Some("unsupported".to_string()) });
    }
    #[cfg(windows)]
    {
        {
            let mut state = NOTIFY.lock().map_err(|_| "notification state poisoned")?;
            if state.hwnd == 0 {
                return Ok(NoticeAck { accepted: false, reason: Some("unavailable".to_string()) });
            }
            let dedup = state.dedup.get_or_insert_with(Dedup::new);
            if !dedup.mark(&target.dedup_key) {
                return Ok(NoticeAck { accepted: false, reason: Some("duplicate".to_string()) });
            }
        }
        // All Shell mutation happens on the main event thread. The command
        // waits for the outcome off-thread; a main-loop deadlock is impossible
        // because nothing here blocks the UI thread.
        let (tx, rx) = std::sync::mpsc::channel();
        let main_app = app.clone();
        use tauri::Manager;
        app.run_on_main_thread(move || {
            let result = win::show(&target);
            if let Some(window) = main_app.get_webview_window("main") {
                let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
            }
            let _ = tx.send(result);
        })
        .map_err(|_| "main thread dispatch failed".to_string())?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(5))
        })
        .await
        .map_err(|_| "notification task failed".to_string())?
        .map_err(|_| "notification timed out".to_string())?;
        result.map_err(|error| format!("notification show failed: {error}"))?;
        Ok(NoticeAck { accepted: true, reason: None })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: NoticeKind, run_id: &str, request_id: Option<&str>) -> DesktopNoticeRequest {
        DesktopNoticeRequest {
            kind,
            run_id: run_id.to_string(),
            request_id: request_id.map(str::to_string),
        }
    }

    #[test]
    fn validates_kinds_ids_and_required_request_id() {
        assert!(validate(&request(NoticeKind::ApprovalRequired, "run-1", Some("req-1"))).is_ok());
        assert_eq!(
            validate(&request(NoticeKind::ApprovalRequired, "run-1", None)).unwrap_err(),
            "requestId"
        );
        assert!(validate(&request(NoticeKind::TaskCompleted, "run-1", None)).is_ok());
        assert_eq!(validate(&request(NoticeKind::TaskFailed, "", None)).unwrap_err(), "runId");
        assert_eq!(
            validate(&request(NoticeKind::TaskCompleted, "run/../x", None)).unwrap_err(),
            "runId"
        );
        assert_eq!(
            validate(&request(NoticeKind::TaskFailed, &"a".repeat(161), None)).unwrap_err(),
            "runId"
        );
        assert_eq!(
            validate(&request(NoticeKind::TaskCompleted, "run-1", Some("bad id"))).unwrap_err(),
            "requestId"
        );
    }

    #[test]
    fn privacy_text_is_static_and_never_derived_from_input() {
        let target = validate(&request(NoticeKind::ApprovalRequired, "run-;evil", Some("req-1"))).unwrap_err();
        assert_eq!(target, "runId");
        let t = validate(&request(NoticeKind::TaskFailed, "run-9", None)).unwrap();
        assert_eq!(t.title, FAILED_TITLE);
        assert_eq!(t.body, FAILED_BODY);
        assert!(!FAILED_BODY.contains("run-9"));
    }

    #[test]
    fn dedup_fires_once_per_key_and_stays_bounded() {
        let mut dedup = Dedup::new();
        assert!(dedup.mark("approval:run-1:req-1"));
        assert!(!dedup.mark("approval:run-1:req-1"));
        assert!(dedup.mark("approval:run-2:req-1"));
        assert!(dedup.mark("terminal:run-1"));
        assert!(!dedup.mark("terminal:run-1"));
        for i in 0..600 {
            assert!(dedup.mark(&format!("k:{i}")));
        }
        assert!(dedup.order.len() <= DEDUP_LIMIT + 1);
    }

    #[test]
    fn approval_dedup_key_is_scoped_by_run() {
        let first = validate(&request(NoticeKind::ApprovalRequired, "run-1", Some("req-1"))).unwrap();
        let second = validate(&request(NoticeKind::ApprovalRequired, "run-2", Some("req-1"))).unwrap();
        assert_ne!(first.dedup_key, second.dedup_key);
        assert_eq!(first.dedup_key, "approval:run-1:req-1");
    }

    #[test]
    fn utf16_bounding_never_splits_surrogates() {
        let mut out = [0u16; 4];
        bounded_utf16("ab\u{1F600}cd", &mut out);
        // 'a','b' + surrogate pair needs 4 units; the pair must not be split.
        assert_eq!(&out, &[b'a' as u16, b'b' as u16, 0, 0]);
        let mut title = [0u16; 64];
        bounded_utf16(APPROVAL_TITLE, &mut title);
        assert!(title.iter().take_while(|u| **u != 0).count() < 64);
        let mut info = [0u16; 256];
        bounded_utf16(APPROVAL_BODY, &mut info);
        assert_eq!(info[255], 0);
        // Reuse clears stale tail content so the field stays NUL-terminated.
        bounded_utf16("x", &mut info);
        assert_eq!(&info[..2], &[b'x' as u16, 0]);
    }

    #[test]
    fn stale_icon_ids_never_activate() {
        let mut state = NotifyState::default();
        state.active_icon = 7;
        state.target = Some(("TASK_COMPLETED".into(), "run-1".into(), None));
        assert!(activation_target(&state, 7).is_some());
        assert!(activation_target(&state, 8).is_none());
        assert!(activation_target(&state, 0).is_none());
    }
}
