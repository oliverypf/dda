import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_PROFILE_FULL,
  EXECUTION_PROFILE_LOOKUP,
  EXECUTION_PROFILE_READONLY,
  ROLE_SET_EXECUTOR,
  ROLE_SET_FULL,
  ROLE_SETS,
  executionToolAllowed,
  normalizeExecutionProfile,
  preferFirst,
  ruleExecutionProfile,
  ruleRoleSetId
} from '../src/decision/bounded-judgments.mjs';
import { resolveDecisionConfig } from '../src/model-config.mjs';

test('rule role set and execution profile stay the fallback', () => {
  assert.equal(ruleRoleSetId('query'), ROLE_SET_EXECUTOR);
  assert.equal(ruleRoleSetId('inspect'), ROLE_SET_FULL);
  assert.deepEqual(ROLE_SETS[ROLE_SET_EXECUTOR], { executor: 'default' });
  assert.equal(ruleExecutionProfile('query'), EXECUTION_PROFILE_LOOKUP);
  assert.equal(ruleExecutionProfile('unknown'), EXECUTION_PROFILE_FULL);
  assert.deepEqual(preferFirst(['executor-only', 'full-roles'], 'full-roles'), ['full-roles', 'executor-only']);
});

test('execution profiles keep the tool boundary inside the chosen id', () => {
  assert.equal(normalizeExecutionProfile('nope', 'query'), EXECUTION_PROFILE_LOOKUP);
  assert.equal(executionToolAllowed(EXECUTION_PROFILE_LOOKUP, 'workspace.read'), false);
  assert.equal(executionToolAllowed(EXECUTION_PROFILE_LOOKUP, 'network.request'), true);
  assert.equal(executionToolAllowed(EXECUTION_PROFILE_READONLY, 'workspace.read'), true);
  assert.equal(executionToolAllowed(EXECUTION_PROFILE_READONLY, 'file.write'), false);
  assert.equal(executionToolAllowed(EXECUTION_PROFILE_READONLY, 'network.request'), false);
  assert.equal(executionToolAllowed(EXECUTION_PROFILE_FULL, 'file.write'), true);
});

test('the new Jev judgments default on and can be turned off', () => {
  const resolved = resolveDecisionConfig({ env: {} });
  assert.equal(resolved.roleSetEnabled, true);
  assert.equal(resolved.executionProfileEnabled, true);
  assert.equal(resolved.controlJudgmentsEnabled, true);
  assert.equal(resolved.singleAgentPlanEnabled, true);
  assert.equal(resolveDecisionConfig({
    fileConfig: { decision: { roleSetEnabled: false } },
    env: { DDA_JEV_EXECUTION_PROFILE_ENABLED: '0' }
  }).executionProfileEnabled, false);
  assert.equal(resolveDecisionConfig({
    fileConfig: { decision: { roleSetEnabled: false } }
  }).roleSetEnabled, false);
});
