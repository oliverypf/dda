import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheDigest, cacheSessionId, comparePrefixShapes, prefixShape, stableToolDefinitions } from '../src/prompt-cache.mjs';
import { deepSeekToolDefinitions } from '../src/plugins/model-deepseek.mjs';

const tools = [
  { name: 'z', parameters: { required: ['b', 'a'], type: 'object' } },
  { name: 'a', parameters: { type: 'object', properties: { x: { type: 'string' } } } }
];

test('tool catalog ordering and object key ordering are deterministic', () => {
  const reversed = [tools[1], tools[0]];
  assert.deepEqual(stableToolDefinitions(tools), stableToolDefinitions(reversed));
  assert.equal(cacheDigest(stableToolDefinitions(tools)), cacheDigest(stableToolDefinitions(reversed)));
});

test('cache sessions are stable and isolated by role, model and scope', () => {
  const base = { scope: 'workspace-a', endpoint: 'https://example.test', model: 'm1', role: 'executor', system: 's', tools };
  assert.equal(cacheSessionId(base), cacheSessionId({ ...base, tools: [tools[1], tools[0]] }));
  assert.notEqual(cacheSessionId(base), cacheSessionId({ ...base, role: 'planner' }));
  assert.notEqual(cacheSessionId(base), cacheSessionId({ ...base, model: 'm2' }));
  assert.notEqual(cacheSessionId(base), cacheSessionId({ ...base, scope: 'workspace-b' }));
});

test('prefix diagnostics expose digest names only', () => {
  const first = prefixShape({ system: 'secret one', tools, messages: [{ content: [{ type: 'text', text: 'workspace one' }] }] });
  const second = prefixShape({ system: 'secret two', tools, messages: [{ content: [{ type: 'text', text: 'workspace one' }] }] });
  assert.deepEqual(comparePrefixShapes(first, second), ['systemDigest']);
  assert.equal(JSON.stringify(second).includes('secret'), false);
  assert.equal(JSON.stringify(second).includes('workspace one'), false);
});


test('DeepSeek uses stable tool order and honors the prompt-cache rollback switch', () => {
  const previous = process.env.HMCODEX_PROMPT_CACHE;
  try {
    delete process.env.HMCODEX_PROMPT_CACHE;
    assert.deepEqual(deepSeekToolDefinitions(tools).map((tool) => tool.name), ['a', 'z']);
    process.env.HMCODEX_PROMPT_CACHE = 'off';
    assert.deepEqual(deepSeekToolDefinitions(tools).map((tool) => tool.name), ['z', 'a']);
  } finally {
    if (previous === undefined) delete process.env.HMCODEX_PROMPT_CACHE;
    else process.env.HMCODEX_PROMPT_CACHE = previous;
  }
});