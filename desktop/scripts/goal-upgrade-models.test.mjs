import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveUpgradeModels, automaticStrongSelectionProven } from './goal-upgrade-models.mjs';
const config = { provider: 'openai-chat', protocol: 'chat-completions', model: 'active-wire-model', apiKeyEnv: 'EXISTING_KEY', baseURL: 'https://provider.test/v1' };
test('explicit model IDs reuse the configured provider route and distinct identities', () => {
  const result = resolveUpgradeModels(config, { strongModel: 'strong-wire-model' });
  assert.equal(result.active.model, config.model); assert.equal(result.strong.model, 'strong-wire-model');
  assert.equal(result.strong.apiKeyEnv, config.apiKeyEnv);
});
test('automatic upgrade requires real strong execution and Jev model selection, not only escalation or a rule fallback', () => {
  const evidence = { actualStrongExecutor: true, finalSuccess: true,
    events: [{ kind: 'DecisionLayerEvaluated', payload: { source: 'jev', action: 'ESCALATE' } }],
    decisions: [{ decisionType: 'SELECT_SAFE_MODEL_FALLBACK', selectedOptionId: 'strong-model', reasonCodes: ['JEV_DECISION'] }] };
  assert.equal(automaticStrongSelectionProven(evidence), true);
  assert.equal(automaticStrongSelectionProven({ ...evidence, decisions: [] }), false);
  assert.equal(automaticStrongSelectionProven({ ...evidence, decisions: [{ ...evidence.decisions[0], reasonCodes: ['MODEL_FALLBACK_DEFAULT'] }] }), false);
  assert.equal(automaticStrongSelectionProven({ ...evidence, actualStrongExecutor: false }), false);
  assert.equal(automaticStrongSelectionProven({ ...evidence, finalSuccess: false }), false);
});
test('configured role aliases resolve their real registered model and provider', () => {
  const result = resolveUpgradeModels({ ...config, models: [{ id: 'bound-strong', model: 'real-strong', apiKeyEnv: 'STRONG_KEY', endpoint: 'https://strong.test/chat/completions' }],
    roleBindings: { critic: { selector: 'PINNED', modelId: 'bound-strong' } } });
  assert.equal(result.strong.model, 'real-strong'); assert.equal(result.strong.apiKeyEnv, 'STRONG_KEY');
});
test('missing upgrade target, aliasing the same model and unsupported protocol cannot pass an upgrade test', () => {
  assert.throws(() => resolveUpgradeModels(config), /STRONG_MODEL_REQUIRED/u);
  assert.throws(() => resolveUpgradeModels(config, { strongModel: config.model }), /DISTINCT_ACTUAL_MODELS/u);
  assert.throws(() => resolveUpgradeModels({ ...config, models: [{ id: 'alias', model: config.model }] }, { strongModel: 'alias' }), /DISTINCT_ACTUAL_MODELS/u);
  assert.throws(() => resolveUpgradeModels({ ...config, protocol: 'responses' }, { strongModel: 'strong' }), /CHAT_COMPLETIONS/u);
});
