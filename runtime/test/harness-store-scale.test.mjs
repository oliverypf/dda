import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { pageProjectionTimeline, rebuildReadModel } from '../src/read-model-rebuilder.mjs';

const fixture = async () => join(await mkdtemp(join(tmpdir(), 'hmcodex-scale-')), 'events.db');

test('listPage and iterate expose stable keyset pages', async () => {
  const storagePath = await fixture();
  const store = createHarnessEventStore({ storagePath });
  await store.appendBatch([
    { runId: 'run-a', kind: 'Observed', payload: { n: 1 } },
    { runId: 'run-a', kind: 'Observed', payload: { n: 2 } },
    { runId: 'run-b', kind: 'Observed', payload: { n: 3 } }
  ]);
  const first = await store.listPage({ limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.events.length, 2);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.nextCursor, { afterRunId: 'run-a', afterSequence: 2 });
  const second = await store.listPage({ limit: 2, ...first.nextCursor });
  assert.equal(second.events.length, 1);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, undefined);
  const streamed = [];
  for await (const event of store.iterate({ limit: 1 })) streamed.push(event.eventId);
  assert.equal(streamed.length, 3);
  assert.equal(new Set(streamed).size, 3);
  await assert.rejects(store.listPage({ limit: 0 }), { message: 'HARNESS_STORE_PAGE_LIMIT_INVALID' });
});

test('stores, pages and rebuilds more than 100,000 events', { skip: process.env.HMCODEX_SCALE_TEST !== '1' }, async () => {
  const storagePath = await fixture();
  const store = createHarnessEventStore({ storagePath });
  const total = 100_001;
  const events = Array.from({ length: total }, (_, index) => ({
    eventId: `scale-${index}`,
    runId: `run-${Math.floor(index / 1000)}`,
    kind: 'Observed',
    payload: { index }
  }));
  await store.importLegacyEvents(events);
  assert.equal(store.summary().eventCount, total);
  const first = await store.listPage({ limit: 1000 });
  assert.equal(first.total, total);
  assert.equal(first.events.length, 1000);
  assert.equal(first.hasMore, true);
  let cursor = first.nextCursor;
  let count = first.events.length;
  let pages = 1;
  while (cursor) {
    const page = await store.listPage({ limit: 1000, ...cursor });
    count += page.events.length;
    pages += 1;
    cursor = page.nextCursor;
  }
  assert.equal(count, total);
  assert.equal(pages, Math.ceil(total / 1000));
  assert.equal((await store.verify()).ok, true);

  const reopened = createHarnessEventStore({ storagePath });
  await reopened.load();
  const projection = await rebuildReadModel({ eventStore: reopened });
  assert.equal(projection.runCount, 101);
  assert.equal(projection.timeline.length, total);
  const page = pageProjectionTimeline(projection, { cursor: 0, limit: 500 });
  assert.equal(page.timelinePage.items.length, 500);
  assert.equal(page.timelinePage.total, total);
  assert.equal(page.timelinePage.hasMore, true);
  const last = pageProjectionTimeline(projection, { cursor: total - 1, limit: 500 });
  assert.equal(last.timelinePage.items.length, 1);
  assert.equal(last.timelinePage.hasMore, false);
  const rebuiltAgain = await rebuildReadModel({ eventStore: reopened });
  assert.equal(rebuiltAgain.projectionChecksum, projection.projectionChecksum);
});
