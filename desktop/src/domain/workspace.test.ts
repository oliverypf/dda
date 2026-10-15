import { describe, expect, it } from 'vitest';
import { createInitialReadModel, setActiveThread, setThreads, setWorkspace } from './store';
import { deduplicateWorkspaceRoots, mergeProjectBookmarksByWorkspaceRoot, remapProjectArchiveIds, sameWorkspaceRoot, workspaceRootForDisplay, workspaceThreadOptions } from './workspace';

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

  it('does not reuse a historical thread or checkpoint selected in another workspace', () => {
    const switched = setWorkspace(model, 'other', '', [], 'C:\\other');
    expect(workspaceThreadOptions(setActiveThread(switched, thread.id, true))).toEqual({});
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
