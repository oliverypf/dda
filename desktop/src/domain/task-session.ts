import type { HarnessReadModel } from './models';
import type { ComposerImageAttachment } from './image-attachments';
import { clarificationRunEnded } from './clarification';
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
  /** Creation time: a task created later must always render above older ones. */
  createdAtMs: number;
  /** Composer draft owned by this session; restored on selection. */
  promptDraft: string;
  /** Image attachments drafted in the composer for this session. */
  imageAttachments: ComposerImageAttachment[];
  /** Thread the session bound to (or intends to create into). */
  threadId: string | undefined;
  /** User started this session with “不选择项目”. A later default cwd must not file it under a saved project. */
  unboundProject: boolean;
  /** Model last chosen for this task in the composer. Unset follows the global default. */
  composerModelId?: string;
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
 * The bridge lock can stay set after cancel until the runtime process exits.
 * That lock is not a live run: a finished state must win over leftover progress.
 */
export const sessionStillExecuting = (running: boolean, runState: string | undefined): boolean =>
  running && !clarificationRunEnded(runState);

/** Sidebar status. A finished run outranks leftover tool-progress text. */
export const sessionStatusText = (
  running: boolean,
  taskProgressMessage: string,
  runState: string | undefined,
  label: (state: string) => string,
): string => {
  if (runState && clarificationRunEnded(runState)) return label(runState);
  if (taskProgressMessage) return taskProgressMessage;
  if (running) return '任务进行中';
  if (runState) return label(runState);
  return '待发送';
};

/** Extra clause on a saved thread row. Empty when this session adds nothing. */
export const sessionThreadActivity = (
  running: boolean,
  taskProgressMessage: string,
  runState: string | undefined,
  label: (state: string) => string,
): string => {
  if (runState && clarificationRunEnded(runState)) return label(runState);
  if (running || taskProgressMessage) return taskProgressMessage || '进行中';
  return '';
};

/**
 * A draft that has never been typed into, launched or bound to a thread —
 * nothing would be lost by dropping it, and it does not deserve a sidebar row.
 */
export const sessionIsPristineDraft = (session: TaskSession): boolean =>
  !session.running
  && !session.promptDraft.trim()
  && session.imageAttachments.length === 0
  && !session.model.activeRun
  && !session.lastSubmitReceipt
  && !session.threadId
  && !session.currentRunThreadId
  && !session.model.approvals.some((approval) => approval.state === 'REQUESTED');

let sessionSeq = 0;
export const nextClientSessionId = (now = Date.now()): string =>
  `ui-${now.toString(36)}-${(++sessionSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Newest-created row first. The rail orders rows by creation time, not by last
 * activity, so a task created later always sits above older ones. Equal or
 * missing times break by sortId, so selecting a task cannot reshuffle rows
 * that share a timestamp or have not reported one yet.
 */
export const newestTaskFirst = <T extends { createdAtMs: number; sortId?: string }>(items: T[]): T[] =>
  items.slice().sort((left, right) => {
    const leftMs = Number.isFinite(left.createdAtMs) ? left.createdAtMs : 0;
    const rightMs = Number.isFinite(right.createdAtMs) ? right.createdAtMs : 0;
    return rightMs - leftMs || (left.sortId ?? '').localeCompare(right.sortId ?? '');
  });

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
    imageAttachments?: ComposerImageAttachment[];
    threadId?: string;
    unboundProject?: boolean;
    createdAtMs?: number;
    composerModelId?: string;
    model?: HarnessReadModel;
  }): TaskSession {
    const clientSessionId = options.clientSessionId?.trim() || nextClientSessionId();
    const session: TaskSession = {
      clientSessionId,
      workspacePath: options.workspacePath,
      createdAtMs: options.createdAtMs ?? Date.now(),
      promptDraft: options.promptDraft ?? '',
      imageAttachments: options.imageAttachments ? options.imageAttachments.slice() : [],
      threadId: options.threadId,
      unboundProject: options.unboundProject === true,
      composerModelId: options.composerModelId?.trim() || undefined,
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

  /**
   * Keep one conversation on the session id already stored for its thread.
   * Used when a later launch would otherwise mint a new transport id.
   */
  adoptId(fromId: string, toId: string): TaskSession | undefined {
    const nextId = toId.trim();
    if (!nextId || fromId === nextId) return this.sessions.get(fromId);
    if (this.sessions.has(nextId)) return this.sessions.get(nextId);
    const session = this.sessions.get(fromId);
    if (!session || session.running) return session;
    this.sessions.delete(fromId);
    session.clientSessionId = nextId;
    this.sessions.set(nextId, session);
    if (this.selectedId === fromId) this.selectedId = nextId;
    for (const [runId, owner] of this.#runIdToSession) {
      if (owner === fromId) this.#runIdToSession.set(runId, nextId);
    }
    return session;
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
  ensureDraftSession(workspacePath: string, options: { promptDraft?: string; model?: HarnessReadModel; unboundProject?: boolean } = {}): TaskSession {
    const draft = this.create({
      workspacePath,
      promptDraft: options.promptDraft,
      model: options.model,
      unboundProject: options.unboundProject,
    });
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
