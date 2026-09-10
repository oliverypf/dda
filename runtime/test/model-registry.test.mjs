import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { ModelRegistry } from '../src/model-registry.mjs';
import { RoleBindingResolver } from '../src/role-binding-resolver.mjs';

const model = (modelId, patch = {}) => ({
  modelId,
  provider: 'openai',
  protocol: 'responses',
  model: modelId,
  capabilities: ['model.invoke.stream', 'tool.calls'],
  ...patch
});

test('model registry selects healthy, capable, and allowlisted candidates', () => {
  const registry = new ModelRegistry({ idFactory: () => 'fixed' });
  registry.register(model('expensive', { costPer1kTokens: 2, latencyMs: 100 }));
  registry.register(model('cheap', { costPer1kTokens: 0.2, latencyMs: 200 }));
  registry.register(model('broken', { state: 'QUARANTINED' }));
  const selection = registry.select({ role: 'planner', allowedModelIds: ['expensive', 'cheap', 'broken'] });
  assert.equal(selection.status, 'SELECTED');
  assert.equal(selection.selected.model.modelId, 'cheap');
  assert.ok(selection.rejected.some((item) => item.modelId === 'broken'));
});

test('model registry changes commit Harness facts before cache updates', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const registry = new ModelRegistry({ eventStore, now: () => 100, idFactory: () => 'model' });
  const registered = await registry.registerDurably({ modelId: 'fixture/model', provider: 'compatible', protocol: 'responses', model: 'fixture' });
  await registry.updateDurably(registered.modelId, { state: 'DEGRADED' });
  const events = await eventStore.list({ runId: 'model-registry' });
  assert.deepEqual(events.map((event) => event.kind), ['ModelRegistryRecordCommitted', 'ModelRegistryRecordUpdated']);
  assert.equal(registry.get(registered.modelId).state, 'DEGRADED');
});

test('model registry reads durable records from Harness without a JSON cache', async () => {
  const eventStore = createHarnessEventStore();
  const writer = new ModelRegistry({ eventStore, now: () => 100, idFactory: () => 'durable' });
  await writer.registerDurably({ modelId: 'fixture/projection', provider: 'compatible', protocol: 'responses', model: 'fixture' });
  const reader = new ModelRegistry({ eventStore });
  await reader.load();
  assert.equal(reader.get('fixture/projection').model, 'fixture');
});

test('model registry rejects a non-committed receipt before exposing the model', async () => {
  const registry = new ModelRegistry({ eventStore: { append: async () => ({ receipt: { status: 'PENDING', eventIds: [] } }) } });
  await assert.rejects(
    registry.registerDurably({ modelId: 'fixture/uncommitted', provider: 'compatible', protocol: 'responses', model: 'fixture' }),
    /DURABLE_COMMIT_REQUIRED/
  );
  assert.equal(registry.get('fixture/uncommitted'), undefined);
});

test('role binding resolver supports deterministic verifier and explicit fallback', () => {
  const registry = new ModelRegistry();
  registry.register(model('planner-model', { roles: ['planner'] }));
  registry.register(model('executor-model', { roles: ['executor'] }));
  const resolver = new RoleBindingResolver({ registry });
  const result = resolver.resolve({
    taskClass: 'modify',
    mode: 'CONTROLLED',
    defaultModelId: 'planner-model',
    roles: { planner: 'default', executor: 'executor-model', verifier: 'rule' }
  });
  assert.equal(result.status, 'SELECTED');
  assert.equal(result.roles.planner.modelId, 'planner-model');
  assert.equal(result.roles.executor.modelId, 'executor-model');
  assert.equal(result.roles.verifier.kind, 'DETERMINISTIC');
});

test('role binding resolver reports missing candidates instead of bypassing safety', () => {
  const registry = new ModelRegistry();
  registry.register(model('planner-model', { roles: ['planner'] }));
  const resolver = new RoleBindingResolver({ registry });
  const result = resolver.resolve({
    taskClass: 'modify',
    mode: 'CONTROLLED',
    defaultModelId: 'planner-model',
    roles: { planner: 'default', executor: { selector: 'PINNED', modelId: 'missing', requireEligible: true } }
  });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.roles.executor, undefined);
  assert.equal(result.rejected[0].role, 'executor');
});

test('model registry persists records without credentials and rejects tampering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-model-registry-'));
  const storagePath = join(directory, 'models.json');
  const registry = new ModelRegistry({ storagePath });
  registry.register(model('persisted', { apiKeyEnv: 'OPENAI_API_KEY' }));
  await registry.flush();
  const restored = new ModelRegistry({ storagePath });
  await restored.load();
  assert.equal(restored.get('persisted').model, 'persisted');
  assert.doesNotMatch(await readFile(storagePath, 'utf8'), /sk-[A-Za-z0-9]|password|secret/i);
  const disk = JSON.parse(await readFile(storagePath, 'utf8'));
  disk.models[0].model = 'tampered';
  await import('node:fs/promises').then(({ writeFile }) => writeFile(storagePath, JSON.stringify(disk)));
  await assert.rejects(() => new ModelRegistry({ storagePath }).load(), /MODEL_REGISTRY_INVALID/);
});

test('CANDIDATE_SET resolves a candidate pool while fanout=1 stays single-model', () => {
  const registry = new ModelRegistry({ idFactory: () => 'fixed' });
  registry.register(model('model-a', { costPer1kTokens: 1 }));
  registry.register(model('model-b', { costPer1kTokens: 0.5 }));
  registry.register(model('model-c', { state: 'QUARANTINED' }));
  const resolver = new RoleBindingResolver({ registry });
  const single = resolver.resolve({
    roles: {
      planner: {
        selector: 'CANDIDATE_SET',
        candidateBindings: [
          { bindingId: 'binding-a', modelId: 'model-a', expectedCost: 1 },
          { bindingId: 'binding-b', modelId: 'model-b', expectedCost: 2 }
        ]
      }
    }
  });
  const planner = single.roles.planner;
  assert.equal(planner.selector, 'CANDIDATE_SET');
  assert.equal(planner.fanout, 1);
  assert.equal(planner.modelId, 'model-a');
  assert.equal(planner.candidateSetPlan.requestedFanout, 1);
  assert.equal(planner.candidateSetPlan.degradedToSingleCandidate ?? true, true);
  assert.equal(planner.candidateBindings.length, 1);
});

test('CANDIDATE_SET fanout resolves each planned binding and reports rejects', () => {
  const registry = new ModelRegistry({ idFactory: () => 'fixed' });
  registry.register(model('model-a', { costPer1kTokens: 1 }));
  registry.register(model('model-b', { costPer1kTokens: 0.5 }));
  registry.register(model('model-c', { state: 'QUARANTINED' }));
  const resolver = new RoleBindingResolver({ registry });
  const result = resolver.resolve({
    risk: 'CRITICAL',
    roles: {
      planner: {
        selector: 'CANDIDATE_SET',
        fanout: 3,
        fanoutBudget: { maxCandidates: 3, maxConcurrency: 2 },
        candidateBindings: [
          { bindingId: 'binding-a', modelId: 'model-a', expectedCost: 1 },
          { bindingId: 'binding-b', modelId: 'model-b', expectedCost: 2 },
          { bindingId: 'binding-c', modelId: 'model-c', expectedCost: 3 }
        ]
      }
    }
  });
  assert.equal(result.status, 'SELECTED');
  const planner = result.roles.planner;
  assert.equal(planner.fanout, 2);
  assert.deepEqual(planner.candidateBindings.map((binding) => binding.bindingId), ['binding-a', 'binding-b']);
  assert.deepEqual(planner.rejectedCandidateBindings.map((binding) => binding.bindingId), ['binding-c']);
  // Plan-time fanout is 3; only 2 bindings actually resolve, and `fanout`
  // reports what will really be invoked rather than what was planned.
  assert.equal(planner.candidateSetPlan.effectiveFanout, 3);
  assert.equal(planner.fanout, 2);
  assert.equal(planner.candidateSetPlan.maxConcurrency, 2);
  // The quarantine is a fact, not a silent drop.
  assert.ok(planner.rejectedCandidateBindings[0].rejected.some((item) => item.reasons.includes('MODEL_QUARANTINED')));
});

test('CANDIDATE_SET blocks when no candidate binding resolves', () => {
  const registry = new ModelRegistry({ idFactory: () => 'fixed' });
  registry.register(model('model-c', { state: 'QUARANTINED' }));
  const resolver = new RoleBindingResolver({ registry });
  const result = resolver.resolve({
    roles: { planner: { selector: 'CANDIDATE_SET', candidateBindings: [{ bindingId: 'binding-c', modelId: 'model-c' }] } }
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.roles.planner, undefined);
  assert.equal(result.rejected[0].selector, 'CANDIDATE_SET');
});
