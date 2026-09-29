import { describe, expect, it } from 'vitest';
import { createInitialReadModel, setActiveThread, setThreads, setWorkspace } from './store';
import { workspaceThreadOptions } from './workspace';

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
