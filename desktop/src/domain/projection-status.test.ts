import { expect, it } from 'vitest';
import { mergeTimelinePage, projectionTimelineStatus, removeDeletedRunTimeline } from './projection-status';

it('removes only explicitly tombstoned run content including streaming items', () => {
  const base = { kind: 'AGENT' as const, title: 'agent', body: 'content', status: 'STREAMING' as const, createdAtMs: 1 };
  const items = [{ ...base, itemId: 'deleted', runId: 'gone' }, { ...base, itemId: 'live', runId: 'live' }, { ...base, itemId: 'welcome' }];
  expect(removeDeletedRunTimeline(items, ['gone']).map((item) => item.itemId)).toEqual(['live', 'welcome']);
  expect(removeDeletedRunTimeline(items)).toEqual(items);
});

it('does not render failed or unsupported projections as completed', () => {
  for (const status of ['FAILED', 'FAIL', 'ERROR', 'QUARANTINED', 'DENIED']) {
    expect(projectionTimelineStatus(status)).toBe('ERROR');
  }
  for (const status of ['PAUSED_UNSUPPORTED', 'PAUSED', 'UNKNOWN', 'WAITING_APPROVAL', 'CANCELLED', 'future-state']) {
    expect(projectionTimelineStatus(status)).toBe('PENDING');
  }
  expect(projectionTimelineStatus('SUCCEEDED')).toBe('COMPLETE');
});

it('merges paginated timeline items without duplicating existing ids', () => {
  const base = { kind: 'STATUS' as const, title: 'event', body: 'status', status: 'COMPLETE' as const, createdAtMs: 1 };
  const existing = [{ ...base, itemId: 'projection-a' }];
  const incoming = [{ ...base, itemId: 'projection-a' }, { ...base, itemId: 'projection-b' }];
  expect(mergeTimelinePage(existing, incoming).map((item) => item.itemId)).toEqual(['projection-a', 'projection-b']);
});
