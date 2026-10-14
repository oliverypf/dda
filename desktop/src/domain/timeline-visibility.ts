// Which timeline items the conversation (live and history) renders. Everything
// else stays in the read model / persistence / export for audit.
import type { TimelineItem } from './models';

/** evidenceKind of the one-line "why this run did not pass" item. */
export const VERIFICATION_FAILURE_REASON = 'verification-failure-reason';

/**
 * Conversation items: non-STATUS/WORKSPACE kinds, tool steps, and failure
 * reasons (the 未达到验收条件 line and individual failed deterministic checks),
 * so a failed run always shows at least one line saying why.
 */
export const isConversationTimelineItem = (item: Pick<TimelineItem, 'kind' | 'toolName' | 'evidenceKind' | 'status'>): boolean =>
  (item.kind !== 'STATUS' && item.kind !== 'WORKSPACE')
  || Boolean(item.toolName)
  || item.evidenceKind === VERIFICATION_FAILURE_REASON
  || (item.evidenceKind === 'rule-verification-check' && item.status === 'ERROR');
