import { describe, expect, it } from 'vitest';
import { createInitialReadModel, setActiveThread, setThreads, setWorkspace } from './store';
import { deduplicateWorkspaceRoots, dropEphemeralProjectBookmarks, isEphemeralWorkspaceRoot, mainCheckoutForTaskWorktree, mergeProjectBookmarksByWorkspaceRoot, pruneAutoPollutedBookmarks, remapProjectArchiveIds, sameProjectWorkspace, sameWorkspaceRoot, workspaceRootForDisplay, workspaceThreadOptions } from './workspace';

describe('workspace root identity and display', () => {
  it('deduplicates Windows spellings while retaining the first native path and distinct folders', () => {
    expect(deduplicateWorkspaceRoots([
      '\\\\?\\C:\\Windows', 'C:\\Windows', 'c:/windows/', 'C:\\Windows\\System32', 'C:\\Windows-old', ''
    ])).toEqual(['\\\\?\\C:\\Windows', 'C:\\Windows\\System32', 'C:\\Windows-old']);
    expect(sameWorkspaceRoot('\\\\?\\C:\\Windows', 'C:\\Windows')).toBe(true);
  });

  it('deduplicates extended UNC roots and preserves case-sensitive POSIX folders', () => {
    expect(deduplicateWorkspaceRoots([
      '\\\\?\\UNC\\Server\\Share', '\\\\server\\share', '//SERVER/SHARE/', '/projects/A', '/projects/a'
    ])).toEqual(['\\\\?\\UNC\\Server\\Share', '/projects/A', '/projects/a']);
  });

  it('shows extended Windows and UNC paths in their ordinary form', () => {
    expect(workspaceRootForDisplay('\\\\?\\C:\\Windows')).toBe('C:\\Windows');
    expect(workspaceRootForDisplay('\\\\?\\UNC\\Server\\Share')).toBe('\\\\Server\\Share');
    expect(workspaceRootForDisplay('C:\\Windows')).toBe('C:\\Windows');
    expect(workspaceRootForDisplay('/projects/A')).toBe('/projects/A');
  });
});

describe('workspace thread options', () => {
  const thread = { id: 'saved', title: 'Saved task', cwd: 'C:\\demo', turnCount: 1, createdAtMs: 1, updatedAtMs: 2 };
  const model = setThreads(setWorkspace(createInitialReadModel(), 'demo', '', [], thread.cwd), [thread]);

  it('continues a thread in its own workspace and only resumes its own checkpoint', () => {
    expect(workspaceThreadOptions(setActiveThread(model, thread.id))).toEqual({ threadId: thread.id });
    expect(workspaceThreadOptions(setActiveThread(model, thread.id, true))).toEqual({ threadId: thread.id, resume: true });
    expect(workspaceThreadOptions({ ...setActiveThread(model, thread.id), resumeThreadId: 'other' })).toEqual({ threadId: thread.id });
  });

  it('resumes a thread whose last side effect is uncertain so the task continues', () => {
    const blocked = {
      ...thread,
      recoveryBlock: { reasonCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' as const, stepIds: ['inspect-build-config'] }
    };
    const blockedModel = setThreads(setWorkspace(createInitialReadModel(), 'demo', '', [], blocked.cwd), [blocked]);
    expect(workspaceThreadOptions(setActiveThread(blockedModel, blocked.id, true))).toEqual({ threadId: blocked.id, resume: true });
    expect(workspaceThreadOptions(setActiveThread(blockedModel, blocked.id))).toEqual({ threadId: blocked.id, resume: true });
  });

  it('does not reuse a historical thread or checkpoint selected in another workspace', () => {
    const switched = setWorkspace(model, 'other', '', [], 'C:\\other');
    expect(workspaceThreadOptions(setActiveThread(switched, thread.id, true))).toEqual({});
  });

  it('continues a thread when the current directory is a task worktree of its checkout', () => {
    const worktree = 'C:\\demo.worktrees\\session-1';
    const running = setWorkspace(model, 'demo', '', [], worktree);
    expect(sameProjectWorkspace(thread.cwd, worktree)).toBe(true);
    expect(sameProjectWorkspace('C:\\demo.worktrees\\session-1', 'C:\\demo.worktrees\\session-2')).toBe(true);
    expect(sameProjectWorkspace('C:\\demo\\desktop', 'C:\\demo')).toBe(false);
    expect(sameProjectWorkspace('C:\\other.worktrees\\session-1', thread.cwd)).toBe(false);
    expect(workspaceThreadOptions(setActiveThread(running, thread.id, true))).toEqual({ threadId: thread.id, resume: true });
  });

  it('does not attach unverified threads or workspaces', () => {
    expect(workspaceThreadOptions(model)).toEqual({});
    expect(workspaceThreadOptions(setActiveThread(model, 'unknown', true))).toEqual({});
    expect(workspaceThreadOptions(setActiveThread(setThreads(createInitialReadModel(), [thread]), thread.id))).toEqual({});
  });
});

describe('mergeProjectBookmarksByWorkspaceRoot', () => {
  it('merges bookmarks that share a workspace root and remaps the dropped id', () => {
    const { bookmarks, idRemap } = mergeProjectBookmarksByWorkspaceRoot([
      { id: 'project:c:\\a', name: 'A', path: 'C:\\A', paths: [], lastUsedAtMs: 10 },
      { id: 'project:dup', name: 'Dup', path: '\\\\?\\C:\\A', paths: [], lastUsedAtMs: 20 },
      { id: 'project:c:\\b', name: 'B', path: 'C:\\B', paths: [], lastUsedAtMs: 5 },
    ]);
    expect(bookmarks).toHaveLength(2);
    expect(bookmarks[0]).toMatchObject({ id: 'project:c:\\a', name: 'A', lastUsedAtMs: 20 });
    expect(deduplicateWorkspaceRoots(bookmarks[0]!.paths)).toEqual(expect.arrayContaining(['C:\\A']));
    expect(bookmarks[1]!.id).toBe('project:c:\\b');
    expect(idRemap).toEqual({ 'project:dup': 'project:c:\\a' });
  });

  it('keeps distinct workspace roots even when display leaf names match', () => {
    const { bookmarks, idRemap } = mergeProjectBookmarksByWorkspaceRoot([
      { id: 'one', name: 'hmCodex', path: 'C:\\work\\hmCodex', paths: [], lastUsedAtMs: 1 },
      { id: 'two', name: 'hmCodex', path: 'D:\\other\\hmCodex', paths: [], lastUsedAtMs: 2 },
    ]);
    expect(bookmarks).toHaveLength(2);
    expect(idRemap).toEqual({});
  });
});

describe('remapProjectArchiveIds', () => {
  it('keeps the survivor archived when a duplicate dropped id was archived', () => {
    const { bookmarks, idRemap } = mergeProjectBookmarksByWorkspaceRoot([
      { id: 'keep', name: 'A', path: 'C:\\A', paths: [], lastUsedAtMs: 1 },
      { id: 'drop', name: 'A-dup', path: 'c:/a/', paths: [], lastUsedAtMs: 2 },
    ]);
    expect(bookmarks).toHaveLength(1);
    expect(idRemap).toEqual({ drop: 'keep' });
    const { archives, changed } = remapProjectArchiveIds({
      drop: { name: 'A-dup', path: 'c:/a/', archivedAtMs: 100 },
    }, idRemap);
    expect(changed).toBe(true);
    expect(archives).toEqual({
      keep: { name: 'A-dup', path: 'c:/a/', archivedAtMs: 100 },
    });
    expect(Object.hasOwn(archives, 'drop')).toBe(false);
  });

  it('keeps a single archive row when both ids were archived', () => {
    const { archives } = remapProjectArchiveIds({
      keep: { name: 'A', path: 'C:\\A', archivedAtMs: 200 },
      drop: { name: 'A-dup', path: 'C:\\A', archivedAtMs: 50 },
    }, { drop: 'keep' });
    expect(archives).toEqual({
      keep: { name: 'A', path: 'C:\\A', archivedAtMs: 50 },
    });
  });
});

describe('ephemeral workspace filtering and auto-polluted bookmark cleanup', () => {
  it('identifies Cargo target, AppData staging/data, and Windows system directories as ephemeral', () => {
    expect(isEphemeralWorkspaceRoot('C:\\Users\\User\\hmCodex-local\\desktop\\src-tauri\\target\\x86_64-pc-windows-msvc\\release')).toBe(true);
    expect(isEphemeralWorkspaceRoot('C:\\Users\\User\\hmCodex-local\\desktop\\src-tauri\\target\\debug\\deps')).toBe(true);
    expect(isEphemeralWorkspaceRoot('C:\\Users\\User\\AppData\\Local\\Temp\\cursor-sandbox-cache\\abc\\cargo-target\\debug')).toBe(true);
    expect(isEphemeralWorkspaceRoot('C:\\Users\\User\\AppData\\Local\\hmCodex')).toBe(true);
    expect(isEphemeralWorkspaceRoot('C:\\Users\\User\\AppData\\Local\\dda\\desktop-builds\\build-123')).toBe(true);
    expect(isEphemeralWorkspaceRoot('\\\\?\\C:\\Users\\User\\AppData\\Local\\dda\\desktop-builds\\build-x86_64-pc-windows-msvc-xHVOii')).toBe(true);
    expect(isEphemeralWorkspaceRoot('D:\\stage\\desktop-builds\\build-x86_64-pc-windows-msvc-xHVOii')).toBe(true);
    expect(isEphemeralWorkspaceRoot('C:\\Windows\\System32')).toBe(true);
    expect(isEphemeralWorkspaceRoot('C:\\Users\\User\\hmCodex-local')).toBe(false);
    expect(isEphemeralWorkspaceRoot('C:\\fixture\\A')).toBe(false);
    expect(isEphemeralWorkspaceRoot('C:\\Users\\User\\hmCodex-local.worktrees\\session-1')).toBe(true);
  });

  it('maps a task worktree back to the main checkout', () => {
    expect(mainCheckoutForTaskWorktree('C:\\Users\\User\\hmCodex-local.worktrees\\session-1'))
      .toBe('C:\\Users\\User\\hmCodex-local');
    expect(mainCheckoutForTaskWorktree('C:/Users/User/hmCodex-local.worktrees/session-1'))
      .toBe('C:\\Users\\User\\hmCodex-local');
    expect(mainCheckoutForTaskWorktree('C:\\Users\\User\\hmCodex-local')).toBeUndefined();
  });

  it('drops ephemeral bookmarks even when a task cwd still points at them', () => {
    const { bookmarks: cleaned, removedIds } = dropEphemeralProjectBookmarks([
      { id: 'main', name: 'hmCodex-local', path: 'C:\\Users\\User\\hmCodex-local', paths: ['C:\\Users\\User\\hmCodex-local'], lastUsedAtMs: 3 },
      { id: 'build', name: 'build-x86_64-pc-windows-msvc-xHVOii', path: '\\\\?\\C:\\Users\\User\\AppData\\Local\\dda\\desktop-builds\\build-x86_64-pc-windows-msvc-xHVOii', paths: [], lastUsedAtMs: 2 },
      { id: 'worktree', name: 'ui-mwjb0mx8-2-lmvzzt', path: 'C:\\Users\\User\\hmCodex-local.worktrees\\ui-mwjb0mx8-2-lmvzzt', paths: [], lastUsedAtMs: 1 },
    ]);
    expect(cleaned.map((item) => item.id)).toEqual(['main']);
    expect(removedIds).toEqual(['build', 'worktree']);
  });

  it('prunes ephemeral bookmarks even with threads, and nested-desktop bookmarks only when they have none', () => {
    const bookmarks = [
      { id: 'main', name: 'hmCodex-local', path: 'C:\\Users\\User\\hmCodex-local', paths: ['C:\\Users\\User\\hmCodex-local'], lastUsedAtMs: 10 },
      { id: 'rel', name: 'release', path: 'C:\\Users\\User\\hmCodex-local\\desktop\\src-tauri\\target\\release', paths: [], lastUsedAtMs: 9 },
      { id: 'dbg', name: 'debug', path: 'C:\\Users\\User\\hmCodex-local\\desktop\\src-tauri\\target\\debug', paths: [], lastUsedAtMs: 8 },
      { id: 'deps', name: 'deps', path: 'C:\\Users\\User\\hmCodex-local\\desktop\\src-tauri\\target\\debug\\deps', paths: [], lastUsedAtMs: 7 },
      { id: 'appdata', name: 'hmCodex', path: 'C:\\Users\\User\\AppData\\Local\\hmCodex', paths: [], lastUsedAtMs: 6 },
      { id: 'win', name: 'Windows', path: 'C:\\Windows', paths: [], lastUsedAtMs: 5 },
      { id: 'sub-desktop', name: 'desktop', path: 'C:\\Users\\User\\hmCodex-local\\desktop', paths: [], lastUsedAtMs: 4 },
      { id: 'other-real', name: 'project-b', path: 'C:\\work\\project-b', paths: [], lastUsedAtMs: 3 },
      { id: 'ephemeral-with-thread', name: 'hmCodex', path: 'C:\\Users\\User\\AppData\\Local\\hmCodex\\saved', paths: [], lastUsedAtMs: 2 },
    ];
    const { bookmarks: cleaned, removedIds } = pruneAutoPollutedBookmarks(bookmarks, [
      'C:\\Users\\User\\hmCodex-local',
      'C:\\Users\\User\\AppData\\Local\\hmCodex\\saved',
    ]);
    expect(cleaned.map((b) => b.id)).toEqual(['main', 'other-real']);
    expect(removedIds).toEqual(['rel', 'dbg', 'deps', 'appdata', 'win', 'sub-desktop', 'ephemeral-with-thread']);
  });
});
