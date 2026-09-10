import type { TimelineStatus, TimelineItem } from './models';

export function removeDeletedRunTimeline(items: TimelineItem[], deletedRunIds: string[] = []): TimelineItem[] {
  const deleted = new Set(deletedRunIds);
  return items.filter((item) => !item.runId || !deleted.has(item.runId));
}

export function projectionTimelineStatus(status: string): TimelineStatus {
  if (['ERROR', 'FAILED', 'FAIL', 'QUARANTINED', 'DENIED', 'REJECTED'].includes(status)) return 'ERROR';
  if (['COMPLETE', 'COMPLETED', 'SUCCEEDED', 'PASS', 'APPROVED', 'INFO'].includes(status)) return 'COMPLETE';
  // Paused, unknown and unrecognized states are not evidence of completion.
  return 'PENDING';
}

export function mergeTimelinePage(existing: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const seen = new Set(existing.map((item) => item.itemId));
  return [...existing, ...incoming.filter((item) => !seen.has(item.itemId))];
}
