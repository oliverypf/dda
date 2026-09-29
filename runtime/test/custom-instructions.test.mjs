import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCustomInstructions, normalizeCustomInstructions } from '../src/custom-instructions.mjs';
import { loadModelConfig, resolveModelConfig } from '../src/model-config.mjs';
import { withModelUsage } from '../src/model-usage.mjs';
import { prefixShape } from '../src/prompt-cache.mjs';

const instruction = '每次回复都使用中文。\n先给结论，再解释原因。';
const drain = async (provider, request) => { for await (const chunk of provider.stream(request)) {} };

test('global custom instructions survive config reload and provider/role changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-custom-instructions-'));
  const path = join(directory, 'model-config.json');
  await writeFile(path, JSON.stringify({ provider: 'openai-chat', customInstructions: `  ${instruction}\n`,
    roleBindings: { executor: 'backup' } }));
  const loaded = await loadModelConfig(path);
  assert.equal(loaded.customInstructions, instruction);
  const resolved = resolveModelConfig({ fileConfig: loaded, overrides: { provider: 'deepseek' }, env: {} });
  assert.equal(resolved.customInstructions, instruction);
  assert.equal(resolved.roleBindings.executor, 'backup');
  await writeFile(path, JSON.stringify({ customInstructions: '  \n\t' }));
  assert.equal((await loadModelConfig(path)).customInstructions, undefined);
  for (const invalid of [null, 1, [], 'x'.repeat(8001), 'text\0text']) {
    await writeFile(path, JSON.stringify({ customInstructions: invalid }));
    await assert.rejects(loadModelConfig(path), /MODEL_CONFIG_INVALID_FIELD:customInstructions/);
  }
  assert.equal(normalizeCustomInstructions('中'.repeat(8000)).length, 8000);
  assert.equal(normalizeCustomInstructions('😀'.repeat(4000)).length, 8000);
  assert.throws(() => normalizeCustomInstructions('😀'.repeat(4001)), /customInstructions/);
});

test('every role and tool round receives one system instruction without mutating messages', async () => {
  const requests = [];
  const delegate = { model: 'fixture', async *stream(request) { requests.push(request); yield { type: 'text-delta', text: '中文' }; } };
  assert.equal(withCustomInstructions(delegate, undefined), delegate);
  const provider = withCustomInstructions(delegate, instruction);
  const messages = [{ role: 'user', content: 'inspect README.md' }];
  for (const role of ['executor', 'planner', 'semanticVerifier', 'candidate', 'candidate-judge']) {
    const request = { system: `Role ${role}: preserve schema and host limits`, messages, cacheRole: role };
    await drain(provider, request);
    await drain(provider, request);
    assert.equal(request.system, `Role ${role}: preserve schema and host limits`);
  }
  assert.equal(requests.length, 10);
  for (const request of requests) {
    assert.equal(request.system.split(instruction).length, 2);
    assert.match(request.system, /preserve schema and host limits/);
    assert.equal(request.messages, messages);
  }
});

test('usage prefix fingerprints include custom instructions but never the plain text', async () => {
  let sent;
  const samples = [];
  const provider = withCustomInstructions(withModelUsage({ async *stream(request) {
    sent = request; yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { onUsage: (sample) => samples.push(sample) }), instruction);
  const request = { system: 'Base system', messages: [] };
  await drain(provider, request);
  assert.equal(samples[0].systemDigest, prefixShape(sent).systemDigest);
  assert.notEqual(samples[0].systemDigest, prefixShape(request).systemDigest);
  assert.equal(JSON.stringify(samples).includes(instruction), false);
});
