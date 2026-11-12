import type { HarnessReadModel } from './models';
import type { RouteFailureNotice } from './routing-settings';
import { createInitialReadModel } from './store';

/**
 * The per-invocation fields that used to be module-level singletons in
 * main.ts. Each session owns an independent copy so parallel task windows
 * cannot overwrite one another's run identity, progress text, approval set
 * or read model.
 */
export interface ScopedRunState {
  running: boolean;
  taskProgressMessage: string;
  pendingCancellationRunId: string | undefined;
  runtimeStreamObserved: boolean;
  activeRuntimeRunId: string | undefined;
  runtimeEventFloorMs: number;
  lastRuntimeEventSequence: number;
  currentRunThreadId: string | undefined;
  pendingApprovalResolutions: Set<string>;
  observedRuntimeEvents: Set<string>;
  lastSubmitReceipt: { id: string; prompt: string; status: string; atMs: number } | undefined;
  routeFailure: (RouteFailureNotice & { threadId?: string }) | undefined;
  model: HarnessReadModel;
}

export const emptyScopedRunState = (model: HarnessReadModel): ScopedRunState => ({
  running: false,
  taskProgressMessage: '',
  pendingCancellationRunId: undefined,
  runtimeStreamObserved: false,
  activeRuntimeRunId: undefined,
  runtimeEventFloorMs: 0,
  lastRuntimeEventSequence: 0,
  currentRunThreadId: undefined,
  pendingApprovalResolutions: new Set<string>(),
  observedRuntimeEvents: new Set<string>(),
  lastSubmitReceipt: undefined,
  routeFailure: undefined,
  model
});

export interface TaskSession extends ScopedRunState {
  /** Stable id sent to the native host before the runtime child launches. */
  clientSessionId: string;
  /** Workspace root frozen at launch; later project switches never move it. */
  workspacePath: string;
  /** Composer draft owned by this session; restored on selection. */
  promptDraft: string;
  /** Thread the session bound to (or intends to create into). */
  threadId: string | undefined;
}

export interface SessionSummary {
  clientSessionId: string;
  running: boolean;
  taskProgressMessage: string;
  pendingApprovals: number;
  threadId: string | undefined;
  runId: string | undefined;
}

/**
 * A draft that has never been typed into, launched or bound to a thread —
 * nothing would be lost by dropping it, and it does not deserve a sidebar row.
 */
export const sessionIsPristineDraft = (session: TaskSession): boolean =>
  !session.running
  && !session.promptDraft.trim()
  && !session.model.activeRun
  && !session.lastSubmitReceipt
  && !session.threadId
  && !session.currentRunThreadId
  && !session.model.approvals.some((approval) => approval.state === 'REQUESTED');

let sessionSeq = 0;
export const nextClientSessionId = (now = Date.now()): string =>
  `ui-${now.toString(36)}-${(++sessionSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class TaskSessionController {
  readonly sessions = new Map<string, TaskSession>();
  selectedId: string;
  readonly #runIdToSession = new Map<string, string>();

  constructor(initial?: { workspacePath?: string; model?: HarnessReadModel }) {
    const session = this.create({
      workspacePath: initial?.workspacePath ?? '',
      model: initial?.model
    });
    this.selectedId = session.clientSessionId;
  }

  create(options: {
    workspacePath: string;
    clientSessionId?: string;
    promptDraft?: string;
    threadId?: string;
    model?: HarnessReadModel;
  }): TaskSession {
    const clientSessionId = options.clientSessionId?.trim() || nextClientSessionId();
    const session: TaskSession = {
      clientSessionId,
      workspacePath: options.workspacePath,
      promptDraft: options.promptDraft ?? '',
      threadId: options.threadId,
      ...emptyScopedRunState(options.model ?? createInitialReadModel())
    };
    this.sessions.set(clientSessionId, session);
    return session;
  }

  selected(): TaskSession | undefined {
    return this.sessions.get(this.selectedId);
  }

  select(clientSessionId: string): TaskSession | undefined {
    const session = this.sessions.get(clientSessionId);
    if (!session) return undefined;
    this.selectedId = clientSessionId;
    return session;
  }

  forClientSessionId(clientSessionId: string | undefined | null): TaskSession | undefined {
    return typeof clientSessionId === 'string' && clientSessionId ? this.sessions.get(clientSessionId) : undefined;
  }

  forRunId(runId: string | undefined | null): TaskSession | undefined {
    const sessionId = runId ? this.#runIdToSession.get(runId) : undefined;
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  /** Run ids only ever bind to their own session; rebinds keep the owner. */
  bindRunId(clientSessionId: string, runId: string): void {
    if (!this.sessions.has(clientSessionId) || !runId) return;
    if (!this.#runIdToSession.has(runId)) this.#runIdToSession.set(runId, clientSessionId);
  }

  /**
   * Park the running selected session and return a clean draft session for a
   * new task. The parked invocation keeps running; nothing is cancelled.
   */
  ensureDraftSession(workspacePath: string, options: { promptDraft?: string; model?: HarnessReadModel } = {}): TaskSession {
    const draft = this.create({ workspacePath, promptDraft: options.promptDraft, model: options.model });
    this.selectedId = draft.clientSessionId;
    return draft;
  }

  /** Sessions that own a not-yet-settled invocation (launch or run in flight). */
  runningSessions(): TaskSession[] {
    return [...this.sessions.values()].filter((session) => session.running);
  }

  anyTaskRunning(): boolean {
    return this.runningSessions().length > 0;
  }

  pendingApprovalCount(session: TaskSession): number {
    return session.model.approvals.filter((approval) => approval.state === 'REQUESTED').length;
  }

  summaries(): SessionSummary[] {
    return [...this.sessions.values()].map((session) => ({
      clientSessionId: session.clientSessionId,
      running: session.running,
      taskProgressMessage: session.taskProgressMessage,
      pendingApprovals: this.pendingApprovalCount(session),
      threadId: session.threadId ?? session.currentRunThreadId,
      runId: session.activeRuntimeRunId ?? session.model.activeRun?.runId
    }));
  }

  /** Match an in-memory session for a thread (direct or bound run thread). */
  sessionForThread(threadId: string | undefined): TaskSession | undefined {
    if (!threadId) return undefined;
    const matches = [...this.sessions.values()].reverse().filter((session) =>
      session.threadId === threadId || session.currentRunThreadId === threadId
      || session.model.activeThreadId === threadId);
    return matches.find((session) => session.running) ?? matches[0];
  }

  /** Drop empty never-used drafts so the sidebar does not accumulate them. */
  pruneIdleDrafts(keepId?: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.clientSessionId !== keepId && sessionIsPristineDraft(session)) this.remove(session.clientSessionId);
    }
  }

  remove(clientSessionId: string): void {
    const session = this.sessions.get(clientSessionId);
    if (!session || session.running) return;
    for (const [runId, owner] of this.#runIdToSession) if (owner === clientSessionId) this.#runIdToSession.delete(runId);
    this.sessions.delete(clientSessionId);
    if (this.selectedId === clientSessionId) {
      this.selectedId = this.sessions.keys().next().value ?? '';
      if (!this.selectedId) this.ensureDraftSession(session.workspacePath);
    }
  }
}
