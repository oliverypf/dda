import { describe, expect, it } from 'vitest';
import { TaskSessionController, nextClientSessionId, type TaskSession } from './task-session';

const runningSession = (controller: TaskSessionController, workspace: string): TaskSession => {
  const session = controller.create({ workspacePath: workspace });
  session.running = true;
  return session;
};

describe('TaskSessionController', () => {
  it('starts with one selected draft session', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/work' });
    expect(controller.sessions.size).toBe(1);
    expect(controller.selected()?.workspacePath).toBe('C:/work');
    expect(controller.anyTaskRunning()).toBe(false);
  });

  it('keeps per-session run state isolated', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/a' });
    const a = controller.selected()!;
    const b = runningSession(controller, 'C:/b');
    b.lastRuntimeEventSequence = 9;
    b.activeRuntimeRunId = 'run-b';
    b.pendingApprovalResolutions.add('req-1');
    expect(a.lastRuntimeEventSequence).toBe(0);
    expect(a.activeRuntimeRunId).toBeUndefined();
    expect(a.pendingApprovalResolutions.size).toBe(0);
    expect(controller.anyTaskRunning()).toBe(true);
    b.running = false;
    expect(controller.anyTaskRunning()).toBe(false);
  });

  it('parks a running session and selects a clean draft without cancelling', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/a' });
    const a = controller.selected()!;
    a.running = true;
    a.promptDraft = 'unfinished a draft';
    const draft = controller.ensureDraftSession('C:/b', { promptDraft: 'b idea' });
    expect(controller.selectedId).toBe(draft.clientSessionId);
    expect(a.running).toBe(true);
    expect(a.promptDraft).toBe('unfinished a draft');
    expect(draft.promptDraft).toBe('b idea');
    expect(draft.workspacePath).toBe('C:/b');
    // switching back keeps both drafts intact
    controller.select(a.clientSessionId);
    expect(controller.selected()?.promptDraft).toBe('unfinished a draft');
  });

  it('binds runIds to exactly one owner and resolves sessions by id or run', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/a' });
    const a = controller.selected()!;
    const b = controller.create({ workspacePath: 'C:/b' });
    controller.bindRunId(a.clientSessionId, 'run-1');
    controller.bindRunId(b.clientSessionId, 'run-1'); // never rebinds
    expect(controller.forRunId('run-1')?.clientSessionId).toBe(a.clientSessionId);
    expect(controller.forRunId('run-2')).toBeUndefined();
    expect(controller.forClientSessionId('ui-nope')).toBeUndefined();
  });

  it('matches a session by direct or bound run thread', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/a' });
    const a = controller.selected()!;
    a.threadId = 'thread-a';
    const b = controller.create({ workspacePath: 'C:/b' });
    b.currentRunThreadId = 'thread-b';
    expect(controller.sessionForThread('thread-b')?.clientSessionId).toBe(b.clientSessionId);
    expect(controller.sessionForThread('thread-a')?.clientSessionId).toBe(a.clientSessionId);
    expect(controller.sessionForThread('thread-c')).toBeUndefined();
  });

  it('summaries list running and pending sessions including unbound starts', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/a' });
    const a = controller.selected()!;
    a.running = true;
    a.taskProgressMessage = '正在启动';
    const b = runningSession(controller, 'C:/b');
    b.model = { ...b.model, approvals: [{ requestId: 'r1', state: 'REQUESTED' } as never] };
    const summaries = controller.summaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.find((s) => s.clientSessionId === a.clientSessionId)?.running).toBe(true);
    expect(summaries.find((s) => s.clientSessionId === b.clientSessionId)?.pendingApprovals).toBe(1);
  });

  it('never removes a running session and reselects a draft when the selected one closes', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/a' });
    const a = controller.selected()!;
    const b = controller.create({ workspacePath: 'C:/b' });
    controller.bindRunId(b.clientSessionId, 'run-b');
    a.running = true;
    controller.remove(a.clientSessionId);
    expect(controller.sessions.has(a.clientSessionId)).toBe(true);
    controller.select(b.clientSessionId);
    controller.remove(b.clientSessionId);
    expect(controller.sessions.has(b.clientSessionId)).toBe(false);
    expect(controller.forRunId('run-b')).toBeUndefined();
    expect(controller.selectedId).toBe(a.clientSessionId);
  });

  it('prunes pristine drafts but keeps running, drafted, bound, or pending sessions', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/a' });
    const a = controller.selected()!;
    const keep = controller.ensureDraftSession('C:/b');

    const drafted = controller.create({ workspacePath: 'C:/c' });
    drafted.promptDraft = 'half typed';
    const running = runningSession(controller, 'C:/d');
    const bound = controller.create({ workspacePath: 'C:/e' });
    bound.threadId = 'thread-bound';
    const ran = controller.create({ workspacePath: 'C:/f' });
    ran.model = { ...ran.model, activeRun: { runId: 'run-f', state: 'COMPLETED', title: 'done' } as never };
    const pending = controller.create({ workspacePath: 'C:/g' });
    pending.model = { ...pending.model, approvals: [{ requestId: 'r1', state: 'REQUESTED' } as never] };
    const pristine = controller.create({ workspacePath: 'C:/h' });

    controller.pruneIdleDrafts(keep.clientSessionId);

    expect(controller.sessions.has(pristine.clientSessionId)).toBe(false);
    expect(controller.sessions.has(a.clientSessionId)).toBe(false);
    for (const session of [keep, drafted, running, bound, ran, pending]) {
      expect(controller.sessions.has(session.clientSessionId)).toBe(true);
    }
    expect(controller.selectedId).toBe(keep.clientSessionId);

    // A second prune with nothing pristine is a no-op.
    controller.pruneIdleDrafts(keep.clientSessionId);
    expect(controller.sessions.size).toBe(6);
  });

  it('generates unique non-empty client session ids', () => {
    expect(nextClientSessionId()).not.toBe(nextClientSessionId());
    expect(nextClientSessionId(0)).toMatch(/^ui-/u);
  });
});
