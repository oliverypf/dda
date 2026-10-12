import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEffectJournal, JOURNAL_STATES, EFFECT_JOURNAL_SCHEMA } from '../src/kernel/effect-journal.mjs';
import { runWithJournalAls, getJournalAls, JOURNAL_BITS } from '../src/kernel/journal-als.mjs';

test('journal empty state rejects SessionState fields and rehydrates STARTED→UNKNOWN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dda-journal-'));
  const path = join(dir, 'journal.json');
  const journal = createEffectJournal({ storagePath: path });
  const { effectId } = await journal.recordRequested({ kind: 'fs.write', bit: 'kernel' });
  await journal.recordStarted(effectId, {});
  const snap = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(snap.journalSchema, EFFECT_JOURNAL_SCHEMA);
  assert.equal('sessionId' in snap, false);
  assert.equal('schemaVersion' in snap, false);
  assert.equal('entries' in snap, false);

  const journal2 = createEffectJournal({ storagePath: path });
  const { armed } = await journal2.rehydrate();
  assert.equal(armed.length, 1);
  const effect = await journal2.get(effectId);
  assert.equal(effect.state, JOURNAL_STATES.UNKNOWN);
});

test('ALS bit is visible inside nested async work', async () => {
  let seen;
  await runWithJournalAls({ bit: JOURNAL_BITS.KERNEL, effectId: 'e1' }, async () => {
    await Promise.resolve();
    seen = getJournalAls();
  });
  assert.equal(seen.bit, JOURNAL_BITS.KERNEL);
  assert.equal(seen.effectId, 'e1');
  assert.equal(getJournalAls(), null);
});

test('terminal FAILED is not rewritten to UNKNOWN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dda-journal-'));
  const path = join(dir, 'journal.json');
  const journal = createEffectJournal({ storagePath: path });
  const { effectId } = await journal.recordRequested({ kind: 'fs.write', bit: 'kernel' });
  await journal.recordStarted(effectId, {});
  await journal.recordFailed(effectId, { errorCode: 'SCOPE_VIOLATION' });
  await journal.recordUnknown(effectId, { unknownReason: 'should-not-stick' });
  const effect = await journal.get(effectId);
  assert.equal(effect.state, JOURNAL_STATES.FAILED);
});
