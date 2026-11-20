import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { canonicalWorkspacePath, workspacePathKey } from './platform/workspace-path.mjs';

const unquoteGitPath = (value) => {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('\\\\', '\\').replaceAll('\\"', '"');
  }
  return trimmed;
};

const gitOutput = (cwd, args) => {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
  } catch {
    return '';
  }
};

/**
 * `C:\repo.worktrees\session` belongs to `C:\repo`. Used only when the
 * directory is already gone, so a removed task worktree can still be
 * recognized as the checkout it was created from.
 */
export const taskWorktreePrimaryPath = (value) => {
  if (typeof value !== 'string') return '';
  const match = /^(.*[\\/])([^\\/]+)\.worktrees[\\/]([^\\/]+)((?:[\\/].*)?)$/iu.exec(value.trim().replace(/[\\/]+$/u, ''));
  if (!match || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u.test(value)) return '';
  return match[1] + match[2] + match[4];
};

/**
 * Resolve a managed task worktree to the checkout where the user started
 * it, retaining the relative package path. Manual worktrees are independent.
 */
export const linkedTaskWorktreePrimary = (value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (!existsSync(value)) {
    const parsed = taskWorktreePrimaryPath(value);
    return parsed && workspacePathKey(parsed) !== workspacePathKey(value) ? parsed : '';
  }
  const top = unquoteGitPath(gitOutput(value, ['rev-parse', '--show-toplevel']));
  const origin = taskWorktreePrimaryPath(top);
  if (!origin || !existsSync(origin)) return '';
  const branch = gitOutput(value, ['symbolic-ref', '--short', 'HEAD']).trim();
  if (!branch.startsWith('dda/')) return '';
  const checkouts = gitOutput(value, ['worktree', 'list', '--porcelain']).split(/\r?\n/u)
    .filter(line => line.startsWith('worktree ')).map(line => unquoteGitPath(line.slice(9)));
  if (!checkouts.some(path => workspacePathKey(path) === workspacePathKey(origin))) return '';
  const prefix = gitOutput(value, ['rev-parse', '--show-prefix']).trim();
  return prefix ? join(origin, prefix) : origin;
};

export const sameThreadWorkspace = (threadCwd, workspaceRoot) => {
  if (typeof threadCwd !== 'string' || typeof workspaceRoot !== 'string') return false;
  if (!threadCwd.trim() || !workspaceRoot.trim()) return false;
  if (workspacePathKey(threadCwd) === workspacePathKey(workspaceRoot)) return true;
  const threadPrimary = linkedTaskWorktreePrimary(threadCwd);
  const workspacePrimary = linkedTaskWorktreePrimary(workspaceRoot);
  if (!threadPrimary && !workspacePrimary) return false;
  return workspacePathKey(threadPrimary || threadCwd) === workspacePathKey(workspacePrimary || workspaceRoot);
};

/** Durable thread cwd: the checkout the user opened, not an ephemeral task worktree. */
export const threadHomeForWorkspace = (workspaceRoot) => {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) return typeof workspaceRoot === 'string' ? workspaceRoot : '';
  const primary = linkedTaskWorktreePrimary(workspaceRoot);
  if (!primary) return workspaceRoot;
  return canonicalWorkspacePath(primary) || primary;
};
