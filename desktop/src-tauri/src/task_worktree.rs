//! Give a second concurrent task its own git worktree so it does not share
//! the workspace lease of a task already running in the same directory.
//! The first task keeps the checkout the user opened. A worktree with no
//! edits and no new commits is removed when that task exits.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskWorktree {
    pub path: PathBuf,
    pub workspace: PathBuf,
    pub branch: String,
    pub primary: PathBuf,
    pub base_commit: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WorktreeDisposition {
    Removed,
    Kept { reason: String },
}

pub fn directory_key(path: &Path) -> Option<String> {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut text = canonical.to_string_lossy().replace('/', "\\");
    if let Some(rest) = text.strip_prefix("\\\\?\\UNC\\") {
        text = format!("\\\\{rest}");
    } else if let Some(rest) = text.strip_prefix("\\\\?\\") {
        text = rest.to_string();
    }
    let text = text.trim_end_matches('\\').to_string();
    if text.is_empty() {
        return None;
    }
    Some(if cfg!(windows) { text.to_lowercase() } else { text })
}

pub fn directory_is_occupied(requested: &Path, occupied: &[PathBuf]) -> bool {
    let Some(requested_key) = directory_key(requested) else {
        return false;
    };
    occupied.iter().any(|path| directory_key(path).as_deref() == Some(requested_key.as_str()))
}

pub fn allocate_worktree(requested: &Path, session_id: &str) -> Result<TaskWorktree, String> {
    let inside = git(requested, &["rev-parse", "--is-inside-work-tree"]).unwrap_or_default();
    if inside.trim() != "true" {
        return Err("这个目录已有任务在运行，而且它不是 git 工作区，无法另开 worktree。请等当前任务结束。".to_string());
    }
    let base_commit = git(requested, &["rev-parse", "HEAD"])
        .map_err(|_| "这个 git 仓库还没有提交，无法为并行任务创建 worktree。请等当前任务结束，或先提交一次。".to_string())?;
    let base_commit = base_commit.trim().to_string();
    if base_commit.is_empty() {
        return Err("这个 git 仓库还没有提交，无法为并行任务创建 worktree。请等当前任务结束，或先提交一次。".to_string());
    }
    let primary = primary_worktree(requested)?;
    let branch = unique_branch(&primary, session_id)?;
    let checkout = PathBuf::from(git(requested, &["rev-parse", "--show-toplevel"])?);
    let prefix = git(requested, &["rev-parse", "--show-prefix"])?;
    let path = unique_destination(&checkout, session_id);
    let workspace = path.join(prefix);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建 worktree 目录: {error}"))?;
    }
    git(&primary, &["worktree", "add", "-b", &branch, &path.to_string_lossy(), &base_commit])
        .map_err(|error| format!("无法创建 worktree: {error}"))?;
    let worktree = TaskWorktree { path, workspace, branch, primary, base_commit };
    if !worktree.workspace.is_dir() {
        release_worktree_if_unchanged(&worktree);
        return Err("所选子目录不存在于当前提交，无法创建并行工作区。".into());
    }
    Ok(worktree)
}

pub fn release_worktree_if_unchanged(worktree: &TaskWorktree) -> WorktreeDisposition {
    let branch_ref = format!("refs/heads/{}", worktree.branch);
    if git(&worktree.path, &["symbolic-ref", "-q", "HEAD"]).as_deref() != Ok(branch_ref.as_str()) {
        return WorktreeDisposition::Kept { reason: "工作树已移动或切换分支，保留原分支".into() };
    }
    let status = match git(&worktree.path, &["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]) {
        Ok(value) => value,
        Err(error) => return WorktreeDisposition::Kept { reason: format!("无法检查 worktree 状态: {error}") },
    };
    if !status.trim().is_empty() {
        return WorktreeDisposition::Kept { reason: "worktree 里有未提交的改动".to_string() };
    }
    let head = match git(&worktree.path, &["rev-parse", "HEAD"]) {
        Ok(value) => value.trim().to_string(),
        Err(error) => return WorktreeDisposition::Kept { reason: format!("无法读取 worktree 提交: {error}") },
    };
    if head != worktree.base_commit {
        return WorktreeDisposition::Kept { reason: "worktree 上有新的提交".to_string() };
    }
    if let Err(error) = git(&worktree.primary, &["worktree", "remove", &worktree.path.to_string_lossy()]) {
        return WorktreeDisposition::Kept { reason: format!("无法移除 worktree: {error}") };
    }
    if let Err(error) = git(&worktree.primary, &["update-ref", "-d", &branch_ref, &worktree.base_commit]) {
        return WorktreeDisposition::Kept { reason: format!("无法删除原分支: {error}") };
    }
    WorktreeDisposition::Removed
}

fn primary_worktree(repo: &Path) -> Result<PathBuf, String> {
    let listing = git(repo, &["worktree", "list", "--porcelain"])?;
    let path = listing.lines().find_map(|line| line.strip_prefix("worktree "))
        .map(unquote_git_path)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "无法定位主工作区，不能创建 worktree。".to_string())?;
    Ok(PathBuf::from(path))
}

fn unique_branch(primary: &Path, session_id: &str) -> Result<String, String> {
    let base = format!("dda/{}", sanitize_id(session_id));
    let mut candidate = base.clone();
    for _ in 0..8 {
        let exists = git(primary, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{candidate}")]);
        if exists.is_err() {
            return Ok(candidate);
        }
        candidate = format!("{base}-{}", unix_millis());
    }
    Err("无法分配 worktree 分支名。".to_string())
}

fn unique_destination(primary: &Path, session_id: &str) -> PathBuf {
    let repo_name = primary.file_name().and_then(|name| name.to_str()).unwrap_or("workspace");
    let parent = primary.parent().unwrap_or(primary);
    let root = parent.join(format!("{repo_name}.worktrees"));
    let mut path = root.join(sanitize_id(session_id));
    if path.exists() {
        path = root.join(format!("{}-{}", sanitize_id(session_id), unix_millis()));
    }
    path
}

fn sanitize_id(value: &str) -> String {
    let mut safe: String = value.chars().map(|ch| {
        if ch.is_ascii_alphanumeric() || ch == '-' { ch } else { '-' }
    }).take(48).collect();
    while safe.starts_with('-') {
        safe.remove(0);
    }
    while safe.ends_with('-') || safe.ends_with('.') {
        safe.pop();
    }
    if safe.is_empty() { "task".to_string() } else { safe }
}

fn unquote_git_path(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        trimmed[1..trimmed.len() - 1].replace("\\\\", "\\")
    } else {
        trimmed.to_string()
    }
}

fn unix_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or(0)
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-c").arg("core.quotepath=false");
    command.args(args);
    command.current_dir(cwd);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|error| format!("无法运行 git: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.trim();
    let detail = if detail.chars().count() > 400 {
        detail.chars().take(400).collect::<String>()
    } else {
        detail.to_string()
    };
    Err(if detail.is_empty() { format!("git 退出码 {}", output.status) } else { detail })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git_ok(cwd: &Path, args: &[&str]) {
        git(cwd, args).unwrap_or_else(|error| panic!("git {} failed: {error}", args.join(" ")));
    }

    fn temp_repo(name: &str) -> PathBuf {
        let nanos = unix_millis();
        let root = std::env::temp_dir().join(format!("dda-worktree-{name}-{nanos}"));
        fs::create_dir_all(&root).unwrap();
        git_ok(&root, &["init", "-b", "main"]);
        git_ok(&root, &["config", "user.email", "dda-test@example.com"]);
        git_ok(&root, &["config", "user.name", "dda test"]);
        fs::write(root.join("readme.txt"), "hello\n").unwrap();
        git_ok(&root, &["add", "readme.txt"]);
        git_ok(&root, &["commit", "-m", "init"]);
        root
    }

    #[test]
    fn an_idle_directory_is_not_occupied() {
        let root = temp_repo("idle");
        assert!(!directory_is_occupied(&root, &[]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_same_directory_is_occupied_regardless_of_slash_and_case() {
        let root = temp_repo("same");
        let other = PathBuf::from(root.to_string_lossy().replace('\\', "/"));
        assert!(directory_is_occupied(&root, &[other]));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_busy_checkout_gets_its_own_worktree_and_a_clean_one_is_removed() {
        let root = temp_repo("alloc");
        let worktree = allocate_worktree(&root, "session/busy").expect("worktree");
        assert_ne!(directory_key(&worktree.path), directory_key(&root));
        assert!(worktree.path.join("readme.txt").is_file());
        assert_eq!(worktree.branch, "dda/session-busy");
        assert!(directory_is_occupied(&root, &[root.clone()]));
        assert!(!directory_is_occupied(&worktree.path, &[root.clone()]));
        assert_eq!(release_worktree_if_unchanged(&worktree), WorktreeDisposition::Removed);
        assert!(!worktree.path.exists());
        if let Some(parent) = worktree.path.parent() {
            let _ = fs::remove_dir_all(parent);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn task_keeps_the_selected_subdirectory() {
        let root = temp_repo("package");
        let package = root.join("package");
        fs::create_dir(&package).unwrap();
        fs::write(package.join("app.txt"), "a").unwrap();
        git_ok(&root, &["add", "package/app.txt"]);
        git_ok(&root, &["commit", "-m", "package"]);
        let w = allocate_worktree(&package, "nested").unwrap();
        assert!(w.workspace.join("app.txt").is_file());
        assert!(!w.workspace.join("readme.txt").exists());
        assert_eq!(release_worktree_if_unchanged(&w), WorktreeDisposition::Removed);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn switching_away_from_a_task_commit_preserves_its_branch() {
        let root = temp_repo("switched");
        let w = allocate_worktree(&root, "detached").unwrap();
        git_ok(&w.path, &["commit", "--allow-empty", "-m", "task result"]);
        let tip = git(&w.path, &["rev-parse", "HEAD"]).unwrap();
        git_ok(&w.path, &["switch", "--detach", &w.base_commit]);
        assert!(matches!(release_worktree_if_unchanged(&w), WorktreeDisposition::Kept { .. }));
        assert_eq!(git(&root, &["rev-parse", &w.branch]).unwrap(), tip);
        git_ok(&root, &["worktree", "remove", &w.path.to_string_lossy()]);
        assert!(matches!(release_worktree_if_unchanged(&w), WorktreeDisposition::Kept { .. }));
        assert_eq!(git(&root, &["rev-parse", &w.branch]).unwrap(), tip);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_worktree_with_edits_is_kept() {
        let root = temp_repo("dirty");
        let worktree = allocate_worktree(&root, "session-dirty").expect("worktree");
        fs::write(worktree.path.join("note.txt"), "keep\n").unwrap();
        match release_worktree_if_unchanged(&worktree) {
            WorktreeDisposition::Kept { reason } => assert!(reason.contains("未提交")),
            WorktreeDisposition::Removed => panic!("dirty worktree was removed"),
        }
        assert!(worktree.path.join("note.txt").is_file());
        git_ok(&worktree.primary, &["worktree", "remove", "--force", &worktree.path.to_string_lossy()]);
        git_ok(&worktree.primary, &["branch", "-D", &worktree.branch]);
        let _ = fs::remove_dir_all(&root);
    }
}
