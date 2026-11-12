// Pure notification policy: decide which accepted live runtime events merit
// one OS notification, whether a delivery attempt counts as a failure worth
// warning about, and what a notification click should do. It owns no I/O so
// the semantics stay unit-testable; historical playback never reaches here.

export type DesktopNotice =
  | { kind: 'APPROVAL_REQUIRED'; runId: string; requestId: string }
  | { kind: 'TASK_COMPLETED' | 'TASK_FAILED'; runId: string };

export type DesktopNoticeDelivery = 'sent' | 'ignored' | 'failed';

export type DesktopNoticeAction =
  | { type: 'approval'; requestId: string }
  | { type: 'thread'; threadId: string }
  | { type: 'changed' }
  | { type: 'none' };

export interface DesktopNoticeActivationContext {
  activeRunId?: string;
  running: boolean;
  approvals: ReadonlyArray<{ requestId: string; state: string; approvalExpiresAt?: number }>;
  /** Thread mapped to the notice's run by the caller, if one is known. */
  threadId?: string;
  nowMs: number;
}

const SEEN_LIMIT = 512;

export class DesktopNoticePolicy {
  #seen = new Set<string>();
  #order: string[] = [];
  readonly #limit: number;

  constructor(limit = SEEN_LIMIT) {
    this.#limit = limit;
  }

  #first(key: string): boolean {
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    this.#order.push(key);
    while (this.#order.length > this.#limit) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) this.#seen.delete(oldest);
    }
    return true;
  }

  /** Once per (run, requestId) pair — distinct ids notify even in one run. */
  approvalRequested(runId: string, requestId: string): DesktopNotice | undefined {
    if (!runId || !requestId) return undefined;
    return this.#first(`approval:${runId}:${requestId}`)
      ? { kind: 'APPROVAL_REQUIRED', runId, requestId }
      : undefined;
  }

  /** First terminal event per run only. */
  runFinished(runId: string, failed: boolean): DesktopNotice | undefined {
    if (!runId) return undefined;
    if (!this.#first(`terminal:${runId}`)) return undefined;
    return { kind: failed ? 'TASK_FAILED' : 'TASK_COMPLETED', runId };
  }
}

/** Await one delivery attempt; a rejected send or unavailable native side is
 * a warning-worthy failure, while duplicates/unsupported are silently fine. */
export const deliverDesktopNotice = async (
  notice: DesktopNotice,
  send: (notice: DesktopNotice) => Promise<{ accepted: boolean; reason?: string }>
): Promise<DesktopNoticeDelivery> => {
  try {
    const ack = await send(notice);
    if (ack.accepted) return 'sent';
    if (ack.reason === 'duplicate' || ack.reason === 'unsupported') return 'ignored';
    return 'failed';
  } catch {
    return 'failed';
  }
};

/** Map a notification click to a UI-only action. Never approves or submits. */
export const desktopNoticeActivation = (
  notice: { kind?: unknown; runId?: unknown; requestId?: unknown } | undefined,
  context: DesktopNoticeActivationContext
): DesktopNoticeAction => {
  const kind = typeof notice?.kind === 'string' ? notice.kind : '';
  const runId = typeof notice?.runId === 'string' ? notice.runId : '';
  const requestId = typeof notice?.requestId === 'string' ? notice.requestId : '';
  if (kind === 'APPROVAL_REQUIRED') {
    if (!requestId || !runId || runId !== context.activeRunId) return { type: 'none' };
    const approval = context.approvals.find((item) => item.requestId === requestId);
    if (approval?.state === 'REQUESTED'
      && (approval.approvalExpiresAt === undefined || approval.approvalExpiresAt > context.nowMs)) {
      return { type: 'approval', requestId };
    }
    return { type: 'none' };
  }
  if (kind === 'TASK_COMPLETED' || kind === 'TASK_FAILED') {
    if (context.running) return { type: 'changed' };
    return context.threadId ? { type: 'thread', threadId: context.threadId } : { type: 'none' };
  }
  return { type: 'none' };
};
