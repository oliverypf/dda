import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanSupportBundle, redactSensitiveData } from '../src/support-bundle-privacy.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createModelEgressLedger, normalizeEgressTarget } from '../src/model-egress-ledger.mjs';

test('support bundle privacy scanner rejects forbidden fields and credentials', () => {
  const safe = {
    stores: {
      harness: { eventCount: 3, receiptCount: 3 },
      projection: { runCount: 1, timelineCount: 3, lastEventSequence: { 'run-1': 3 } }
    }
  };
  assert.deepEqual(scanSupportBundle(safe), { ok: true, violations: [] });
  const forbiddenField = scanSupportBundle({ stores: { decision: { prompt: 'raw user input' } } });
  assert.equal(forbiddenField.ok, false);
  assert.deepEqual(forbiddenField.violations, [{ path: 'stores.decision.prompt', reason: 'FORBIDDEN_FIELD' }]);
  const forbiddenValue = scanSupportBundle({ stores: { feedback: { note: 'api_key=sk-0123456789abcdef01234567' } } });
  assert.equal(forbiddenValue.ok, false);
  assert.deepEqual(forbiddenValue.violations, [{ path: 'stores.feedback.note', reason: 'SENSITIVE_VALUE' }]);
});

test('support bundle scans and redacts secrets in nested arrays', () => {
  const bundle = { stores: { reasons: ['safe', ['api_key=secret-value']] } };
  assert.deepEqual(scanSupportBundle(bundle), {
    ok: false,
    violations: [{ path: 'stores.reasons[1][0]', reason: 'SENSITIVE_VALUE' }]
  });
  const redacted = redactSensitiveData(bundle);
  assert.deepEqual(redacted.removed, ['stores.reasons[1][0]']);
  assert.equal(redacted.value.stores.reasons[1][0], '[REDACTED]');
  assert.equal(scanSupportBundle(redacted.value).ok, true);
  assert.equal(scanSupportBundle({ stores: { reasons: Array(100).fill('api_key=secret-value') } }).violations.length, 32);
});

test('support-bundle CLI writes a bundle only after a clean privacy scan', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-support-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'support-bundle.json');
  const trajectory = join(directory, 'trajectory.jsonl');
  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    'support-bundle',
    '--output',
    outputPath
  ], {
    env: { ...process.env, HMCODEX_TRAJECTORY_STORE: trajectory },
    windowsHide: true
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.privacy.scan, { ok: true, violations: [] });
  const bundle = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.deepEqual(bundle.privacy.scan, { ok: true, violations: [] });
});

test('support bundle carries per-candidate egress and cost without leaking prompt or output', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-support-bundle-egress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, 'support-bundle.json');
  const harnessPath = join(directory, 'events.db');
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const ledger = createModelEgressLedger({ eventStore, now: () => 2000 });
  await ledger.recordDurably([
    {
      phase: 'CANDIDATE_DRAFT',
      status: 'SUCCEEDED',
      runId: 'run-candidates',
      candidateId: 'binding-a',
      modelId: 'model-a',
      provider: 'openai',
      egress: normalizeEgressTarget('https://api.example.com/v1/responses'),
      promptDigest: `sha256:${'a'.repeat(64)}`,
      outputDigest: `sha256:${'b'.repeat(64)}`,
      latencyMs: 90,
      expectedCost: 0.25,
      expectedTokens: 120
    },
    {
      phase: 'CANDIDATE_DRAFT',
      status: 'FAILED',
      runId: 'run-candidates',
      candidateId: 'binding-b',
      modelId: 'model-b',
      provider: 'deepseek',
      egress: normalizeEgressTarget('https://api.deepseek.com/v1/responses'),
      promptDigest: `sha256:${'a'.repeat(64)}`,
      latencyMs: 40,
      expectedCost: 1.5,
      expectedTokens: 300
    }
  ]);

  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    'support-bundle',
    '--output', outputPath,
    '--harness-event-store', harnessPath
  ], {
    env: { ...process.env, HMCODEX_TRAJECTORY_STORE: join(directory, 'trajectory.jsonl') },
    windowsHide: true
  });
  assert.equal(JSON.parse(result.stdout).ok, true);
  const bundle = JSON.parse(await readFile(outputPath, 'utf8'));
  const egress = bundle.stores.modelEgress;
  assert.equal(egress.recordCount, 2);
  assert.equal(egress.totals.calls, 2);
  assert.equal(egress.totals.failures, 1);
  assert.equal(egress.totals.expectedCost, 1.75);
  assert.equal(egress.byCandidate['binding-a'].modelId, 'model-a');
  assert.equal(egress.byCandidate['binding-b'].provider, 'deepseek');
  assert.equal(egress.byProvider['openai/model-a'].calls, 1);
  assert.deepEqual(egress.redaction, { promptIncluded: false, outputIncluded: false, credentialsIncluded: false });
  // Candidate granularity must not widen the privacy boundary.
  assert.deepEqual(bundle.privacy.scan, { ok: true, violations: [] });
});
