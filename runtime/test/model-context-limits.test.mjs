import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactionTriggerTokens,
  contextCompactionBudget,
  knownContextLimitTokens,
  messageCharBudget,
  parseContextLimitTokens,
  resolveContextLimitTokens,
  validateModelContextLimits
} from '../src/model-context-limits.mjs';

test('resolves a published window, an override, and a default for every model', () => {
  assert.equal(knownContextLimitTokens('deepseek-v4.1-flash'), 1_048_576);
  assert.equal(knownContextLimitTokens('deepseek/DeepSeek-V4.1-Flash'), 1_048_576);
  assert.equal(knownContextLimitTokens('deepseek-v40'), undefined);
  assert.deepEqual(resolveContextLimitTokens({ modelId: 'deepseek-v4.1-flash' }), {
    tokens: 1_048_576,
    source: 'builtin'
  });
  assert.deepEqual(resolveContextLimitTokens({
    modelId: 'DeepSeek-V4.1-Flash',
    limits: { 'deepseek-v4.1-flash': 200_000 }
  }), { tokens: 200_000, source: 'configured' });
  assert.deepEqual(resolveContextLimitTokens({ modelId: 'mimo-v2.5-pro' }), {
    tokens: 128_000,
    source: 'default'
  });
  assert.equal(resolveContextLimitTokens({ modelId: '' }).tokens, 128_000);
});

test('compacts before the window is full and leaves room for the completion', () => {
  const limit = 1_048_576;
  const trigger = compactionTriggerTokens(limit);
  assert.ok(trigger < limit - 131_072);
  assert.ok(trigger > 700_000);
  const budget = messageCharBudget({ limitTokens: limit, overheadChars: 20_000, charsPerToken: 2 });
  assert.equal(budget, trigger * 2 - 20_000);
  const tightened = contextCompactionBudget({
    limitTokens: 128_000,
    systemChars: 10_000,
    toolsChars: 30_000,
    charsPerToken: 2,
    envMaxChars: 8_000
  });
  assert.equal(tightened, 8_000);
  assert.equal(parseContextLimitTokens('8191'), undefined);
  assert.equal(parseContextLimitTokens(8_192), 8_192);
});

test('rejects a context-limit map that cannot be stored per model', () => {
  assert.deepEqual(validateModelContextLimits({
    'deepseek-v4.1-flash': 1_048_576
  }), { 'deepseek-v4.1-flash': 1_048_576 });
  assert.equal(validateModelContextLimits({}), undefined);
  assert.throws(() => validateModelContextLimits({ 'deepseek-v4.1-flash': 100 }), /modelContextLimits/);
  assert.throws(() => validateModelContextLimits({
    'deepseek-v4.1-flash': 128_000,
    'DeepSeek-V4.1-Flash': 200_000
  }), /modelContextLimits/);
  assert.throws(() => validateModelContextLimits(['deepseek-v4.1-flash']), /modelContextLimits/);
});
