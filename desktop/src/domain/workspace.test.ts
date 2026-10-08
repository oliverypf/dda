import { describe, expect, it } from 'vitest';
import { createInitialReadModel, setActiveThread, setThreads, setWorkspace } from './store';
import { deduplicateWorkspaceRoots, sameWorkspaceRoot, workspaceRootForDisplay, workspaceThreadOptions } from './workspace';

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
