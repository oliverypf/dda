import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ToolRegistry, toolRegistryPlugin } from '../src/tool-registry.mjs';
import { registerResidentKernelTools } from '../src/kernel/kernel-tools.mjs';
import { normalizeHostRequestArguments, parseHostRequestPayload } from '../src/kernel/host-request-payload.mjs';

// Prime Phase-2a: real models often send kernel.host_request `payload` as a
// JSON string. The gate claim, the arguments digest and the dispatcher must
// all see the same unwrapped object.

const WRITE_PAYLOAD = { path: 'notes.txt', content: 'from kernel\n', expectedBaseDigest: null };

test('parseHostRequestPayload unwraps only JSON-object strings', () => {
  assert.deepEqual(parseHostRequestPayload(JSON.stringify(WRITE_PAYLOAD)), WRITE_PAYLOAD);
  assert.deepEqual(parseHostRequestPayload(`  ${JSON.stringify(WRITE_PAYLOAD)}\n`), WRITE_PAYLOAD);
  const object = { path: 'a' };
  assert.equal(parseHostRequestPayload(object), object);
  for (const value of ['not json', '{broken', '[1,2]', '"str"', '42', 'null', undefined, null, 7]) {
    assert.equal(parseHostRequestPayload(value), value);
  }
  // Exactly once: a doubly-encoded string is not recursively unwrapped.
  const doubly = JSON.stringify(JSON.stringify(WRITE_PAYLOAD));
  assert.equal(parseHostRequestPayload(doubly), doubly);
  const args = { kind: 'fs.write', payload: JSON.stringify(WRITE_PAYLOAD) };
  assert.deepEqual(normalizeHostRequestArguments(args), { kind: 'fs.write', payload: WRITE_PAYLOAD });
  const objectArgs = { kind: 'fs.write', payload: WRITE_PAYLOAD };
  assert.equal(normalizeHostRequestArguments(objectArgs), objectArgs);
});

const fakeDispatcher = (seen) => ({
  availability: { available: true, kinds: ['fs.write', 'fs.patch', 'test.run'], writeBatch: true },
  handles: (kind) => ['fs.write', 'fs.patch', 'test.run', 'fs.write_batch'].includes(kind),
  dispatch: async (request) => { seen.push(request); return { ok: true }; },
  noteBridgeOutcome() {}
});

test('kernel.host_request schema: per-kind object fields, stringified object accepted and unwrapped, unknown fields rejected', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  const seen = [];
  registerResidentKernelTools(registry, { request: async () => ({ ok: true }) }, { hostRequestDispatcher: fakeDispatcher(seen) });
  await registry.invoke('kernel.host_request', { kind: 'fs.write', payload: WRITE_PAYLOAD });
  await registry.invoke('kernel.host_request', { kind: 'fs.write', payload: JSON.stringify(WRITE_PAYLOAD) });
  assert.deepEqual(seen, [{ kind: 'fs.write', payload: WRITE_PAYLOAD }, { kind: 'fs.write', payload: WRITE_PAYLOAD }]);
  await registry.invoke('kernel.host_request', { kind: 'fs.write_batch', payload: { items: [{ op: 'write', path: 'a', content: 'x', expectedBaseDigest: null }] } });
  await assert.rejects(registry.invoke('kernel.host_request', { kind: 'fs.write', payload: { ...WRITE_PAYLOAD, sneaky: true } }));
  await assert.rejects(registry.invoke('kernel.host_request', { kind: 'fs.write', payload: 5 }));
});

const runWithModelArguments = async (t, rawArguments) => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  const seen = [];
  registerResidentKernelTools(registry, { request: async () => ({ ok: true }) }, { hostRequestDispatcher: fakeDispatcher(seen) });
  const root = new Context();
  t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(registry));
  let rounds = 0;
  await root.plugin(cordisPlugin((ctx) => ctx.provide('modelProvider', {
    provider: 'fixture', protocol: 'fixture', model: 'stringified-payload',
    async *stream() {
      rounds += 1;
      if (rounds === 1) yield { type: 'tool-call', id: 'call-1', name: 'kernel.host_request', arguments: rawArguments };
      else yield { type: 'text-delta', text: 'done' };
      yield { type: 'finish', reason: { kind: rounds === 1 ? 'tool-calls' : 'stop' } };
    }
  }), 'stringified-payload'));
  await root.plugin(taskRunnerPlugin);
  const gates = [];
  const events = [];
  await root.taskRunner.run({
    prompt: 'Create notes.txt through the kernel.',
    workspace: { granted: true, rootLabel: 'fixture', snapshotDigest: 'sha256:s', entries: [], sections: [] },
    mode: 'CONTROLLED',
    onToolCall: async (gate) => { gates.push(gate); return { allow: true }; },
    onEvent: (event) => events.push(event)
  });
  return { gate: gates[0], seen, requested: events.find((event) => event.kind === 'tool.call_requested') };
};

test('task runner: stringified payload yields the same gate claim, digest and dispatch input as an object payload', async (t) => {
  const asObject = await runWithModelArguments(t, JSON.stringify({ kind: 'fs.write', payload: WRITE_PAYLOAD }));
  const asString = await runWithModelArguments(t, JSON.stringify({ kind: 'fs.write', payload: JSON.stringify(WRITE_PAYLOAD) }));
  for (const run of [asObject, asString]) {
    assert.equal(run.gate.toolPolicyFacts.kernelEffectKind, 'fs.write');
    assert.equal(run.gate.toolPolicyFacts.capability, 'file.write');
    assert.equal(run.gate.requestSummary.path, 'notes.txt');
    assert.deepEqual(run.seen, [{ kind: 'fs.write', payload: WRITE_PAYLOAD }]);
  }
  assert.equal(asString.gate.argumentsDigest, asObject.gate.argumentsDigest);
  assert.equal(asString.requested.argumentsDigest, asObject.requested.argumentsDigest);
  assert.deepEqual(asString.gate.proposedInputClaim, asObject.gate.proposedInputClaim);
});
