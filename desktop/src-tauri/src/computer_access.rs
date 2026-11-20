//! Global machine-user access mode (`computer-access.json`). Host is the only
//! writer; the runtime reader re-reads per request. Fail-closed on every
//! malformed input — a broken file can never enable FULL_ACCESS.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE_NAME: &str = "computer-access.json";
const MAX_BYTES: u64 = 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyFile {
    version: u32,
    scope: String,
    mode: String,
    #[serde(rename = "updatedAtMs")]
    updated_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessStatus {
    pub mode: String,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
}

static LOCK: Mutex<()> = Mutex::new(());

fn policy_path() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("APPDATA"))
        .ok_or_else(|| "LOCALAPPDATA unavailable".to_string())?;
    Ok(Path::new(&base).join("hmCodex").join(FILE_NAME))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn status(mode: &str, updated_at_ms: Option<u64>) -> AccessStatus {
    AccessStatus { mode: mode.to_string(), scope: "USER_FILESYSTEM".to_string(), updated_at_ms }
}

/// Load the persisted mode from an explicit path. Any invalid input is
/// REQUIRE_APPROVAL — there is no error channel to the user here.
fn load_at(path: &Path) -> AccessStatus {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return status("REQUIRE_APPROVAL", None),
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_BYTES {
        return status("REQUIRE_APPROVAL", None);
    }
    let raw = match fs::read_to_string(path) { Ok(r) => r, Err(_) => return status("REQUIRE_APPROVAL", None) };
    let doc: PolicyFile = match serde_json::from_str(&raw) { Ok(d) => d, Err(_) => return status("REQUIRE_APPROVAL", None) };
    if doc.version != 1 || doc.scope != "USER_FILESYSTEM" {
        return status("REQUIRE_APPROVAL", None);
    }
    match doc.mode.as_str() {
        "FULL_ACCESS" => status("FULL_ACCESS", Some(doc.updated_at_ms)),
        "REQUIRE_APPROVAL" => status("REQUIRE_APPROVAL", Some(doc.updated_at_ms)),
        _ => status("REQUIRE_APPROVAL", None),
    }
}

/// Atomic save to an explicit path (tempdir-isolated for tests).
fn save_at(path: &Path, doc: &PolicyFile) -> Result<(), String> {
    let parent = path.parent().ok_or("policy parent missing")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    tmp.write_all(serde_json::to_string(doc).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
    tmp.flush().map_err(|e| e.to_string())?;
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

pub fn access_mode() -> AccessStatus {
    match policy_path() {
        Ok(path) => load_at(&path),
        Err(_) => status("REQUIRE_APPROVAL", None),
    }
}

fn set_at(path: &Path, mode: &str, confirmed: bool) -> Result<AccessStatus, String> {
    if mode != "FULL_ACCESS" && mode != "REQUIRE_APPROVAL" {
        return Err("invalid mode".to_string());
    }
    if mode == "FULL_ACCESS" && !confirmed {
        return Err("FULL_ACCESS requires explicit confirmation".to_string());
    }
    let updated_at_ms = now_ms();
    let doc = PolicyFile { version: 1, scope: "USER_FILESYSTEM".to_string(), mode: mode.to_string(), updated_at_ms };
    save_at(path, &doc)?;
    Ok(status(mode, Some(updated_at_ms)))
}

pub fn set_access_mode(mode: &str, confirmed: bool) -> Result<AccessStatus, String> {
    let _guard = LOCK.lock().map_err(|_| "lock poisoned".to_string())?;
    let path = policy_path()?;
    set_at(&path, mode, confirmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The freshly built unsigned test binary is denied writes under %TEMP% on
    // this host (endpoint policy); anchor isolated dirs under the crate dir.
    fn dir() -> tempfile::TempDir {
        tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap()
    }

    #[test]
    fn missing_corrupt_and_bad_schema_fail_closed() {
        let dir = dir();
        let file = dir.path().join(FILE_NAME);
        assert_eq!(load_at(&file).mode, "REQUIRE_APPROVAL");
        fs::write(&file, "not-json").unwrap();
        assert_eq!(load_at(&file).mode, "REQUIRE_APPROVAL");
        fs::write(&file, r#"{"version":9,"scope":"USER_FILESYSTEM","mode":"FULL_ACCESS","updatedAtMs":1}"#).unwrap();
        assert_eq!(load_at(&file).mode, "REQUIRE_APPROVAL");
        fs::write(&file, r#"{"version":1,"scope":"MACHINE","mode":"FULL_ACCESS","updatedAtMs":1}"#).unwrap();
        assert_eq!(load_at(&file).mode, "REQUIRE_APPROVAL");
        fs::write(&file, r#"{"version":1,"scope":"USER_FILESYSTEM","mode":"FULL_ACCESS","updatedAtMs":1,"extra":true}"#).unwrap();
        assert_eq!(load_at(&file).mode, "REQUIRE_APPROVAL");
        fs::write(&file, r#"{"version":1,"scope":"USER_FILESYSTEM","mode":"BANANA","updatedAtMs":1}"#).unwrap();
        assert_eq!(load_at(&file).mode, "REQUIRE_APPROVAL");
    }

    #[test]
    fn save_load_roundtrip_and_revoke() {
        let dir = dir();
        let file = dir.path().join(FILE_NAME);
        let doc = PolicyFile { version: 1, scope: "USER_FILESYSTEM".into(), mode: "FULL_ACCESS".into(), updated_at_ms: 42 };
        save_at(&file, &doc).unwrap();
        let loaded = load_at(&file);
        assert_eq!(loaded.mode, "FULL_ACCESS");
        assert_eq!(loaded.updated_at_ms, Some(42));
        let off = PolicyFile { version: 1, scope: "USER_FILESYSTEM".into(), mode: "REQUIRE_APPROVAL".into(), updated_at_ms: 43 };
        save_at(&file, &off).unwrap();
        assert_eq!(load_at(&file).mode, "REQUIRE_APPROVAL");
    }

    #[test]
    fn unconfirmed_full_rejected_without_writing() {
        let dir = dir();
        let file = dir.path().join(FILE_NAME);
        assert!(set_at(&file, "FULL_ACCESS", false).is_err());
        assert!(!file.exists(), "unconfirmed enable must not persist");
        let off = set_at(&file, "REQUIRE_APPROVAL", false).unwrap();
        assert_eq!(off.mode, "REQUIRE_APPROVAL");
        assert!(file.exists(), "off may persist without confirmation");
        let on = set_at(&file, "FULL_ACCESS", true).unwrap();
        assert_eq!(on.mode, "FULL_ACCESS");
        assert_eq!(load_at(&file).mode, "FULL_ACCESS");
    }

    #[test]
    fn oversized_file_denied() {
        let dir = dir();
        let file = dir.path().join(FILE_NAME);
        fs::write(&file, "x".repeat((MAX_BYTES + 1) as usize)).unwrap();
        assert_eq!(load_at(&file).mode, "REQUIRE_APPROVAL");
    }
}
