import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginGovernance } from '../src/plugin-governance.mjs';
import { MemoryJournal } from '../src/memory-journal.mjs';
import { DreamScheduler } from '../src/dream-scheduler.mjs';
import { DREAM_PHASES, dreamDigest } from '../src/dream-scheduler.mjs';
import { MemoryVerifier } from '../src/memory-verifier.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('plugin governance validates and quarantines lifecycle', () => {
  const governance = new PluginGovernance();
  const discovered = governance.discover({ id: 'com.example.demo', version: '1.0.0', contributions: [] });
  governance.validate(discovered.pluginId, { expectedDigest: discovered.packageDigest });
  governance.transition(discovered.pluginId, 'INSTALLED');
  governance.transition(discovered.pluginId, 'ENABLED');
  governance.transition(discovered.pluginId, 'ACTIVE');
  assert.equal(governance.transition(discovered.pluginId, 'QUARANTINED').state, 'QUARANTINED');
  assert.throws(() => governance.discover({ id: discovered.pluginId, version: '2.0.0', contributions: [] }), /PLUGIN_ALREADY_EXISTS/);
});

test('durable plugin discovery commits Harness facts before cache changes', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const governance = new PluginGovernance({ eventStore });
  const plugin = await governance.discoverDurably({ id: 'com.example.discovered', version: '1.0.0', contributions: [] }, { source: 'DYNAMIC_LOCAL' });
  const events = await eventStore.list({ runId: 'plugin:com.example.discovered' });
  assert.equal(events[0].kind, 'PluginDiscovered');
  assert.equal(events[0].payload.packageDigest, plugin.packageDigest);
  assert.equal(governance.get(plugin.pluginId).state, 'DISCOVERED');
});

test('durable plugin discovery rejects a non-committed receipt before cache update', async () => {
  const governance = new PluginGovernance({ eventStore: { append: async () => ({ receipt: { status: 'PENDING', eventIds: [] } }) } });
  await assert.rejects(
    governance.discoverDurably({ id: 'com.example.uncommitted', version: '1.0.0', contributions: [] }),
    /DURABLE_COMMIT_REQUIRED/
  );
  assert.equal(governance.get('com.example.uncommitted'), undefined);
});

test('durable plugin transitions serialize races and reject the stale transition', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const governance = new PluginGovernance({ eventStore });
  const plugin = await governance.discoverDurably({ id: 'com.example.race', version: '1.0.0', contributions: [] });
  const results = await Promise.allSettled([
    governance.transitionDurably(plugin.pluginId, 'VALIDATING'),
    governance.transitionDurably(plugin.pluginId, 'VALIDATING')
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(governance.get(plugin.pluginId).state, 'VALIDATING');
  const events = await eventStore.list({ runId: 'plugin:' + plugin.pluginId });
  assert.equal(events.filter((event) => event.kind === 'PluginStateChangeCommitted').length, 1);
});

test('durable plugin state transitions commit Harness facts before cache changes', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const governance = new PluginGovernance({ eventStore });
  const plugin = await governance.discoverDurably({ id: 'com.example.durable', version: '1.0.0', contributions: [] });
  const transitioned = await governance.transitionDurably(plugin.pluginId, 'VALIDATING');
  assert.equal(transitioned.state, 'VALIDATING');
  const events = await eventStore.list({ runId: 'plugin:com.example.durable' });
  assert.equal(events.at(-1).kind, 'PluginStateChangeCommitted');
  assert.equal(events.at(-1).payload.from, 'DISCOVERED');
});

test('durable memory proposal rejects a non-committed receipt before cache update', async () => {
  const journal = new MemoryJournal({ eventStore: { append: async () => ({ receipt: { status: 'PENDING', eventIds: [] } }) } });
  await assert.rejects(
    journal.proposeDurably({ runId: 'memory-uncommitted', statement: 'bounded fact', sourceEventIds: ['event-1'] }),
    /DURABLE_COMMIT_REQUIRED/
  );
  assert.equal(journal.list().length, 0);
});

test('memory durable summaries omit statement content while preserving digest facts', async () => {
  const eventStore = createHarnessEventStore();
  const journal = new MemoryJournal({ eventStore });
  const record = await journal.proposeDurably({ runId: 'summary-run', statement: 'bounded private note', sourceEventIds: ['source-summary'] });
  const summaries = await journal.listDurableSummaries('PROPOSED');
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].memoryId, record.memoryId);
  assert.equal(summaries[0].recordDigest, record.recordDigest);
  assert.equal(Object.hasOwn(summaries[0], 'statement'), false);
});

test('memory durable summaries reject cross-aggregate payloads', async () => {
  const eventStore = createHarnessEventStore();
  const journal = new MemoryJournal({ eventStore });
  await journal.proposeDurably({ runId: 'summary-run', statement: 'bounded private note', sourceEventIds: ['source-summary'] });
  const originalList = eventStore.list.bind(eventStore);
  eventStore.list = async (options) => (await originalList(options)).map((event) => event.kind === 'MemoryProposalCommitted'
    ? { ...event, aggregateId: 'memory-other' }
    : event);
  await assert.rejects(() => journal.listDurableSummaries(), /MEMORY_STORE_INVALID/);
});

test('memory remains proposed until explicit verification and activation', () => {
  const journal = new MemoryJournal();
  const memory = journal.propose({ runId: 'run-1', statement: 'Use npm test', sourceEventIds: ['event-1'] });
  assert.equal(journal.list('ACTIVE').length, 0);
  journal.verify(memory.memoryId, { accepted: true });
  assert.equal(journal.activate(memory.memoryId).status, 'ACTIVE');
});

test('durable memory lifecycle commits Harness facts before updating the cache', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const journal = new MemoryJournal({ eventStore, now: () => 100 });
  const proposed = await journal.proposeDurably({ runId: 'memory-run', statement: 'durable fact', sourceEventIds: ['source-1'] });
  assert.equal((await eventStore.list({ runId: 'memory-run' })).length, 1);
  const verified = await journal.verifyDurably(proposed.memoryId, { accepted: true });
  assert.equal(verified.status, 'VERIFIED');
  await journal.activateDurably(proposed.memoryId);
  const events = await eventStore.list({ runId: 'memory-run' });
  assert.deepEqual(events.map((event) => event.kind), ['MemoryProposalCommitted', 'MemoryStateChanged', 'MemoryStateChanged']);
});

test('memory cannot become verified or active without source events', () => {
  const journal = new MemoryJournal();
  const memory = journal.propose({ runId: 'run-1', statement: 'unattributed fact' });
  assert.throws(() => journal.verify(memory.memoryId, { accepted: true }), /MEMORY_SOURCE_REQUIRED/);
  assert.equal(journal.verify(memory.memoryId, { accepted: false }).status, 'REJECTED');
});

test('memory rejects duplicate source event ids before persistence can be corrupted', () => {
  const journal = new MemoryJournal();
  assert.throws(() => journal.propose({
    runId: 'run-1',
    statement: 'duplicate source test',
    sourceEventIds: ['event-1', ' event-1 ']
  }), /MEMORY_SOURCES_INVALID/);
});

test('memory edits create durable superseding versions and conflict resolution clears conflicts', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const journal = new MemoryJournal({ eventStore, now: () => 2000 });
  const original = await journal.proposeDurably({ runId: 'memory-version', statement: 'team prefers concise output', sourceEventIds: ['event-1'], sensitivity: 'INTERNAL' });
  const edited = await journal.editDurably(original.memoryId, {
    statement: 'team prefers concise Chinese output',
    scope: 'project',
    confidence: 0.9,
    sensitivity: 'SENSITIVE',
    sourceEventIds: ['event-2']
  });
  assert.notEqual(edited.memoryId, original.memoryId);
  assert.equal(edited.version, 2);
  assert.equal(edited.supersedesMemoryId, original.memoryId);
  assert.equal(edited.sensitivity, 'SENSITIVE');
  assert.equal(journal.get(original.memoryId).statement, original.statement);
  const conflict = await journal.proposeDurably({ runId: 'memory-version', statement: 'team prefers verbose output', sourceEventIds: ['event-3'], conflictsWithMemoryIds: [edited.memoryId] });
  assert.deepEqual(conflict.conflictsWithMemoryIds, [edited.memoryId]);
  const resolved = await journal.resolveConflictDurably(conflict.memoryId, 'USER_SELECTED_NEW_VERSION');
  assert.equal(resolved.version, 2);
  assert.equal(resolved.supersedesMemoryId, conflict.memoryId);
  assert.equal(resolved.conflictsWithMemoryIds, undefined);
  const events = await eventStore.list({ aggregateType: 'Memory' });
  assert.equal(events.filter((event) => event.kind === 'MemoryProposalCommitted').length, 4);
});

test('durable Dream lifecycle is represented in the Harness Event Store', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const scheduler = new DreamScheduler({ eventStore, now: () => 100 });
  const result = await scheduler.run({
    gates: { idle: true, safetyAllowed: true, activeRuns: 0 },
    orient: async () => ({ sourceEventCount: 1 }),
    gather: async () => [],
    consolidate: async (items) => items,
    verify: async (items) => items,
    review: async (items) => items,
    prune: async (items) => items
  });
  assert.equal(result.status, 'COMPLETED');
  const events = await eventStore.list({ runId: result.runId });
  assert.equal(events[0].kind, 'DreamRunStarted');
  assert.equal(events.at(-1).kind, 'DreamRunFinished');
  assert.ok(events.some((event) => event.kind === 'DreamPhaseCheckpointed'));
});

test('Dream Scheduler replays a redacted run from Harness without JSON cache', async () => {
  const eventStore = createHarnessEventStore();
  const writer = new DreamScheduler({ eventStore, now: () => 100 });
  const result = await writer.run({ gates: { idle: true, safetyAllowed: true }, orient: async () => ({}), gather: async () => [], consolidate: async (items) => items, verify: async (items) => items, review: async (items) => items, prune: async (items) => items });
  const reader = new DreamScheduler({ eventStore });
  const runs = await reader.list();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, result.runId);
  assert.equal(Object.hasOwn(runs[0], 'candidates'), false);
  assert.match(runs[0].recordDigest, /^sha256:/);
});

test('Dream Scheduler rejects a tampered Harness projection', async () => {
  const eventStore = createHarnessEventStore();
  const writer = new DreamScheduler({ eventStore, now: () => 100 });
  await writer.run({ gates: { idle: true, safetyAllowed: true }, orient: async () => ({}), gather: async () => [], consolidate: async (items) => items, verify: async (items) => items, review: async (items) => items, prune: async (items) => items });
  const originalList = eventStore.list.bind(eventStore);
  eventStore.list = async (options) => (await originalList(options)).map((event) => event.kind === 'DreamRunFinished'
    ? { ...event, payload: { ...event.payload, state: 'RUNNING' } }
    : event);
  await assert.rejects(() => new DreamScheduler({ eventStore }).list(), /DREAM_STORE_INVALID/);
});

test('dream scheduler supports cancellation between phases', async () => {
  const scheduler = new DreamScheduler();
  const result = await scheduler.run({
    gather: async (cancelled) => { assert.equal(cancelled(), false); scheduler.cancel(); return ['event']; },
    consolidate: async () => ['candidate'],
    verify: async (items) => items
  });
  assert.equal(result.status, 'CANCELLED');
});

test('persists plugin governance and memory lifecycle records with integrity metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-governance-persist-'));
  const pluginPath = join(directory, 'plugins.json');
  const memoryPath = join(directory, 'memory.json');

  const governance = new PluginGovernance({ storagePath: pluginPath, idFactory: () => 'test-id' });
  const plugin = governance.discover({ id: 'com.example.persisted', version: '1.0.0', contributions: [] }, { source: 'LOCAL_DEVELOPMENT' });
  governance.validate(plugin.pluginId, { expectedDigest: plugin.packageDigest });
  governance.transition(plugin.pluginId, 'INSTALLED');
  governance.transition(plugin.pluginId, 'ENABLED');
  await governance.flush();
  const restoredGovernance = new PluginGovernance({ storagePath: pluginPath });
  await restoredGovernance.load();
  assert.equal(restoredGovernance.get(plugin.pluginId).state, 'ENABLED');
  assert.equal(restoredGovernance.get(plugin.pluginId).history.length, 3);

  const journal = new MemoryJournal({ storagePath: memoryPath });
  const memory = journal.propose({ runId: 'run-1', statement: 'persisted fact', sourceEventIds: ['event-1'] });
  await journal.flush();
  const restoredJournal = new MemoryJournal({ storagePath: memoryPath });
  await restoredJournal.load();
  assert.equal(restoredJournal.get(memory.memoryId).status, 'PROPOSED');
  restoredJournal.verify(memory.memoryId, { accepted: true, reason: 'deterministic test' });
  restoredJournal.activate(memory.memoryId);
  await restoredJournal.flush();
  const disk = JSON.parse(await readFile(memoryPath, 'utf8'));
  assert.equal(disk.memories[0].status, 'ACTIVE');
  assert.doesNotMatch(JSON.stringify(disk), /secret|apiKey|password/i);
});

test('memory journal rejects tampered lifecycle fields while keeping legacy records readable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-memory-lifecycle-'));
  const storagePath = join(directory, 'memory.json');
  const journal = new MemoryJournal({ storagePath });
  const memory = journal.propose({ runId: 'run-1', statement: 'sealed fact', sourceEventIds: ['event-1'] });
  journal.verify(memory.memoryId, { accepted: true });
  journal.activate(memory.memoryId);
  await journal.flush();
  const original = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.match(original.memories[0].lifecycleDigest, /^sha256:[0-9a-f]{64}$/);

  const tampered = structuredClone(original);
  tampered.memories[0].status = 'RETRACTED';
  await writeFile(storagePath, `${JSON.stringify(tampered)}\n`, 'utf8');
  await assert.rejects(() => new MemoryJournal({ storagePath }).load(), /MEMORY_STORE_INVALID/);

  delete original.memories[0].lifecycleDigest;
  await writeFile(storagePath, `${JSON.stringify(original)}\n`, 'utf8');
  const legacy = new MemoryJournal({ storagePath });
  await legacy.load();
  assert.equal(legacy.get(memory.memoryId).status, 'ACTIVE');
});

test('persists dream run status without persisting candidate contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-dream-persist-'));
  const storagePath = join(directory, 'dream.json');
  const scheduler = new DreamScheduler({ storagePath });
  const result = await scheduler.run({
    gather: async () => ['event-a'],
    consolidate: async () => [{ statement: 'candidate text' }],
    verify: async (items) => items
  });
  assert.equal(result.status, 'COMPLETED');
  await scheduler.flush();
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.equal(persisted.runs[0].state, 'COMPLETED');
  assert.equal('candidateDigest' in persisted.runs[0], true);
  assert.match(persisted.runs[0].recordDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(persisted).includes('candidate text'), false);
});

test('rejects tampered persisted dream lifecycle state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-dream-lifecycle-'));
  const storagePath = join(directory, 'dream.json');
  const scheduler = new DreamScheduler({ storagePath });
  await scheduler.run({
    gather: async () => ['event-a'],
    consolidate: async () => [{ statement: 'bounded fact' }],
    verify: async (items) => items
  });
  await scheduler.flush();
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  persisted.runs[0].state = 'RUNNING';
  await writeFile(storagePath, `${JSON.stringify(persisted)}\n`, 'utf8');
  await assert.rejects(() => new DreamScheduler({ storagePath }).load(), /DREAM_STORE_INVALID/);
});

test('reconciles a persisted dream run whose owner process was lost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-dream-recovery-'));
  const storagePath = join(directory, 'dream.json');
  const unsigned = {
    runId: 'dream-interrupted',
    projectId: 'project-recovery',
    state: 'RUNNING',
    phase: 'VERIFY',
    startedAtMs: 1000,
    ownerPid: 424242,
    runtimeInstanceId: 'runtime-lost-owner'
  };
  await writeFile(storagePath, `${JSON.stringify({
    schemaVersion: '1.0',
    runs: [{ ...unsigned, recordDigest: dreamDigest(unsigned) }]
  })}\n`, 'utf8');
  const scheduler = new DreamScheduler({ storagePath, now: () => 2000 });
  const result = await scheduler.reconcile({ isOwnerAlive: () => false });
  assert.equal(result.reconciled, 1);
  assert.deepEqual(result.runs, [{
    runId: 'dream-interrupted',
    projectId: 'project-recovery',
    state: 'FAILED',
    errorCode: 'DREAM_OWNER_PROCESS_LOST'
  }]);
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.equal(persisted.runs[0].state, 'FAILED');
  assert.equal(persisted.runs[0].finishedAtMs, 2000);
  assert.equal(persisted.runs[0].errorCode, 'DREAM_OWNER_PROCESS_LOST');
});

test('dream scheduler runs six phases, persists checkpoints, and honors gates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-dream-phases-'));
  const storagePath = join(directory, 'dream.json');
  const scheduler = new DreamScheduler({ storagePath, projectId: 'project-a' });
  const phases = [];
  const result = await scheduler.run({
    orient: async () => { phases.push('ORIENT'); return { cursor: 2 }; },
    gather: async () => { phases.push('GATHER'); return ['source']; },
    consolidate: async () => { phases.push('CONSOLIDATE'); return [{ statement: 'bounded fact' }]; },
    verify: async (items) => { phases.push('VERIFY'); return items; },
    review: async (items) => { phases.push('REVIEW'); return items; },
    prune: async (items) => { phases.push('PRUNE'); return items; }
  });
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(phases, [...DREAM_PHASES]);
  await scheduler.flush();
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.equal(persisted.runs[0].phase, 'PRUNE');
  assert.equal(persisted.runs[0].checkpoint.phase, 'PRUNE');
  assert.equal(JSON.stringify(persisted).includes('bounded fact'), false);

  const blocked = await scheduler.run({
    gates: { idle: false },
    gather: async () => [],
    consolidate: async (items) => items,
    verify: async (items) => items
  });
  assert.equal(blocked.status, 'WAITING_GATE');
  assert.deepEqual(blocked.gateReasons, ['DEVICE_NOT_IDLE']);
});

test('dream scheduler enforces a project lock across scheduler instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-dream-lock-'));
  const storagePath = join(directory, 'dream.json');
  const first = new DreamScheduler({ storagePath, projectId: 'same-project' });
  const second = new DreamScheduler({ storagePath, projectId: 'same-project' });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const running = first.run({
    gather: async () => { await held; return []; },
    consolidate: async (items) => items,
    verify: async (items) => items
  });
  for (let attempt = 0; attempt < 20 && !first.running; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  const conflict = await second.run({
    gather: async () => [],
    consolidate: async (items) => items,
    verify: async (items) => items
  });
  assert.equal(conflict.status, 'FAILED');
  assert.equal(conflict.errorCode, 'DREAM_PROJECT_LOCKED');
  release();
  assert.equal((await running).status, 'COMPLETED');
});

test('memory verifier requires sources and rejects duplicates or conflicts', () => {
  const verifier = new MemoryVerifier();
  const reports = verifier.verify({
    sourceEvents: [{ eventId: 'event-1' }],
    existingMemories: [{ status: 'ACTIVE', statement: 'existing fact', scope: 'workspace', key: 'rule' }],
    candidates: [
      { statement: 'new fact', sourceEventIds: ['event-1'], scope: 'workspace' },
      { statement: 'new fact', sourceEventIds: ['event-1'], scope: 'workspace' },
      { statement: 'missing source', sourceEventIds: ['event-404'], scope: 'workspace' },
      { statement: 'duplicate source', sourceEventIds: ['event-1', 'event-1'], scope: 'workspace' },
      { statement: 'different fact', sourceEventIds: ['event-1'], scope: 'workspace', key: 'rule' }
    ]
  });
  assert.equal(reports[0].verification.accepted, true);
  assert.ok(reports[1].verification.codes.includes('DUPLICATE_MEMORY'));
  assert.ok(reports[2].verification.codes.includes('SOURCE_NOT_FOUND'));
  assert.ok(reports[3].verification.codes.includes('DUPLICATE_SOURCE'));
  assert.ok(reports[4].verification.codes.includes('CONFLICTING_MEMORY'));
});

test('memory journal supports expiry, decay, retract, and retention prune', () => {
  let now = 1000;
  const journal = new MemoryJournal({ now: () => now });
  const memory = journal.propose({ runId: 'run-1', statement: 'rotating fact', sourceEventIds: ['event-1'], confidence: 0.8, expiresAtMs: 1100 });
  journal.verify(memory.memoryId, { accepted: true });
  journal.activate(memory.memoryId);
  now = 2000;
  assert.equal(journal.expire({ now }).length, 1);
  const second = journal.propose({ runId: 'run-2', statement: 'temporary fact', sourceEventIds: ['event-2'], confidence: 0.8 });
  journal.verify(second.memoryId, { accepted: true });
  journal.activate(second.memoryId);
  const decayed = journal.decay({ now: 4000, halfLifeMs: 1000 });
  assert.equal(decayed.length, 1);
  journal.retract(second.memoryId);
  assert.equal(journal.prune({ beforeMs: 3000 }).length, 2);
  assert.equal(journal.get(second.memoryId).status, 'PRUNED');
});

test('memory deletion redacts content and marks the record untrainable', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const journal = new MemoryJournal({ eventStore, now: () => 1000 });
  const memory = await journal.proposeDurably({
    runId: 'run-delete',
    statement: 'must not remain trainable',
    sourceEventIds: ['event-1'],
    confidence: 0.8
  });
  await journal.verifyDurably(memory.memoryId, { accepted: true });
  await journal.activateDurably(memory.memoryId);
  const deleted = await journal.deleteDurably(memory.memoryId);
  assert.equal(deleted.status, 'PRUNED');
  assert.equal(deleted.statement, '[DELETED]');
  assert.equal(deleted.confidence, 0);
  assert.equal(deleted.untrainable, true);
  assert.equal(deleted.untrainableAtMs, 1000);
  assert.deepEqual(journal.get(memory.memoryId).sourceEventIds, []);
  const deletedAgain = await journal.deleteDurably(memory.memoryId);
  assert.equal(deletedAgain.untrainableAtMs, 1000);
});
