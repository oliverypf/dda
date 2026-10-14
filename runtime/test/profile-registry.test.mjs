import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { ProfileRegistry } from '../src/profile-registry.mjs';

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

test('aggregates independent evidence and keeps new profiles conservative', async () => {
  const registry = new ProfileRegistry({ idFactory: (() => { let id = 0; return () => `fixed-${++id}`; })() });
  await registry.recordEvidence(evidence({ evidenceId: 'e-1' }));
  await registry.recordEvidence(evidence({ evidenceId: 'e-2', runId: 'run-2', decisionId: 'decision-2', outcomeId: 'outcome-2' }));
  await registry.recordEvidence(evidence({ evidenceId: 'e-3', runId: 'run-3', decisionId: 'decision-3', outcomeId: 'outcome-3' }));
  const profile = registry.getProfile({ kind: 'CAPABILITY', entityType: 'model', entityId: 'provider-a/model-a', capabilityId: 'workspace.read' });
  assert.equal(profile.stats.sampleCount, 3);
  assert.equal(profile.stats.successCount, 3);
  assert.equal(profile.stats.qualityMean, 0.9);
  assert.equal(profile.eligibility.status, 'ELIGIBLE_FOR_ROUTING');
  assert.equal(profile.eligibility.eligible, true);
});

test('profile evidence and projection commit to Harness before cache updates', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const registry = new ProfileRegistry({ eventStore, now: () => 100 });
  const evidence = await registry.recordEvidence({
    kind: 'CAPABILITY', entityType: 'model', entityId: 'fixture', capabilityId: 'task.inspect',
    runId: 'profile-run', sourceType: 'verifier', sourceId: 'verifier-profile-run', outcome: 'SUCCEEDED', quality: 1, safety: 1
  });
  const events = await eventStore.list({ runId: 'profile-run' });
  assert.deepEqual(events.map((event) => event.kind), ['ProfileEvidenceRecorded', 'ProfileProjectionUpdated']);
  assert.equal(events[0].payload.evidenceDigest, evidence.evidenceDigest);
  assert.equal(registry.listProfiles()[0].evidenceCount, 1);
});

test('profile projection reads from Harness when no JSON cache is configured', async () => {
  const eventStore = createHarnessEventStore();
  const writer = new ProfileRegistry({ eventStore, now: () => 100 });
  await writer.recordEvidence(evidence({ evidenceId: 'projection-only', runId: 'projection-run' }));
  const reader = new ProfileRegistry({ eventStore });
  await reader.load();
  const profile = reader.getProfile({ kind: 'CAPABILITY', entityType: 'model', entityId: 'provider-a/model-a', capabilityId: 'workspace.read' });
  assert.equal(profile.version, 1);
  assert.equal(profile.evidenceCount, 1);
});

test('legacy projections do not roll back newer durable versions to a stale cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-profile-replay-'));
  const storagePath = join(directory, 'profiles.json');
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'harness.db') });
  const writer = new ProfileRegistry({ storagePath, eventStore });
  await writer.recordEvidence(evidence({ evidenceId: 'first', runId: 'run-1' }));
  await writer.flush();
  const staleCache = await readFile(storagePath, 'utf8');
  const legacyPayload = { ...writer.listProfiles()[0] };
  delete legacyPayload.updatedAtMs;
  await eventStore.append({
    runId: 'run-1-legacy', aggregateType: 'Profile', aggregateId: legacyPayload.profileId,
    kind: 'ProfileProjectionUpdated', payload: legacyPayload
  });
  await writer.recordEvidence(evidence({ evidenceId: 'second', runId: 'run-2' }));
  await writer.flush();
  const latest = writer.listProfiles()[0];
  await writeFile(storagePath, staleCache);

  const reader = new ProfileRegistry({ storagePath, eventStore });
  await reader.load();
  assert.deepEqual(reader.listProfiles(), [latest]);
  assert.equal(reader.listEvidence().length, 1);
  await reader.recordEvidence(evidence({ evidenceId: 'third', runId: 'run-3' }));
  await reader.flush();
  assert.equal(reader.listProfiles()[0].version, 3);
  assert.equal((await eventStore.list({ runId: 'run-3' })).length, 2);
});

test('safety failure keeps a profile conservative and evidence is idempotent', async () => {
  const registry = new ProfileRegistry();
  const first = await registry.recordEvidence(evidence({ evidenceId: 'same', safety: 0.2 }));
  const duplicate = await registry.recordEvidence(evidence({ evidenceId: 'same', safety: 0.2 }));
  assert.deepEqual(duplicate, first);
  const profile = registry.getProfile({ kind: 'CAPABILITY', entityType: 'model', entityId: 'provider-a/model-a', capabilityId: 'workspace.read' });
  assert.equal(profile.eligibility.eligible, false);
  assert.ok(profile.eligibility.reasonCodes.includes('SAFETY_BELOW_THRESHOLD'));
  await assert.rejects(registry.recordEvidence(evidence({ evidenceId: 'same', safety: 1 })), /PROFILE_EVIDENCE_ID_CONFLICT/);
});

test('a complete projection with an invalid digest cannot fall back to a valid cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-profile-integrity-'));
  const storagePath = join(directory, 'profiles.json');
  const writer = new ProfileRegistry({ storagePath });
  await writer.recordEvidence(evidence());
  await writer.flush();
  const payload = writer.listProfiles()[0];
  payload.stats.successCount += 1;
  const eventStore = createHarnessEventStore();
  await eventStore.append({
    runId: 'tampered-run', aggregateType: 'Profile', aggregateId: payload.profileId,
    kind: 'ProfileProjectionUpdated', payload
  });
  await assert.rejects(new ProfileRegistry({ storagePath, eventStore }).load(), /PROFILE_STORE_INVALID/);
});

test('persists and validates profile snapshots without sensitive fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-profile-'));
  const storagePath = join(directory, 'profiles.json');
  const registry = new ProfileRegistry({ storagePath });
  await registry.recordEvidence(evidence({ evidenceId: 'e-1' }));
  await registry.flush();
  const raw = await readFile(storagePath, 'utf8');
  assert.doesNotMatch(raw, /apiKey|password|reasoning|prompt/i);
  const restored = new ProfileRegistry({ storagePath });
  await restored.load();
  assert.equal(restored.listProfiles().length, 1);
  assert.equal(restored.listEvidence({ kind: 'CAPABILITY' }).length, 1);

  const duplicate = JSON.parse(raw);
  duplicate.profiles.push({ ...duplicate.profiles[0] });
  await writeFile(storagePath, JSON.stringify(duplicate));
  await assert.rejects(new ProfileRegistry({ storagePath }).load(), /PROFILE_STORE_INVALID/);

  const tampered = JSON.parse(raw);
  tampered.profiles[0].stats.successCount = 99;
  await writeFile(storagePath, JSON.stringify(tampered));
  await assert.rejects(new ProfileRegistry({ storagePath }).load(), /PROFILE_STORE_INVALID/);
});

test('rejects secrets and outcomes authored by unsupported actors', async () => {
  const registry = new ProfileRegistry();
  await assert.rejects(registry.recordEvidence(evidence({ apiKey: 'secret' })), /PROFILE_FORBIDDEN_FIELD/);
  await assert.rejects(registry.recordEvidence(evidence({ sourceType: 'agent' })), /PROFILE_SOURCE_INVALID/);
  await assert.rejects(registry.recordEvidence(evidence({ outcome: 'SUCCESS' })), /PROFILE_OUTCOME_INVALID/);
});
