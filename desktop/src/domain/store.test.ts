import { describe, expect, it } from 'vitest';
import {
  applyRuntimeSubAgentEvent,
  beginRun,
  cancelPendingApprovals,
  expireRequestedApprovals,
  completeStreamingAgent,
  completeStreamingResponses,
  streamingResponseItemId,
  createInitialReadModel,
  setActiveThread,
  setThreads,
  setRunState,
  setRuntimeReady,
  setContextSidecarStatus,
  setDreamMaintenanceStatus,
  shouldAutoStartDreamMaintenance,
  setWorkspace,
  setWorkspaceFile,
  upsertStreamingAgent,
  discardStreamingTail,
  upsertSubAgent
} from './store';
import type { RuntimeEvent } from './models';

describe('HarnessReadModel store', () => {
  it('expires requests at the deadline without changing approved or undated records', () => {
    const request = { requestId: 'timed', capability: 'shell.execute', requestDigest: 'digest', state: 'REQUESTED' as const, createdAtMs: 1, approvalExpiresAt: 100 };
    const model = { ...createInitialReadModel(), approvals: [request, { ...request, requestId: 'approved', state: 'APPROVED' as const }, { ...request, requestId: 'undated', approvalExpiresAt: undefined }] };
    expect(expireRequestedApprovals(model, 99)).toBe(model);
    const expired = expireRequestedApprovals(model, 100);
    expect(expired.approvals.map(item => item.state)).toEqual(['EXPIRED', 'APPROVED', 'REQUESTED']);
    expect(expired.projectionVersion).toBeGreaterThan(model.projectionVersion);
    expect(expireRequestedApprovals(expired, 101)).toBe(expired);
    expect(model.approvals[0].state).toBe('REQUESTED');
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED'] as const)('removes pending approval actions on terminal state %s', (state) => {
    const model = { ...beginRun(createInitialReadModel(), 'task'), approvals: [{ requestId: 'pending', capability: 'shell.execute', requestDigest: 'digest', state: 'REQUESTED' as const, createdAtMs: 1 }] };
    expect(setRunState(model, state).approvals[0].state).toBe('CANCELLED');
    expect(setRunState(model, 'VERIFYING').approvals[0].state).toBe('REQUESTED');
  });
  it('starts a fresh task when the workspace root changes without deleting saved threads', () => {
    const thread = { id: 'thread-old', title: 'Saved task', cwd: 'C:\\projects\\old', turnCount: 1, createdAtMs: 1, updatedAtMs: 2 };
    let model = setWorkspace(createInitialReadModel(), 'old', '', [], thread.cwd);
    model = setActiveThread(setThreads(model, [thread]), thread.id, true);
    model = setWorkspaceFile(beginRun(model, 'old workspace task'), {
      relativePath: 'README.md', content: 'old file', contentDigest: 'sha256:old', totalBytes: 8, truncated: false, binary: false
    });
    const switched = setWorkspace(model, 'new', '', [], 'C:\\projects\\new');
    expect(switched.activeThreadId).toBeUndefined();
    expect(switched.resumeThreadId).toBeUndefined();
    expect(switched.activeRun).toBeUndefined();
    expect(switched.timeline).toEqual([]);
    expect(switched.subAgents).toEqual([]);
    expect(switched.approvals).toEqual([]);
    expect(switched.decisions).toEqual([]);
    expect(switched.processVerification).toBeUndefined();
    expect(switched.continuousVerification).toEqual([]);
    expect(switched.workspace.selectedFile).toBeUndefined();
    expect(switched.threads).toEqual([thread]);
    expect(model.activeThreadId).toBe(thread.id);
  });

  it.each([
    ['C:\\', 'c:/'],
    ['C:\\Projects\\Demo', 'c:/projects/demo/'],
    ['\\\\?\\C:\\Projects\\Demo', 'C:\\Projects\\Demo'],
    ['\\\\?\\UNC\\Server\\Share\\Demo', '\\\\server\\share\\demo\\'],
    ['/projects/demo', '/projects/demo/']
  ])('keeps the thread when reopening the same root: %s -> %s', (current, selected) => {
    let model = setWorkspace(createInitialReadModel(), 'demo', '', [], current);
    model = setActiveThread(model, 'thread-same', true);
    const reopened = setWorkspace(model, 'demo', '', [], selected);
    expect(reopened.activeThreadId).toBe('thread-same');
    expect(reopened.resumeThreadId).toBe('thread-same');
  });

  it.each([
    ['C:\\first\\demo', 'C:\\second\\demo'],
    ['/projects/Demo', '/projects/demo']
  ])('does not equate different roots with the same label: %s -> %s', (current, selected) => {
    const model = setActiveThread(setWorkspace(createInitialReadModel(), 'demo', '', [], current), 'thread-old', true);
    expect(setWorkspace(model, 'demo', '', [], selected).activeThreadId).toBeUndefined();
  });

  it('checks a restored thread cwd before the first workspace grant', () => {
    const thread = { id: 'restored', title: 'Restored task', cwd: 'C:\\old', turnCount: 1, createdAtMs: 1, updatedAtMs: 2 };
    const model = setActiveThread(setThreads(createInitialReadModel(), [thread]), thread.id, true);
    expect(setWorkspace(model, 'new', '', [], 'C:\\new').activeThreadId).toBeUndefined();
    expect(setWorkspace(model, 'old', '', [], 'C:\\old').activeThreadId).toBe(thread.id);
  });

  it('keeps the thread and checkpoint when browsing workspace subdirectories', () => {
    const model = setActiveThread(setWorkspace(createInitialReadModel(), 'demo', '', [], 'C:\\demo'), 'thread-same', true);
    const nested = setWorkspace(model, 'demo', 'src/components', []);
    expect(nested.activeThreadId).toBe('thread-same');
    expect(nested.resumeThreadId).toBe('thread-same');
    expect(nested.workspace.rootPath).toBe('C:\\demo');
  });

  it('does not discard a viewed historical thread when only navigating workspace entries', () => {
    const thread = { id: 'history', title: 'History', cwd: 'C:\\old', turnCount: 1, createdAtMs: 1, updatedAtMs: 2 };
    const model = setActiveThread(setThreads(setWorkspace(createInitialReadModel(), 'new', '', [], 'C:\\new'), [thread]), thread.id);
    expect(setWorkspace(model, 'new', 'src', []).activeThreadId).toBe(thread.id);
    expect(setWorkspace(model, 'new', '', [], 'C:\\new').activeThreadId).toBeUndefined();
  });

  it('retains runtime ownership while updating streaming content', () => {
    let model = upsertStreamingAgent(createInitialReadModel(), 'response', 'first', false, 'runtime-run');
    model = upsertStreamingAgent(model, 'response', ' second', true);
    const item = model.timeline.find((entry) => entry.itemId === 'response');
    expect(item?.runId).toBe('runtime-run');
    expect(item?.body).toBe('first second');
    expect(item?.status).toBe('COMPLETE');
  });

  it('keeps each model round in its own bubble and finishes the previous one before the next', () => {
    let model = upsertStreamingAgent(createInitialReadModel(), streamingResponseItemId('run', 1), '先看工作区。', false, 'run');
    model = completeStreamingResponses(model, 'run');
    model = upsertStreamingAgent(model, streamingResponseItemId('run', 2), '再改一处。', false, 'run');
    const replies = model.timeline.filter((entry) => entry.runId === 'run' && entry.kind === 'AGENT' && !entry.thinking);
    expect(replies.map((entry) => entry.body)).toEqual(['先看工作区。', '再改一处。']);
    expect(replies[0]?.status).toBe('COMPLETE');
    expect(replies[1]?.status).toBe('STREAMING');
  });

  it('discardStreamingTail keeps earlier rounds and ignores COMPLETE bubbles', () => {
    let model = upsertStreamingAgent(createInitialReadModel(), 'run-response', '第一轮。', false, 'run');
    model = upsertStreamingAgent(model, 'run-response', '半截失败', false, 'run');
    model = discardStreamingTail(model, 'run-response', '半截失败'.length);
    expect(model.timeline.find((entry) => entry.itemId === 'run-response')?.body).toBe('第一轮。');
    model = upsertStreamingAgent(model, 'run-response', '第二轮。', true, 'run');
    const before = model.timeline.find((entry) => entry.itemId === 'run-response')?.body;
    model = discardStreamingTail(model, 'run-response', 3);
    expect(model.timeline.find((entry) => entry.itemId === 'run-response')?.body).toBe(before);
    expect(model.timeline.find((entry) => entry.itemId === 'run-response')?.status).toBe('COMPLETE');
  });
  it('projects legacy runtime capabilities without restoring a retired execution mode', () => {
    const selected = createInitialReadModel();
    expect(selected.composer.mode).toBe('CONTROLLED');
    const connected = setRuntimeReady(selected, {
      platform: 'WINDOWS', version: '0.1.0', readOnly: true, workspaceRead: true,
      commandExecution: false, networkSideEffects: false,
      releaseChannel: 'WINDOWS_PHASE1_READ_ONLY'
    });
    expect(connected.composer.mode).toBe('CONTROLLED');
    expect(connected.runtime.commandExecution).toBe(false);
    expect(connected.runtime.releaseChannel).toBe('WINDOWS_PHASE1_READ_ONLY');
  });
  it('starts in a side-effect-free connecting state', () => {
    const model = createInitialReadModel();

    expect(model.connection.state).toBe('CONNECTING');
    expect(model.composer.mode).toBe('CONTROLLED');
    expect(model.runtime).toMatchObject({
      readOnly: true,
      commandExecution: false,
      networkSideEffects: false
    });
  });

  it('projects the native Windows runtime snapshot', () => {
    const model = setRuntimeReady(createInitialReadModel(), {
      platform: 'WINDOWS',
      version: '0.1.0',
      readOnly: true,
      workspaceRead: true,
      commandExecution: false,
      networkSideEffects: false,
      runtimeReady: true,
      nodeVersion: 'v24.19.0',
      model: { provider: 'openai', protocol: 'responses', model: 'gpt-4.1-mini' },
      configLoaded: true
    });

    expect(model.connection).toMatchObject({ state: 'READY', mode: 'LOCAL_RUNTIME' });
    expect(model.runtime.platform).toBe('WINDOWS');
    expect(model.runtime.model).toMatchObject({ provider: 'openai', protocol: 'responses' });
    expect(model.runtime.configLoaded).toBe(true);
  });

  it('uses controlled execution on a modern release channel', () => {
    const model = setRuntimeReady(createInitialReadModel(), {
      platform: 'WINDOWS',
      version: '0.1.0',
      readOnly: true,
      workspaceRead: true,
      commandExecution: false,
      networkSideEffects: false,
      releaseChannel: 'WINDOWS_FULL_LOCAL'
    });
    expect(model.composer.mode).toBe('CONTROLLED');
    expect(model.composer.placeholder).toContain('审批');
  });

  it('projects OpenViking sidecar lifecycle status without changing execution policy', () => {
    const initial = createInitialReadModel();
    const projected = setContextSidecarStatus(initial, {
      enabled: true,
      state: 'READY',
      managed: true,
      running: true,
      ready: true,
      pid: 1933,
      startedAtMs: 42,
      errorCode: null
    });

    expect(projected.runtime.contextSidecar).toMatchObject({
      state: 'READY',
      managed: true,
      pid: 1933
    });
    expect(projected.runtime.commandExecution).toBe(false);
    expect(projected.runtime.networkSideEffects).toBe(false);
    expect(projected.projectionVersion).toBeGreaterThan(initial.projectionVersion);
  });

  it('starts Dream maintenance with the desktop app unless this session stopped it', () => {
    expect(shouldAutoStartDreamMaintenance({
      native: true,
      runtimeReady: true,
      userStopped: false,
      taskRunning: false,
      alreadyRunning: false,
      attempted: false
    })).toBe(true);
    expect(shouldAutoStartDreamMaintenance({
      native: true,
      runtimeReady: true,
      userStopped: true,
      taskRunning: false,
      alreadyRunning: false,
      attempted: false
    })).toBe(false);
    expect(shouldAutoStartDreamMaintenance({
      native: true,
      runtimeReady: true,
      userStopped: false,
      taskRunning: true,
      alreadyRunning: false,
      attempted: false
    })).toBe(false);
    expect(shouldAutoStartDreamMaintenance({
      native: false,
      runtimeReady: true,
      userStopped: false,
      taskRunning: false,
      alreadyRunning: false,
      attempted: false
    })).toBe(false);
  });

  it('projects Dream maintenance status without enabling side effects', () => {
    const initial = createInitialReadModel();
    const projected = setDreamMaintenanceStatus(initial, {
      enabled: true,
      state: 'RUNNING',
      running: true,
      pid: 2048,
      projectId: 'dda',
      cycleCount: 2,
      consecutiveFailures: 0,
      lastErrorCode: null
    });

    expect(projected.runtime.dreamMaintenance).toMatchObject({
      state: 'RUNNING',
      running: true,
      cycleCount: 2
    });
    expect(projected.runtime.commandExecution).toBe(false);
    expect(projected.runtime.networkSideEffects).toBe(false);
  });

  it('runs through planning, streaming, verification and completion', () => {
    let model = beginRun(createInitialReadModel(), '检查工作区结构');
    expect(model.activeRun?.state).toBe('PLANNING');
    expect(model.composer.enabled).toBe(true);
    expect(model.timeline.at(-1)?.body).toBe('检查工作区结构');

    model = setRunState(model, 'EXECUTING_READ');
    expect(model.composer.enabled).toBe(true);
    model = upsertStreamingAgent(model, 'agent-1', '第一段');
    model = upsertStreamingAgent(model, 'agent-1', '，第二段', true);
    expect(model.timeline.at(-1)).toMatchObject({
      itemId: 'agent-1',
      body: '第一段，第二段',
      status: 'COMPLETE'
    });

    model = setRunState(model, 'VERIFYING');
    expect(model.composer.enabled).toBe(true);
    model = setRunState(model, 'SUCCEEDED');
    expect(model.activeRun?.state).toBe('SUCCEEDED');
    expect(model.composer.enabled).toBe(true);
  });

  it('does not create an empty response when completion arrives without deltas', () => {
    const initial = createInitialReadModel();
    const untouched = completeStreamingAgent(initial, 'runtime-run-response');

    expect(untouched).toBe(initial);

    const streaming = upsertStreamingAgent(initial, 'runtime-run-response', '结果');
    const completed = completeStreamingAgent(streaming, 'runtime-run-response');
    expect(completed.timeline).toContainEqual(expect.objectContaining({
      itemId: 'runtime-run-response',
      body: '结果',
      status: 'COMPLETE'
    }));
  });

  it('re-enables the composer after cancellation', () => {
    const running = beginRun(createInitialReadModel(), '取消这个任务');
    const cancelled = setRunState(running, 'CANCELLED');

    expect(cancelled.activeRun?.state).toBe('CANCELLED');
    expect(cancelled.composer.enabled).toBe(true);
  });

  it('keeps sidebar creation time when a later snapshot reports a different one', () => {
    const older = { id: 'compile', title: '编译exe', cwd: 'C:\\demo', turnCount: 1, createdAtMs: 10, updatedAtMs: 10 };
    const newer = { id: 'price', title: '腾讯的hy 4', cwd: 'C:\\demo', turnCount: 1, createdAtMs: 20, updatedAtMs: 20 };
    const listed = setThreads(createInitialReadModel(), [older, newer]);
    const opened = setThreads(listed, [
      { ...older, title: '编译exe', createdAtMs: 99, updatedAtMs: 40 },
      newer
    ]);
    expect(opened.threads.map((thread) => [thread.id, thread.createdAtMs])).toEqual([
      ['compile', 10],
      ['price', 20]
    ]);
    const filled = setThreads(setThreads(createInitialReadModel(), [{ ...older, createdAtMs: 0 }]), [{ ...older, createdAtMs: 15, updatedAtMs: 16 }]);
    expect(filled.threads[0].createdAtMs).toBe(15);
  });

  it('preserves the original task title when sending a follow-up like 继续', () => {
    const initial = setWorkspace(createInitialReadModel(), 'demo', '', [], 'C:\\demo');
    const first = beginRun(initial, '把自动启动做成开关，打开后后面一直自动启动');
    const failed = setRunState(first, 'FAILED');
    const continued = beginRun(failed, '继续');
    expect(continued.activeRun?.title).toBe('把自动启动做成开关，打开后后面一直自动启动');
    expect(continued.timeline.at(-1)).toMatchObject({ kind: 'USER', body: '继续' });

    const withThread = setActiveThread(
      setThreads(initial, [{ id: 'thread-1', title: '编译exe', cwd: 'C:\\demo', turnCount: 0, createdAtMs: 1, updatedAtMs: 2 }]),
      'thread-1',
      true
    );
    const resumed = beginRun(withThread, '继续');
    expect(resumed.activeRun?.title).toBe('编译exe');
  });

  it('cancels approvals left pending when a runtime run terminates', () => {
    const initial = createInitialReadModel();
    const pending = {
      requestId: 'approval-1',
      capability: 'shell.execute',
      requestDigest: 'sha256:request',
      state: 'REQUESTED' as const,
      createdAtMs: 1
    };
    const settled = cancelPendingApprovals({
      ...initial,
      approvals: [pending, { ...pending, requestId: 'approval-2', state: 'APPROVED' as const }]
    });

    expect(settled.approvals).toMatchObject([
      { requestId: 'approval-1', state: 'CANCELLED' },
      { requestId: 'approval-2', state: 'APPROVED' }
    ]);
    expect(settled.projectionVersion).toBeGreaterThan(initial.projectionVersion);
  });

  it('tracks sub-agent work and closes active agents with the parent run', () => {
    let model = beginRun(createInitialReadModel(), '并行检查工作区');
    model = upsertSubAgent(model, {
      agentId: 'workspace-scan',
      name: '结构扫描',
      task: '扫描授权工作区',
      state: 'RUNNING'
    });
    expect(model.subAgents).toHaveLength(1);
    expect(model.subAgents[0]).toMatchObject({
      agentId: 'workspace-scan',
      name: '结构扫描',
      task: '扫描授权工作区',
      state: 'RUNNING'
    });

    const cancelled = setRunState(model, 'CANCELLED');
    expect(cancelled.subAgents[0].state).toBe('CANCELLED');
    expect(cancelled.activeRun?.state).toBe('CANCELLED');
  });

  it('projects real Cordis role events into sub-agent status', () => {
    let model = beginRun(createInitialReadModel(), '执行多角色任务');
    const event = (kind: string, payload: Record<string, unknown>, sequence: number, runId = 'run-runtime'): RuntimeEvent => ({
      type: 'runtime_event',
      schemaVersion: '1.0',
      runId,
      sequence,
      kind,
      payload,
      emittedAtMs: sequence
    });

    // Allocation creates STARTING rows keyed by runId+role; BUSY is not work.
    model = applyRuntimeSubAgentEvent(model, event('role.contexts_allocated', {
      contexts: [
        { contextId: 'ctx-executor', role: 'executor', model: 'test-model', isolation: 'DEDICATED' },
        { contextId: 'ctx-verifier', role: 'verifier', model: 'rule', isolation: 'DEDICATED' }
      ]
    }, 1));
    expect(model.subAgents).toMatchObject([
      { agentId: 'ctx-executor', name: '执行 Agent', state: 'STARTING' },
      { agentId: 'ctx-verifier', name: '结果验证（规则）', state: 'STARTING' }
    ]);

    // model.request_started moves only this run's executor to RUNNING.
    model = applyRuntimeSubAgentEvent(model, event('model.request_started', {}, 2));
    expect(model.subAgents.find((a) => a.agentId === 'ctx-executor')).toMatchObject({ state: 'RUNNING', workStarted: true });
    expect(model.subAgents.find((a) => a.agentId === 'ctx-verifier')).toMatchObject({ state: 'STARTING' });

    // tool.call_requested / tool.result update the executor copy.
    model = applyRuntimeSubAgentEvent(model, event('tool.call_requested', { name: 'shell.execute' }, 3));
    expect(model.subAgents.find((a) => a.agentId === 'ctx-executor')).toMatchObject({ state: 'RUNNING' });
    model = applyRuntimeSubAgentEvent(model, event('tool.result', { name: 'shell.execute', ok: true }, 4));
    expect(model.subAgents.find((a) => a.agentId === 'ctx-executor')).toMatchObject({ state: 'WAITING' });

    // verification.started: verifier RUNNING, executor WAITING.
    model = applyRuntimeSubAgentEvent(model, event('verification.started', { attempt: 1 }, 5));
    expect(model.subAgents.find((a) => a.agentId === 'ctx-verifier')).toMatchObject({ state: 'RUNNING', workStarted: true });
    expect(model.subAgents.find((a) => a.agentId === 'ctx-executor')).toMatchObject({ state: 'WAITING' });

    // verification.completed PASS/FAIL.
    model = applyRuntimeSubAgentEvent(model, event('verification.completed', { status: 'PASS' }, 6));
    expect(model.subAgents.find((a) => a.agentId === 'ctx-verifier')).toMatchObject({ state: 'SUCCEEDED' });

    // Events for a different runId change nothing.
    const before = JSON.stringify(model.subAgents);
    model = applyRuntimeSubAgentEvent(model, event('model.request_started', {}, 7, 'run-other'));
    expect(JSON.stringify(model.subAgents)).toBe(before);

    // Terminal run.state_changed: started rows settle, never-started rows SKIPPED.
    model = applyRuntimeSubAgentEvent(model, event('run.state_changed', { to: 'SUCCEEDED' }, 8));
    const term = model.subAgents;
    expect(term.find((a) => a.agentId === 'ctx-executor')).toMatchObject({ state: 'SUCCEEDED' });
    expect(term.find((a) => a.agentId === 'ctx-verifier')).toMatchObject({ state: 'SUCCEEDED' });
  });

  it('approval DECLINED stops the executor and later events do not revive it', () => {
    let model = beginRun(createInitialReadModel(), '任务');
    const event = (kind: string, payload: Record<string, unknown>, sequence: number): RuntimeEvent => ({
      type: 'runtime_event', schemaVersion: '1.0', runId: 'run-runtime', sequence, kind, payload, emittedAtMs: sequence
    });
    model = applyRuntimeSubAgentEvent(model, event('role.contexts_allocated', { contexts: [{ contextId: 'ctx-executor', role: 'executor', model: 'test-model', isolation: 'DEDICATED' }] }, 1));
    model = applyRuntimeSubAgentEvent(model, event('model.request_started', {}, 2));
    model = applyRuntimeSubAgentEvent(model, event('approval.resolved', { state: 'DECLINED' }, 3));
    expect(model.subAgents.find((a) => a.agentId === 'ctx-executor')).toMatchObject({ state: 'FAILED' });
    // Later events must not resurrect a failed role.
    model = applyRuntimeSubAgentEvent(model, event('model.text_delta', {}, 4));
    expect(model.subAgents.find((a) => a.agentId === 'ctx-executor')).toMatchObject({ state: 'FAILED' });
  });

  it('BUSY is not work evidence; reconciled crashed contexts fail', () => {
    let model = beginRun(createInitialReadModel(), '任务');
    const event = (kind: string, payload: Record<string, unknown>, sequence: number): RuntimeEvent => ({
      type: 'runtime_event', schemaVersion: '1.0', runId: 'run-runtime', sequence, kind, payload, emittedAtMs: sequence
    });
    model = applyRuntimeSubAgentEvent(model, event('role.contexts_allocated', { contexts: [
      { contextId: 'ctx-executor', role: 'executor', model: 'test-model', isolation: 'DEDICATED' },
      { contextId: 'ctx-verifier', role: 'verifier', model: 'test-model', isolation: 'DEDICATED' }
    ] }, 1));
    model = applyRuntimeSubAgentEvent(model, event('RoleContextStateChanged', {
      contextId: 'ctx-executor', role: 'executor', from: 'READY', to: 'BUSY'
    }, 2));
    expect(model.subAgents.find((agent) => agent.agentId === 'ctx-executor')?.state).toBe('STARTING');
    model = applyRuntimeSubAgentEvent(model, event('role.contexts_reconciled', {
      reconciled: 1,
      contexts: [{ contextId: 'ctx-verifier', role: 'verifier', state: 'FAILED', reason: 'OWNER_PROCESS_LOST' }]
    }, 3));
    expect(model.subAgents.find((agent) => agent.agentId === 'ctx-verifier')).toMatchObject({
      state: 'FAILED'
    });
  });

  it('keeps another task session out of this task when contexts are reconciled together', () => {
    let model = beginRun(createInitialReadModel(), '任务');
    const event = (kind: string, payload: Record<string, unknown>, sequence: number): RuntimeEvent => ({
      type: 'runtime_event', schemaVersion: '1.0', runId: 'run-new', clientSessionId: 'ui-new',
      sequence, kind, payload, emittedAtMs: sequence
    });
    model = applyRuntimeSubAgentEvent(model, event('role.contexts_reconciled', {
      reconciled: 2,
      contexts: [
        { contextId: 'ctx-other', role: 'planner', runId: 'run-old', sessionId: 'ui-old', state: 'FAILED', reason: 'OWNER_PROCESS_LOST' },
        { contextId: 'ctx-mine', role: 'executor', runId: 'run-prev', sessionId: 'ui-new', state: 'FAILED', reason: 'OWNER_PROCESS_LOST' }
      ]
    }, 1));
    expect(model.subAgents.find((agent) => agent.agentId === 'ctx-other')).toBeUndefined();
    expect(model.subAgents.find((agent) => agent.agentId === 'ctx-mine')).toMatchObject({ state: 'FAILED' });
  });

  it('projects workspace navigation and a selected file without mutating prior state', () => {
    const initial = createInitialReadModel();
    const workspace = setWorkspace(initial, 'demo', 'src', [
      { name: 'main.ts', relativePath: 'src/main.ts', kind: 'FILE', sizeBytes: 12 }
    ], 'C:\\projects\\demo');
    const nestedWorkspace = setWorkspace(workspace, 'demo', 'src/components', []);
    const withFile = setWorkspaceFile(workspace, {
      relativePath: 'src/main.ts',
      content: 'const x = 1;',
      contentDigest: 'sha256:123',
      totalBytes: 12,
      truncated: false,
      binary: false
    });

    expect(initial.workspace.granted).toBe(false);
    expect(workspace.workspace).toMatchObject({ granted: true, rootLabel: 'demo', rootPath: 'C:\\projects\\demo', currentPath: 'src' });
    expect(nestedWorkspace.workspace.rootPath).toBe('C:\\projects\\demo');
    expect(withFile.workspace.selectedFile?.relativePath).toBe('src/main.ts');
    expect(withFile.projectionVersion).toBeGreaterThan(workspace.projectionVersion);
  });
});
