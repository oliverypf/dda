import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_ERROR_CODES,
  ToolRegistry,
  ToolRegistryError,
  createReadonlyToolRegistry
} from '../src/tool-registry.mjs';

const echoDefinition = (overrides = {}) => ({
  name: 'echo',
  description: 'Returns the supplied text.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1, maxLength: 20 } },
    required: ['text'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  },
  readOnly: true,
  handler: ({ text }) => ({ text }),
  ...overrides
});

test('registers read-only tools and lists immutable provider-neutral metadata', () => {
  const registry = createReadonlyToolRegistry();
  const listed = registry.register(echoDefinition());
  assert.deepEqual(listed, registry.list()[0]);
  assert.equal(listed.readOnly, true);
  assert.equal('handler' in listed, false);
  assert.throws(() => { listed.name = 'changed'; }, TypeError);
  assert.throws(() => registry.register(echoDefinition()), (error) => {
    assert.ok(error instanceof ToolRegistryError);
    assert.equal(error.code, TOOL_ERROR_CODES.DUPLICATE);
    return true;
  });
  assert.throws(() => registry.register({ ...echoDefinition(), name: 'write', readOnly: false }), /TOOL_INVALID_DEFINITION/);
});

test('validates input schema and invokes sync or async handlers', async () => {
  const registry = new ToolRegistry();
  registry.register(echoDefinition({ handler: async ({ text }) => ({ text: text.toUpperCase() }) }));
  assert.deepEqual(await registry.invoke('echo', { text: 'hello' }), { text: 'HELLO' });
  assert.deepEqual(await registry.call('echo', { text: 'ok' }), { text: 'OK' });
  await assert.rejects(registry.invoke('echo', {}), /TOOL_INVALID_INPUT/);
  await assert.rejects(registry.invoke('echo', { text: 'ok', extra: true }), /TOOL_INVALID_INPUT/);
  await assert.rejects(registry.invoke('missing', {}), /TOOL_NOT_FOUND/);
});

test('rejects unsupported or non-strict schemas at registration', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register(echoDefinition({ inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: true
  } })), /TOOL_SCHEMA_NOT_STRICT/);
  assert.throws(() => registry.register(echoDefinition({ inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
    unknownKeyword: true
  } })), /TOOL_UNSUPPORTED_SCHEMA/);
});

test('enforces output schema and serialized output bounds', async () => {
  const registry = new ToolRegistry({ maxOutputBytes: 24, maxOutputChars: 24 });
  registry.register(echoDefinition({ name: 'large', handler: () => ({ text: 'x'.repeat(40) }) }));
  await assert.rejects(registry.invoke('large', { text: 'ok' }), /TOOL_OUTPUT_TOO_LARGE/);

  registry.register(echoDefinition({ name: 'bad-output', handler: () => ({ wrong: true }) }));
  await assert.rejects(registry.invoke('bad-output', { text: 'ok' }), /TOOL_INVALID_OUTPUT/);

  registry.register(echoDefinition({ name: 'bad-handler', handler: () => { throw new Error('secret'); } }));
  await assert.rejects(registry.invoke('bad-handler', { text: 'ok' }), (error) => {
    assert.equal(error.code, TOOL_ERROR_CODES.HANDLER_FAILED);
    assert.match(error.message, /^TOOL_HANDLER_FAILED:/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test('onInvocation receives only digests and summary fields', async () => {
  const summaries = [];
  const registry = new ToolRegistry({ onInvocation: (summary) => summaries.push(summary) });
  registry.register(echoDefinition());
  await registry.invoke('echo', { text: 'private input' });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].name, 'echo');
  assert.equal(summaries[0].ok, true);
  assert.match(summaries[0].inputDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(summaries[0].outputDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal('input' in summaries[0], false);
  assert.equal('output' in summaries[0], false);
});

test('records failed invocations without raw handler or input data', async () => {
  const summaries = [];
  const registry = new ToolRegistry({ onInvocation: (summary) => summaries.push(summary) });
  registry.register(echoDefinition({ handler: () => { throw new Error('private handler detail'); } }));
  await assert.rejects(registry.invoke('echo', { text: 'private argument' }), /TOOL_HANDLER_FAILED/);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].ok, false);
  assert.equal(summaries[0].errorCode, TOOL_ERROR_CODES.HANDLER_FAILED);
  assert.doesNotMatch(JSON.stringify(summaries[0]), /private/);
});

test('strict invocation persistence propagates audit sink failures', async () => {
  const registry = new ToolRegistry({
    strictInvocationPersistence: true,
    onInvocation: async () => { throw new Error('audit unavailable'); }
  });
  registry.register(echoDefinition());
  await assert.rejects(registry.invoke('echo', { text: 'ok' }), (error) => {
    assert.equal(error.code, 'TOOL_INVOCATION_PERSIST_FAILED');
    assert.doesNotMatch(error.message, /audit unavailable/);
    return true;
  });
});

test('creates bounded workspace tools without exposing the workspace object', async () => {
  const workspace = {
    async list(path) { return { path, entries: [] }; },
    async read(path, maxChars) { return { path, maxChars, content: 'ok' }; }
  };
  const registry = createReadonlyToolRegistry(workspace);
  assert.deepEqual(await registry.invoke('workspace.list', {}), { path: '', entries: [] });
  assert.deepEqual(await registry.invoke('workspace.read', { path: 'README.md', maxChars: 4 }), {
    path: 'README.md', maxChars: 4, content: 'ok'
  });
  assert.equal(registry.list().some((tool) => 'workspace' in tool), false);
});
