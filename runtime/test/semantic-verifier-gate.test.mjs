import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSemanticVerifierIndependence } from '../src/semantic-verifier-gate.mjs';

const providerA = { stream() {} };
const providerB = { stream() {} };
const executorBinding = { kind: 'MODEL', modelId: 'provider-a/model-1' };
const semanticBinding = { kind: 'MODEL', modelId: 'provider-b/model-2' };
const executorModel = { provider: 'provider-a', model: 'model-1' };
const semanticModel = { provider: 'provider-b', model: 'model-2' };

test('low-risk read-only work does not require a separate semantic verifier', () => {
  const gate = evaluateSemanticVerifierIndependence({
    mode: 'READ_ONLY', taskClass: 'inspect', executorBinding, semanticBinding, executorProvider: providerA, semanticProvider: undefined
  });
  assert.equal(gate.required, false);
  assert.equal(gate.satisfied, true);
});

test('high-risk work requires a distinct model and provider instance', () => {
  const gate = evaluateSemanticVerifierIndependence({
    mode: 'CONTROLLED', taskClass: 'modify', executorBinding, semanticBinding, executorProvider: providerA, semanticProvider: providerB, executorModel, semanticModel
  });
  assert.equal(gate.required, true);
  assert.equal(gate.satisfied, true);
});

test('reusing the executor provider or model identity fails closed', () => {
  for (const semantic of [
    { semanticBinding, semanticProvider: providerA, semanticModel },
    { semanticBinding: { ...semanticBinding, modelId: 'provider-a/model-1' }, semanticProvider: providerB, semanticModel: executorModel }
  ]) {
    const gate = evaluateSemanticVerifierIndependence({
      mode: 'CONTROLLED', taskClass: 'modify', executorBinding, executorProvider: providerA, executorModel, ...semantic
    });
    assert.equal(gate.satisfied, false);
    assert.equal(gate.reasonCode, 'SEMANTIC_VERIFIER_INDEPENDENCE_REQUIRED');
  }
});
