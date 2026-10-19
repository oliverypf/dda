import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { ProfileRegistry } from '../src/profile-registry.mjs';
import { CreditBlameLedger } from '../src/credit-blame-ledger.mjs';
import {
  isPostPassGateOpen,
  isPostPassTelemetryError,
  softFailPostPassTelemetry
} from '../src/post-pass-telemetry.mjs';
import { readFileSync } from 'node:fs';

const evidence = (overrides = {}) => ({
  kind: 'CAPABILITY',
  entityType: 'model',
  entityId: 'provider-a/model-a',
  capabilityId: 'workspace.read',
  runId: 'run-1',
  decisionId: 'decision-1',
  outcomeId: 'outcome-1',
  sourceType: 'verifier',
  sourceId: 'verifier-1',
  outcome: 'SUCCEEDED',
  quality: 0.9,
  safety: 1,
  latencyMs: 100,
  cost: 0.1,
  ...overrides
});

test('T-idemp-1 cross-run different runId+stats uses max+1; one live projection version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-idemp1-'));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'harness.db') });
  await eventStore.load();

  // Seed: commit profile-projection:P:V via first registry write.
  const writerA = new ProfileRegistry({
    eventStore,
    now: () => 1000,
    idFactory: (() => { let n = 0; return () => `fixed-${++n}`; })()
  });
  await writerA.recordEvidence(evidence({
    evidenceId: 'e-seed',
    runId: 'run-seed',
    quality: 0.5
  }));
  const seeded = writerA.listProfiles()[0];
  assert.equal(seeded.version, 1);
  const projectionEvents = (await eventStore.list({ aggregateType: 'Profile', aggregateId: seeded.profileId }))
    .filter((e) => e.kind === 'ProfileProjectionUpdated');
  assert.equal(projectionEvents.length, 1);
  assert.equal(projectionEvents[0].payload.version, 1);

  // Pre-condition: command_dedup already has profile-projection:P:1
  // Second writer with different runId and different stats body must succeed via max+1.
  const writerB = new ProfileRegistry({
    eventStore,
    now: () => 2000,
    idFactory: (() => { let n = 100; return () => `b-${++n}`; })()
  });
  await writerB.load();
  await writerB.recordEvidence(evidence({
    evidenceId: 'e-cross',
    runId: 'run-cross',
    decisionId: 'decision-cross',
    outcomeId: 'outcome-cross',
    quality: 0.95, // different stats body
    sourceId: 'verifier-cross'
  }));
  const after = writerB.getProfile({
    kind: 'CAPABILITY', entityType: 'model', entityId: 'provider-a/model-a', capabilityId: 'workspace.read'
  });
  assert.ok(after.version >= 2, `expected version>=2, got ${after.version}`);

  // Assert only one live projection version (higher wins); both snapshots exist as events.
  const allProj = (await eventStore.list({ aggregateType: 'Profile', aggregateId: seeded.profileId }))
    .filter((e) => e.kind === 'ProfileProjectionUpdated');
  assert.ok(allProj.length >= 2, `expected >=2 projections, got ${allProj.length}`);
  const versions = allProj.map((e) => e.payload.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [...new Set(versions)].sort((a, b) => a - b)); // no duplicate versions silently overwriting without bump
  assert.equal(versions.at(-1), after.version);
  // Live profile is the max version — no silent drop of the newer snapshot.
  assert.equal(after.version, Math.max(...versions));
  // Cross-run write must have advanced past the seeded version (max+1 path).
  assert.ok(after.version > seeded.version);
  // Different stats body survived on the live projection.
  assert.notEqual(after.stats.qualityMean, seeded.stats.qualityMean);
});


test('T-idemp-1b preseeded conflicting projection commandId recovers via max+1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-idemp1b-'));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'harness.db') });
  await eventStore.load();
  const registry = new ProfileRegistry({
    eventStore,
    now: () => 5000,
    idFactory: (() => { let n = 0; return () => `p-${++n}`; })()
  });
  await registry.recordEvidence(evidence({ evidenceId: 'base', runId: 'run-base', quality: 0.4 }));
  const profile = registry.listProfiles()[0];
  // Plant a foreign receipt for the NEXT version commandId with a different digest body.
  // This mimics another run that already occupied profile-projection:P:2.
  await eventStore.append({
    runId: 'foreign-run',
    aggregateType: 'Profile',
    aggregateId: profile.profileId,
    commandId: `profile-projection:${profile.profileId}:2`,
    kind: 'ProfileProjectionUpdated',
    payload: {
      profileId: profile.profileId,
      kind: profile.kind,
      entityType: profile.entityType,
      entityId: profile.entityId,
      capabilityId: profile.capabilityId,
      version: 2,
      evidenceCount: 99,
      updatedAtMs: 1,
      stats: { sampleCount: 99, successCount: 0, partialCount: 0, failureCount: 99, cancelledCount: 0, unknownCount: 0, qualityMean: 0.01, safetyMean: null, safetyMin: null, latencyMeanMs: null, costMean: null },
      eligibility: { status: 'CONSERVATIVE', eligible: false, minSamples: 3, minQuality: 0.6, minSafety: 0.9, reasonCodes: ['FAILURE_OBSERVED'] },
      profileDigest: 'sha256:' + 'f'.repeat(64)
    },
    sensitivity: 'INTERNAL'
  });
  // Ignore digest validity of planted payload for command_dedup purposes — the receipt is what matters.
  // Next evidence from a different runId must not throw; it should land on version >= 3.
  await registry.recordEvidence(evidence({
    evidenceId: 'after-conflict',
    runId: 'run-after',
    decisionId: 'd-after',
    outcomeId: 'o-after',
    quality: 0.88,
    sourceId: 'verifier-after'
  }));
  const live = registry.listProfiles()[0];
  assert.ok(live.version >= 3, `expected version>=3 after conflict bump, got ${live.version}`);
  const versions = (await eventStore.list({ aggregateType: 'Profile', aggregateId: profile.profileId }))
    .filter((e) => e.kind === 'ProfileProjectionUpdated')
    .map((e) => e.payload.version);
  assert.equal(Math.max(...versions), live.version);
});

test('T-idemp-2 same sourceDigest twice → idempotent; one CreditBlameRecorded; one allocation in memory', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const ledger = new CreditBlameLedger({ eventStore });
  const input = {
    decisions: [{ decisionId: 'decision-1', runId: 'run-1', role: 'planner', status: 'COMMITTED' }],
    outcome: { outcomeId: 'outcome-1', runId: 'run-1', status: 'SUCCEEDED', executionEventIds: ['event-1'] }
  };
  const first = await ledger.recordDurably(input);
  assert.equal(first.length, 1);
  const allocationId = first[0].allocationId;
  const createdAtMs = first[0].createdAtMs;

  // Second call — even if wall clock would differ, payload must be byte-stable.
  const second = await ledger.recordDurably(input);
  assert.equal(second.length, 1);
  assert.equal(second[0].allocationId, allocationId);
  assert.equal(second[0].createdAtMs, createdAtMs);
  assert.equal(second[0].allocationDigest, first[0].allocationDigest);

  const events = await eventStore.list({ aggregateType: 'CreditBlame' });
  const recorded = events.filter((e) => e.kind === 'CreditBlameRecorded');
  assert.equal(recorded.length, 1);
  assert.equal(ledger.list().length, 1);
  assert.equal(ledger.list()[0].allocationId, allocationId);
});

test('T-idemp-3 post-pass gate soft-fails profile/credit conflicts; closed gate rethrows', async () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);

  assert.equal(isPostPassGateOpen({
    verification: { status: 'PASS', nextAction: 'COMPLETE' },
    taskRunCompleted: true
  }), true);
  assert.equal(isPostPassGateOpen({
    verification: { status: 'PASS', nextAction: 'COMPLETE' },
    taskRunCompleted: false
  }), false);
  assert.equal(isPostPassGateOpen({
    verification: { status: 'FAIL', nextAction: 'COMPLETE' },
    taskRunCompleted: true
  }), false);

  assert.equal(isPostPassTelemetryError(new Error('HARNESS_COMMAND_IDEMPOTENCY_CONFLICT')), true);
  assert.equal(isPostPassTelemetryError(new Error('HARNESS_STORE_CONCURRENT_CONFLICT')), true);
  assert.equal(isPostPassTelemetryError(new Error('OTHER_FAILURE')), false);

  // Open gate + profile conflict → soft-fail (simulates task path continuing to ok:true).
  const soft = await softFailPostPassTelemetry(
    true,
    'profile-capability',
    async () => { throw new Error('HARNESS_COMMAND_IDEMPOTENCY_CONFLICT'); },
    { warn }
  );
  assert.equal(soft.softFailed, true);
  assert.equal(soft.code, 'HARNESS_COMMAND_IDEMPOTENCY_CONFLICT');
  assert.ok(warnings.some((w) => w.includes('profile-capability')));

  // Open gate + credit conflict → soft-fail.
  await softFailPostPassTelemetry(
    true,
    'credit-blame-record',
    async () => { throw new Error('HARNESS_COMMAND_IDEMPOTENCY_CONFLICT'); },
    { warn }
  );

  // Closed gate → still throws (must not swallow pre-TaskRunCompleted failures).
  await assert.rejects(
    () => softFailPostPassTelemetry(
      false,
      'profile-capability',
      async () => { throw new Error('HARNESS_COMMAND_IDEMPOTENCY_CONFLICT'); },
      { warn }
    ),
    /HARNESS_COMMAND_IDEMPOTENCY_CONFLICT/
  );

  // Open gate must not swallow unrelated errors.
  await assert.rejects(
    () => softFailPostPassTelemetry(
      true,
      'profile-capability',
      async () => { throw new Error('VERIFICATION_REQUIRED'); },
      { warn }
    ),
    /VERIFICATION_REQUIRED/
  );
});

test('T-idemp-4 dda-drive bench isolates DDA_HARNESS_EVENT_STORE + profiles per outPrefix', async () => {
  const drivePath = '/workspace/dda-drive/bench/drive.mjs';
  const source = readFileSync(drivePath, 'utf8');
  assert.match(source, /DDA_HARNESS_EVENT_STORE/);
  assert.match(source, /harness-event-store/);
  assert.match(source, /\.hmcodex\.db/);
  assert.match(source, /DDA_PROFILE_STORE|profile-store/);
  assert.match(source, /profiles\.json/);
  assert.match(source, /trajectory-store alone is (insufficient|NOT enough)/i);
  // Must set env AND CLI flag — trajectory alone is documented as insufficient.
  assert.match(source, /--harness-event-store/);
  assert.match(source, /--profile-store/);
  // Prefer thread/credit isolation too.
  assert.match(source, /DDA_THREAD_STORE|thread-store/);
  assert.match(source, /DDA_CREDIT_BLAME_STORE|credit-blame-store/);
});

test('T-idemp-5 store still throws on same commandId + different payload; profile/credit green', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  await eventStore.append({
    runId: 'r1', kind: 'Probe', payload: { v: 1 }, commandId: 'probe-cmd'
  });
  await assert.rejects(
    () => eventStore.append({
      runId: 'r1', kind: 'Probe', payload: { v: 2 }, commandId: 'probe-cmd'
    }),
    /HARNESS_COMMAND_IDEMPOTENCY_CONFLICT/
  );
  // Same digest still idempotent.
  const retry = await eventStore.append({
    runId: 'r1', kind: 'Probe', payload: { v: 1 }, commandId: 'probe-cmd'
  });
  assert.equal(retry.idempotent, true);

  // Existing profile + credit paths still work.
  const registry = new ProfileRegistry({ eventStore, now: () => 42 });
  await registry.recordEvidence(evidence({ evidenceId: 't5-e1', runId: 't5-run' }));
  assert.equal(registry.listProfiles().length, 1);

  const ledger = new CreditBlameLedger({ eventStore });
  const rows = await ledger.recordDurably({
    decisions: [{ decisionId: 'd-t5', runId: 't5-run', role: 'planner', status: 'COMMITTED' }],
    outcome: { outcomeId: 'o-t5', runId: 't5-run', status: 'SUCCEEDED', executionEventIds: ['ev'] }
  });
  assert.equal(rows.length, 1);
});
