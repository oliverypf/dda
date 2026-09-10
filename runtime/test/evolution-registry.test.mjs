import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { EvolutionRegistry } from '../src/plugins/evolution-registry.mjs';

const makeIds = () => {
  let next = 0;
  return () => `test-${++next}`;
};

test('persists proposals and restores them without honoring forged lifecycle fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-evolution-'));
  const storagePath = join(directory, 'nested', 'proposals.json');
  const registry = new EvolutionRegistry({
    storagePath,
    idFactory: makeIds(),
    now: () => 1700000000000
  });

  const record = await registry.propose({
    pluginId: 'formatter',
    version: '0.2.0',
    candidateId: 'formatter-0.2.0',
    status: 'ACTIVE',
    proposalId: 'forged-id'
  });
  assert.equal(record.status, 'PROPOSED');
  assert.notEqual(record.proposalId, 'forged-id');
  assert.match(record.proposalDigest, /^sha256:[0-9a-f]{64}$/);

  const onDisk = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.equal(onDisk.schemaVersion, '1.0');
  assert.equal(onDisk.proposals.length, 1);

  const restored = new EvolutionRegistry({ storagePath, idFactory: makeIds() });
  await restored.load();
  await restored.load();
  assert.deepEqual(restored.get(record.proposalId), record);
});

test('evolution proposal and status changes commit Harness facts first', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const registry = new EvolutionRegistry({ eventStore });
  const proposal = await registry.propose({ candidateId: 'durable-candidate', route: { provider: 'fixture', model: 'fixture' } });
  await registry.transition(proposal.proposalId, 'VALIDATING');
  const events = await eventStore.list({ runId: 'evolution:' + proposal.proposalId });
  assert.deepEqual(events.map((event) => event.kind), ['EvolutionProposalCommitted', 'EvolutionStateChanged']);
  assert.equal(events[1].payload.to, 'VALIDATING');
});

test('reads the latest proposal projection from Harness without JSON cache', async () => {
  const eventStore = createHarnessEventStore();
  const writer = new EvolutionRegistry({ eventStore, idFactory: makeIds(), now: () => 1700000000000 });
  const proposal = await writer.propose({ candidateId: 'projected-candidate', route: { provider: 'fixture' } });
  await writer.transition(proposal.proposalId, 'VALIDATING');
  const reader = new EvolutionRegistry({ eventStore });
  await reader.load();
  assert.deepEqual(reader.get(proposal.proposalId), writer.get(proposal.proposalId));
});

test('enforces promotion order and allows explicit rollback', async () => {
  const registry = new EvolutionRegistry({ idFactory: makeIds(), now: () => 1700000000000 });
  const record = await registry.propose({ candidateId: 'candidate-a', pluginId: 'a', version: '1.0.0' });

  await assert.rejects(
    registry.transition(record.proposalId, 'ACTIVE'),
    /EVOLUTION_INVALID_TRANSITION:PROPOSED->ACTIVE/
  );
  for (const status of ['VALIDATING', 'SHADOW', 'CANARY', 'ACTIVE', 'ROLLED_BACK']) {
    await registry.transition(record.proposalId, status);
  }
  assert.equal(registry.get(record.proposalId).status, 'ROLLED_BACK');
  await assert.rejects(
    registry.transition(record.proposalId, 'ACTIVE'),
    /EVOLUTION_INVALID_TRANSITION:ROLLED_BACK->ACTIVE/
  );
});

test('does not persist credential-shaped fields', async () => {
  const registry = new EvolutionRegistry({ idFactory: makeIds() });
  await assert.rejects(
    registry.propose({ candidateId: 'unsafe', apiKey: 'do-not-store' }),
    /EVOLUTION_SENSITIVE_FIELD:apiKey/
  );
  const record = await registry.propose({ candidateId: 'candidate-c', pluginId: 'c', version: '1.0.0' });
  const transitioned = await registry.transition(record.proposalId, 'VALIDATING', {
    apiKey: 'do-not-store',
    note: 'self-test'
  });
  assert.equal(transitioned.lastTransition.metadata.apiKey, '[REDACTED]');
  assert.equal(transitioned.lastTransition.metadata.note, 'self-test');
});

test('rejects a tampered persisted digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-evolution-'));
  const storagePath = join(directory, 'proposals.json');
  const registry = new EvolutionRegistry({ storagePath, idFactory: makeIds() });
  const record = await registry.propose({ candidateId: 'candidate-b', pluginId: 'b', version: '1.0.0' });
  const raw = JSON.parse(await readFile(storagePath, 'utf8'));
  raw.proposals[0].version = '9.9.9';
  await import('node:fs/promises').then(({ writeFile }) => writeFile(storagePath, JSON.stringify(raw), 'utf8'));

  const restored = new EvolutionRegistry({ storagePath });
  await assert.rejects(restored.load(), /EVOLUTION_STORE_INVALID/);
  assert.ok(record.proposalId);
});

test('rejects tampered proposal lifecycle fields while keeping legacy records readable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-evolution-lifecycle-'));
  const storagePath = join(directory, 'proposals.json');
  const registry = new EvolutionRegistry({ storagePath, idFactory: makeIds() });
  const record = await registry.propose({ candidateId: 'lifecycle-candidate', pluginId: 'lifecycle-plugin', version: '1.0.0' });
  await registry.transition(record.proposalId, 'VALIDATING', { source: 'test' });
  const original = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.match(original.proposals[0].lifecycleDigest, /^sha256:[0-9a-f]{64}$/);

  const tampered = structuredClone(original);
  tampered.proposals[0].status = 'SHADOW';
  await import('node:fs/promises').then(({ writeFile }) => writeFile(storagePath, JSON.stringify(tampered), 'utf8'));
  await assert.rejects(() => new EvolutionRegistry({ storagePath }).load(), /EVOLUTION_STORE_INVALID/);

  delete original.proposals[0].lifecycleDigest;
  await import('node:fs/promises').then(({ writeFile }) => writeFile(storagePath, JSON.stringify(original), 'utf8'));
  const legacy = new EvolutionRegistry({ storagePath });
  await legacy.load();
  assert.equal(legacy.get(record.proposalId).status, 'VALIDATING');
});
