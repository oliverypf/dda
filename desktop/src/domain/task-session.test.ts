import { describe, expect, it } from 'vitest';
import { TaskSessionController, newestTaskFirst, nextClientSessionId, sessionStatusText, sessionStillExecuting, sessionThreadActivity, type TaskSession } from './task-session';

const runningSession = (controller: TaskSessionController, workspace: string): TaskSession => {
  const session = controller.create({ workspacePath: workspace });
  session.running = true;
  return session;
};

describe('session status after cancel', () => {
  const label = (state: string): string => (state === 'CANCELLED' ? '已取消' : state);

  it('lets a finished run replace leftover progress while the bridge lock is still held', () => {
    const progress = '已完成 23 次工具调用，尚未记录成功的受控文件写入';
    expect(sessionStatusText(true, progress, 'CANCELLED', label)).toBe('已取消');
    expect(sessionThreadActivity(true, progress, 'CANCELLED', label)).toBe('已取消');
    expect(sessionStillExecuting(true, 'CANCELLED')).toBe(false);
  });

  it('keeps progress text while the run has not finished', () => {
    expect(sessionStatusText(true, '正在读取工作区', 'EXECUTING', label)).toBe('正在读取工作区');
    expect(sessionThreadActivity(true, '', 'EXECUTING', label)).toBe('进行中');
    expect(sessionStillExecuting(true, 'EXECUTING')).toBe(true);
    expect(sessionStatusText(false, '', undefined, label)).toBe('待发送');
  });
});

describe('newestTaskFirst', () => {
  it('keeps creation order when timestamps tie or are missing', () => {
    const ordered = newestTaskFirst([
      { createdAtMs: 1, sortId: 'thread:b', name: 'b' },
      { createdAtMs: 2, sortId: 'thread:c', name: 'c' },
      { createdAtMs: 2, sortId: 'thread:a', name: 'a' },
      { createdAtMs: Number.NaN, sortId: 'session:z', name: 'z' }
    ]);
    expect(ordered.map((item) => item.name)).toEqual(['a', 'c', 'b', 'z']);
  });
});

describe('TaskSessionController', () => {
  it('keeps an unbound choice on the next draft', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/repo' });
    const parked = controller.selected()!;
    parked.unboundProject = true;
    const draft = controller.ensureDraftSession('', { unboundProject: true });
    expect(draft.clientSessionId).not.toBe(parked.clientSessionId);
    expect(draft.unboundProject).toBe(true);
    expect(draft.workspacePath).toBe('');
    expect(controller.selected()?.unboundProject).toBe(true);
  });

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

  it('keeps each session composer model across selection and does not copy it onto a new draft', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/a' });
    const a = controller.selected()!;
    a.composerModelId = 'model-a';
    const b = controller.create({ workspacePath: 'C:/b', composerModelId: ' model-b ' });
    expect(b.composerModelId).toBe('model-b');
    controller.select(b.clientSessionId);
    expect(controller.selected()?.composerModelId).toBe('model-b');
    controller.select(a.clientSessionId);
    expect(controller.selected()?.composerModelId).toBe('model-a');
    const draft = controller.ensureDraftSession('C:/c');
    expect(draft.composerModelId).toBeUndefined();
    expect(a.composerModelId).toBe('model-a');
  });

  it('moves a settled conversation onto its stored session id', () => {
    const controller = new TaskSessionController({ workspacePath: 'C:/a' });
    const draft = controller.selected()!;
    const fromId = draft.clientSessionId;
    controller.bindRunId(fromId, 'run-1');
    const moved = controller.adoptId(fromId, 'ui-session-1');
    expect(moved?.clientSessionId).toBe('ui-session-1');
    expect(controller.selectedId).toBe('ui-session-1');
    expect(controller.forRunId('run-1')?.clientSessionId).toBe('ui-session-1');
    expect(controller.sessions.has(fromId)).toBe(false);
    const running = runningSession(controller, 'C:/b');
    expect(controller.adoptId(running.clientSessionId, 'ui-session-2')).toBe(running);
    expect(running.clientSessionId).not.toBe('ui-session-2');
  });

  it('generates unique non-empty client session ids', () => {
    expect(nextClientSessionId()).not.toBe(nextClientSessionId());
    expect(nextClientSessionId(0)).toMatch(/^ui-/u);
  });
});
