import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { ModelEgressLedger, createModelEgressLedger, normalizeEgressTarget } from '../src/model-egress-ledger.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
// Record ids must stay unique per outbound call; a fixed factory would collapse
// distinct egress facts into one record and is rejected by the ledger.
const counterFactory = () => {
  let value = 0;
  return () => `id-${value += 1}`;
};
const entry = (overrides = {}) => ({
  phase: 'CANDIDATE_DRAFT',
  status: 'SUCCEEDED',
  runId: 'run-1',
  stepId: 'step-1',
  candidateId: 'binding-a',
  bindingId: 'binding-a',
  modelId: 'model-a',
  provider: 'openai',
  protocol: 'responses',
  egress: normalizeEgressTarget('https://api.example.com/v1/responses'),
  promptDigest: DIGEST,
  outputDigest: DIGEST,
  latencyMs: 120,
  expectedCost: 0.5,
  expectedTokens: 100,
  ...overrides
});

test('egress targets are reduced to a bounded origin and never carry credentials', () => {
  const target = normalizeEgressTarget('https://api.example.com/v1/responses');
  assert.equal(target.scheme, 'https');
  assert.equal(target.host, 'api.example.com');
  assert.equal(target.port, 443);
  assert.match(target.targetDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(normalizeEgressTarget('http://127.0.0.1:8080/x').port, 8080);
  assert.throws(() => normalizeEgressTarget('https://user:secret@api.example.com/x'), /MODEL_EGRESS_TARGET_INVALID/);
  assert.throws(() => normalizeEgressTarget('https://api.example.com/x?api_key=abc'), /MODEL_EGRESS_TARGET_INVALID/);
  assert.throws(() => normalizeEgressTarget('file:///etc/passwd'), /MODEL_EGRESS_TARGET_INVALID/);
  assert.throws(() => normalizeEgressTarget(''), /MODEL_EGRESS_TARGET_REQUIRED/);
});

test('egress facts commit to the Harness Event Store before the cache and reload from it', async () => {
  const eventStore = createHarnessEventStore({ now: () => 1000 });
  await eventStore.load();
  const ledger = new ModelEgressLedger({ eventStore, idFactory: counterFactory(), now: () => 2000 });
  const recorded = await ledger.recordDurably([entry(), entry({ candidateId: 'binding-b', modelId: 'model-b', provider: 'deepseek' })]);
  assert.equal(recorded.length, 2);
  const events = await eventStore.list({ aggregateType: 'ModelEgress' });
  assert.deepEqual(events.map((event) => event.kind), ['ModelEgressRecorded']);
  assert.equal(events[0].payload.records.length, 2);

  const reloaded = new ModelEgressLedger({ eventStore });
  await reloaded.load();
  assert.deepEqual(reloaded.list().map((record) => record.candidateId), ['binding-a', 'binding-b']);
  assert.equal(reloaded.list()[0].egress.host, 'api.example.com');
});

test('egress records carry digests only and declare the redaction boundary', async () => {
  const ledger = createModelEgressLedger({ idFactory: counterFactory(), now: () => 2000 });
  const [record] = ledger.record([entry()]);
  assert.deepEqual(record.redaction, { promptIncluded: false, outputIncluded: false, credentialsIncluded: false });
  assert.match(record.promptDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(record.prompt, undefined);
  assert.equal(record.output, undefined);
  assert.equal(record.apiKey, undefined);
  // A raw secret can never be smuggled in through a digest field.
  assert.throws(() => ledger.record([entry({ promptDigest: 'sk-live-abcdefghijklmnop' })]), /MODEL_EGRESS_PROMPT_DIGEST_INVALID/);
});

test('egress summary groups by provider, phase and candidate with totals', async () => {
  const ledger = createModelEgressLedger({ idFactory: counterFactory(), now: () => 2000 });
  ledger.record([
    entry(),
    entry({ candidateId: 'binding-b', modelId: 'model-b', provider: 'deepseek', expectedCost: 1.5, expectedTokens: 300 }),
    entry({ candidateId: 'binding-b', modelId: 'model-b', provider: 'deepseek', phase: 'CANDIDATE_JUDGE', candidateId: undefined, status: 'FAILED', latencyMs: 30, expectedCost: undefined, expectedTokens: undefined })
  ]);
  const summary = ledger.summarize();
  assert.equal(summary.recordCount, 3);
  assert.equal(summary.totals.calls, 3);
  assert.equal(summary.totals.failures, 1);
  assert.equal(summary.totals.expectedCost, 2);
  assert.equal(summary.totals.expectedCostKnown, 2);
  assert.equal(summary.totals.actualCost, null);
  assert.equal(summary.totals.actualCostKnown, 0);
  assert.equal(summary.totals.expectedTokens, 400);
  assert.equal(summary.byProvider['openai/model-a'].calls, 1);
  assert.equal(summary.byProvider['deepseek/model-b'].calls, 2);
  assert.equal(summary.byPhase.CANDIDATE_DRAFT.calls, 2);
  assert.equal(summary.byPhase.CANDIDATE_JUDGE.failures, 1);
  assert.equal(summary.byCandidate['binding-a'].modelId, 'model-a');
  assert.equal(summary.byCandidate['binding-b'].expectedCost, 1.5);
  assert.deepEqual(summary.redaction, { promptIncluded: false, outputIncluded: false, credentialsIncluded: false });
});

test('cost summaries distinguish missing billing, explicit zero and partial coverage', () => {
  const ledger = createModelEgressLedger({ idFactory: counterFactory(), now: () => 2000 });
  assert.equal(ledger.summarize().totals.actualCost, null);
  ledger.record([entry({ expectedCost: undefined })]);
  assert.equal(ledger.summarize().totals.expectedCost, null);
  ledger.record([entry({ expectedCost: 0, actualCost: 0 })]);
  const partial = ledger.summarize();
  for (const bucket of [partial.totals, partial.byProvider['openai/model-a'], partial.byPhase.CANDIDATE_DRAFT, partial.byCandidate['binding-a']]) {
    assert.equal(bucket.calls, 2);
    assert.equal(bucket.expectedCost, 0);
    assert.equal(bucket.actualCost, 0);
    assert.equal(bucket.expectedCostKnown, 1);
    assert.equal(bucket.actualCostKnown, 1);
  }
  ledger.record([entry({ expectedCost: 2, actualCost: 3 })]);
  assert.equal(ledger.summarize().totals.actualCost, 3);
  assert.equal(ledger.summarize().totals.actualCostKnown, 2);
});

test('egress rejects invalid phases, statuses and tampered stored records', async () => {
  const ledger = createModelEgressLedger({ idFactory: counterFactory(), now: () => 2000 });
  assert.throws(() => ledger.record([entry({ phase: 'SOMETHING_ELSE' })]), /MODEL_EGRESS_PHASE_INVALID/);
  assert.throws(() => ledger.record([entry({ status: 'MAYBE' })]), /MODEL_EGRESS_STATUS_INVALID/);
  assert.throws(() => ledger.record([entry({ modelId: '' })]), /MODEL_EGRESS_MODEL_INVALID/);
  // A colliding record id would silently drop a real outbound call.
  assert.throws(() => {
    const colliding = createModelEgressLedger({ idFactory: () => 'same', now: () => 2000 });
    colliding.record([entry(), entry({ candidateId: 'binding-b' })]);
  }, /MODEL_EGRESS_RECORD_ID_CONFLICT/);

  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-egress-'));
  const storagePath = join(directory, 'egress.json');
  const fileLedger = createModelEgressLedger({ storagePath, idFactory: counterFactory(), now: () => 2000 });
  fileLedger.record([entry()]);
  await fileLedger.flush();
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(storagePath, 'utf8'));
  raw.records[0].modelId = 'tampered-model';
  await (await import('node:fs/promises')).writeFile(storagePath, JSON.stringify(raw), 'utf8');
  const reloaded = createModelEgressLedger({ storagePath });
  await assert.rejects(() => reloaded.load(), /MODEL_EGRESS_STORE_INVALID/);
});

test('egress accounting and persistence include calls beyond the display limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-egress-full-'));
  const storagePath = join(directory, 'egress.json');
  const ledger = createModelEgressLedger({ storagePath, idFactory: counterFactory(), now: () => 2000 });
  ledger.record(Array.from({ length: 2050 }, (_, index) => entry({
    runId: index < 2048 ? 'run-1' : 'run-2',
    candidateId: `binding-${index}`
  })));
  await ledger.flush();
  assert.equal(ledger.list().length, 2048);
  assert.equal(ledger.summarize().recordCount, 2050);
  assert.equal(ledger.summarize().totals.expectedCost, 1025);
  assert.equal(ledger.summarize({ runId: 'run-2' }).recordCount, 2);
  const reloaded = createModelEgressLedger({ storagePath });
  await reloaded.load();
  assert.deepEqual(reloaded.summarize(), ledger.summarize());
  assert.equal(reloaded.list({ candidateId: 'binding-2049' }).length, 1);
});
