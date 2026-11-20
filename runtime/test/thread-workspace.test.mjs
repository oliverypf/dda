import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspacePathKey } from '../src/platform/workspace-path.mjs';
import { linkedTaskWorktreePrimary, sameThreadWorkspace, taskWorktreePrimaryPath, threadHomeForWorkspace } from '../src/thread-workspace.mjs';

const git = (cwd, args) => {
  execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
};

const tempRepo = (name) => {
  const root = mkdtempSync(join(tmpdir(), `hmcodex-thread-ws-${name}-`));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'dda-test@example.com']);
  git(root, ['config', 'user.name', 'dda test']);
  writeFileSync(join(root, 'readme.txt'), 'hello\n');
  git(root, ['add', 'readme.txt']);
  git(root, ['commit', '-m', 'init']);
  return root;
};

test('a linked task worktree is the same thread workspace as its checkout', () => {
  const root = tempRepo('same');
  const worktree = join(dirname(root), `${root.split(/[\\/]/u).at(-1)}.worktrees`, 'session-1');
  mkdirSync(dirname(worktree), { recursive: true });
  git(root, ['worktree', 'add', '-b', 'dda/session-1', worktree, 'HEAD']);
  try {
    assert.equal(workspacePathKey(linkedTaskWorktreePrimary(worktree)), workspacePathKey(root));
    assert.equal(linkedTaskWorktreePrimary(root), '');
    assert.equal(sameThreadWorkspace(root, worktree), true);
    assert.equal(sameThreadWorkspace(worktree, root), true);
    assert.equal(workspacePathKey(threadHomeForWorkspace(worktree)), workspacePathKey(root));
    assert.equal(sameThreadWorkspace(join(root, 'readme-dir'), worktree), false);
    mkdirSync(join(root, 'nested'));
    assert.equal(sameThreadWorkspace(root, join(root, 'nested')), false);
  } finally {
    try { git(root, ['worktree', 'remove', '--force', worktree]); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(worktree), { recursive: true, force: true });
  }
});

test('a worktree of another repository stays a mismatch', () => {
  const home = tempRepo('home');
  const other = tempRepo('other');
  const worktree = join(dirname(other), `${other.split(/[\\/]/u).at(-1)}.worktrees`, 'session-2');
  mkdirSync(dirname(worktree), { recursive: true });
  git(other, ['worktree', 'add', '-b', 'dda/session-2', worktree, 'HEAD']);
  try {
    assert.equal(sameThreadWorkspace(home, worktree), false);
    assert.equal(sameThreadWorkspace(home, other), false);
  } finally {
    try { git(other, ['worktree', 'remove', '--force', worktree]); } catch { /* already gone */ }
    rmSync(home, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    rmSync(dirname(worktree), { recursive: true, force: true });
  }
});

test('a removed task worktree path still belongs to its checkout, and a lookalike folder does not', () => {
  const root = tempRepo('gone');
  const removed = join(dirname(root), `${root.split(/[\\/]/u).at(-1)}.worktrees`, 'session-gone');
  const lookalike = join(dirname(root), `${root.split(/[\\/]/u).at(-1)}.worktrees`, 'not-git');
  mkdirSync(lookalike, { recursive: true });
  try {
    assert.equal(workspacePathKey(taskWorktreePrimaryPath(removed)), workspacePathKey(root));
    assert.equal(sameThreadWorkspace(removed, root), true);
    assert.equal(sameThreadWorkspace(root, lookalike), false);
    assert.equal(sameThreadWorkspace('C:\\Windows', root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dirname(lookalike), { recursive: true, force: true });
  }
});

test('manual feature worktrees retain their own durable thread identity', () => {
  const root = tempRepo('manual');
  const feature = root + '-feature';
  git(root, ['worktree', 'add', '-b', 'feature', feature]);
  try {
    assert.equal(threadHomeForWorkspace(feature), feature);
    assert.equal(sameThreadWorkspace(root, feature), false);
  } finally {
    git(root, ['worktree', 'remove', feature]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('deleted workspace mapping preserves the absolute root and package directory', () => {
  assert.equal(taskWorktreePrimaryPath('/home/dev/repo.worktrees/job/pkg'), '/home/dev/repo/pkg');
  assert.equal(taskWorktreePrimaryPath('/home/dev/repo.worktrees/job/../sibling'), '');
  assert.equal(taskWorktreePrimaryPath('\\\\server\\share\\repo.worktrees\\job\\pkg'), '\\\\server\\share\\repo\\pkg');
});
