import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionEngine } from '../src/decision/engine.mjs';
import { createJevMetrics, createStageTimer } from '../src/decision/jev-metrics.mjs';
import { proposedToolDecisionClaim } from '../src/decision/evidence-claim.mjs';
import {
  READONLY_FAST_PATH_REASON, READONLY_FAST_PATH_TOOLS, isRelativeWorkspacePath, readonlyFastPathDecision
} from '../src/decision/readonly-fast-path.mjs';
import { PLAN_TIERS, councilForTier, planTierCandidates, planTierInactiveReason } from '../src/decision/plan-tier.mjs';
import { resolveDecisionConfig, validateModelConfig } from '../src/model-config.mjs';

const fastPath = (name, request, overrides = {}) => readonlyFastPathDecision({
  enabled: true, name, registered: true, toolReadOnly: true, request,
  proposedInputClaim: proposedToolDecisionClaim(name, request), ...overrides
});

test('fast path allowlist is exactly workspace.list|read|focus and kernel.workspace_list|read|focus', () => {
  assert.deepEqual([...READONLY_FAST_PATH_TOOLS].sort(), [
    'kernel.workspace_focus', 'kernel.workspace_list', 'kernel.workspace_read',
    'workspace.focus', 'workspace.list', 'workspace.read'
  ]);
  for (const name of READONLY_FAST_PATH_TOOLS) {
    const decision = fastPath(name, { path: 'README.md' });
    assert.equal(decision?.decision, 'ALLOW', name);
    assert.equal(decision.reasonCode, READONLY_FAST_PATH_REASON);
    assert.equal(decision.source, 'rule');
    assert.equal(decision.fallbackUsed, false);
  }
});

test('fast path refuses session tools, host_request, side effects and non-allowlisted read-only tools', () => {
  for (const name of ['kernel.session_get', 'kernel.session_list', 'kernel.session_set', 'kernel.session_delete',
    'kernel.host_request', 'file.write', 'file.patch', 'shell.execute', 'test.execute', 'file.diff', 'git.status']) {
    assert.equal(fastPath(name, { path: 'README.md' }), undefined, name);
  }
});

test('fast path requires flag, registration, readOnly flag and a relative in-workspace path', () => {
  assert.equal(fastPath('workspace.read', { path: 'README.md' }, { enabled: false }), undefined);
  assert.equal(fastPath('workspace.read', { path: 'README.md' }, { registered: false }), undefined);
  assert.equal(fastPath('workspace.read', { path: 'README.md' }, { toolReadOnly: false }), undefined);
  for (const path of ['/etc/passwd', '../secret', 'src/../../x', 'C:\\Windows\\system.ini', '\\\\server\\share', '~/x', 'a'.repeat(200), 'naïve.md']) {
    assert.equal(fastPath('workspace.read', { path }), undefined, path);
  }
  assert.equal(fastPath('workspace.list', {})?.decision, 'ALLOW', 'missing path means workspace root');
  assert.equal(fastPath('workspace.list', { path: '' })?.decision, 'ALLOW');
  assert.equal(fastPath('workspace.read', { path: 'src/index.mjs' })?.decision, 'ALLOW');
  assert.equal(fastPath('workspace.read', { path: 'README.md', cwd: '.' }), undefined, 'cwd is never fast-pathed');
  assert.equal(readonlyFastPathDecision({ enabled: true, name: 'workspace.read', registered: true, toolReadOnly: true,
    request: { path: 'README.md' }, proposedInputClaim: { untrustedProposedInput: { pathClass: 'OUTSIDE_OR_OPAQUE' } } }), undefined);
  assert.equal(readonlyFastPathDecision({ enabled: true, name: 'workspace.read', registered: true, toolReadOnly: true,
    request: { path: 'README.md' } }), undefined, 'missing claim fails closed');
  assert.equal(isRelativeWorkspacePath(undefined), true);
  assert.equal(isRelativeWorkspacePath(42), false);
});

test('plan tier: inactive reasons, host filtering and council mapping', () => {
  const base = { agentMode: 'multi', decisionEnabled: true, planTierEnabled: true, topologyEnabled: false, resumedPlan: false };
  assert.equal(planTierInactiveReason(base), undefined);
  assert.equal(planTierInactiveReason({ ...base, planTierEnabled: false }), 'PLAN_TIER_DISABLED');
  assert.equal(planTierInactiveReason({ ...base, agentMode: 'single' }), 'PLAN_TIER_SINGLE_AGENT');
  assert.equal(planTierInactiveReason({ ...base, decisionEnabled: false }), 'PLAN_TIER_JEV_DISABLED');
  assert.equal(planTierInactiveReason({ ...base, resumedPlan: true }), 'PLAN_TIER_RESUMED_PLAN');
  assert.equal(planTierInactiveReason({ ...base, topologyEnabled: true }), 'PLAN_TIER_TOPOLOGY_EXCLUSIVE');
  assert.deepEqual(PLAN_TIERS, ['DIRECT', 'PLAN', 'PLAN_COUNCIL']);
  assert.deepEqual(planTierCandidates({ mode: 'READ_ONLY', taskClass: 'inspect' }), ['DIRECT', 'PLAN', 'PLAN_COUNCIL']);
  assert.deepEqual(planTierCandidates({ mode: 'CONTROLLED', taskClass: 'inspect' }), ['DIRECT', 'PLAN', 'PLAN_COUNCIL']);
  assert.deepEqual(planTierCandidates({ mode: 'CONTROLLED', taskClass: 'modify' }), ['PLAN', 'PLAN_COUNCIL']);
  assert.deepEqual(planTierCandidates({ mode: 'CONTROLLED', taskClass: 'test' }), ['PLAN', 'PLAN_COUNCIL']);
  for (const heuristic of [true, false]) {
    assert.equal(councilForTier('DIRECT', heuristic), false);
    assert.equal(councilForTier('PLAN', heuristic), false);
    assert.equal(councilForTier('PLAN_COUNCIL', heuristic), heuristic, 'PLAN_COUNCIL is today\'s multi heuristic');
    assert.equal(councilForTier('BOGUS', heuristic), heuristic, 'unknown tier keeps the heuristic');
    assert.equal(councilForTier(undefined, heuristic), heuristic);
  }
});

test('speed flags default OFF and parse from DDA_JEV_* env or decision config', () => {
  const off = resolveDecisionConfig({ fileConfig: {}, env: {} });
  assert.equal(off.readonlyFastPathEnabled, undefined);
  assert.equal(off.planTierEnabled, undefined);
  const on = resolveDecisionConfig({ fileConfig: {}, env: { DDA_JEV_READONLY_FAST_PATH: '1', DDA_JEV_PLAN_TIER_ENABLED: 'true' } });
  assert.equal(on.readonlyFastPathEnabled, true);
  assert.equal(on.planTierEnabled, true);
  const file = resolveDecisionConfig({ fileConfig: { decision: { readonlyFastPathEnabled: true, planTierEnabled: false } }, env: {} });
  assert.equal(file.readonlyFastPathEnabled, true);
  assert.equal(file.planTierEnabled, false);
  assert.throws(() => validateModelConfig({ provider: 'openai', model: 'x', decision: { planTierEnabled: 'yes' } }), /decision\.planTierEnabled/);
  assert.equal(on.batchVerifyEnabled, undefined, 'BATCH_VERIFY is intentionally not implemented');
});

test('jev metrics aggregate per kind with latency percentiles; stage timer accumulates', async () => {
  const metrics = createJevMetrics();
  for (const latencyMs of [10, 20, 30, 40, 100]) metrics.recordRequest('ACTION_GATE', { latencyMs });
  metrics.recordRequest('ACTION_GATE', { latencyMs: 5, ok: false });
  metrics.recordDecision('ACTION_GATE', { fallbackUsed: true });
  metrics.recordDecision('ACTION_GATE', { shortCircuitReason: 'READONLY_FAST_PATH' });
  const summary = metrics.summary();
  assert.equal(summary.byKind.ACTION_GATE.requests, 6);
  assert.equal(summary.byKind.ACTION_GATE.requestErrors, 1);
  assert.equal(summary.byKind.ACTION_GATE.fallbacks, 1);
  assert.deepEqual(summary.byKind.ACTION_GATE.shortCircuitReasons, { READONLY_FAST_PATH: 1 });
  assert.equal(summary.byKind.ACTION_GATE.latency.totalMs, 205);
  assert.equal(summary.byKind.ACTION_GATE.latency.maxMs, 100);
  assert.equal(summary.byKind.ACTION_GATE.latency.p50Ms, 20);
  assert.equal(summary.byKind.ACTION_GATE.latency.p95Ms, 100);
  assert.equal(summary.totals.requests, 6);
  let clock = 0;
  const timer = createStageTimer({ now: () => clock });
  await timer.time('planner', async () => { clock += 7; });
  await timer.wrap('planner', async () => { clock += 3; })();
  await assert.rejects(timer.time('council', async () => { clock += 2; throw new Error('boom'); }));
  assert.deepEqual(timer.summary(), { council: { count: 1, totalMs: 2, maxMs: 2 }, planner: { count: 2, totalMs: 10, maxMs: 7 } });
});

test('engine counts Jev requests per kind and hard-decision short circuits without a request', async () => {
  const calls = [];
  const client = { model: 'fake', decide: async ({ questions }) => {
    calls.push(Object.keys(questions));
    if (questions.actionGate) return { answers: { actionGate: { choice: 'ALLOW' } }, latencyMs: 12 };
    if (questions.verification) return { answers: { verification: { choice: 'PASS' } }, latencyMs: 30 };
    if (questions.candidate) return { answers: { candidate: { choice: 'DIRECT' } }, latencyMs: 4 };
    return { answers: {}, latencyMs: 1 };
  } };
  const engine = createDecisionEngine({ client, enabled: true, enforce: true, config: { maxStateChars: 16000 } });
  const gated = await engine.decideActionGate({ state: { tool: 'file.write', toolReadOnly: false } });
  assert.equal(gated.decision, 'ALLOW');
  const fast = await engine.decideActionGate({ state: { tool: 'workspace.read', toolReadOnly: true }, hardDecision: {
    decision: 'ALLOW', confidence: 1, source: 'rule', fallbackUsed: false, reasonCode: READONLY_FAST_PATH_REASON } });
  assert.equal(fast.reasonCode, READONLY_FAST_PATH_REASON);
  assert.equal(calls.length, 1, 'hard decision never reaches Jev');
  const tier = await engine.selectCandidates({ state: { action: { kind: 'SELECT_PLAN_TIER' } },
    candidates: PLAN_TIERS.map((candidateId) => ({ candidateId, status: 'SUCCEEDED' })) });
  assert.equal(tier.selectedCandidateId, 'DIRECT');
  const verify = await engine.judgeVerification({ state: {}, ruleStatus: 'PASS' });
  assert.equal(verify.decision, 'PASS');
  const failed = await engine.judgeVerification({ state: {}, ruleStatus: 'FAIL' });
  assert.equal(failed.decision, 'FAIL', 'rule FAIL is never upgraded');
  const metrics = engine.metrics();
  assert.equal(metrics.byKind.ACTION_GATE.decisions, 2);
  assert.equal(metrics.byKind.ACTION_GATE.requests, 1);
  assert.equal(metrics.byKind.ACTION_GATE.shortCircuits, 1);
  assert.deepEqual(metrics.byKind.ACTION_GATE.shortCircuitReasons, { READONLY_FAST_PATH: 1 });
  assert.equal(metrics.byKind.ACTION_GATE.latency.totalMs, 12);
  assert.equal(metrics.byKind.SELECT_PLAN_TIER.requests, 1);
  assert.equal(metrics.byKind.VERIFY_BEHAVIOR.requests, 1);
  assert.equal(metrics.byKind.VERIFY_BEHAVIOR.decisions, 2);
  assert.equal(metrics.byKind.VERIFY_BEHAVIOR.shortCircuits, 1);
});

test('engine metrics record request errors and fallbacks without changing fail-closed results', async () => {
  const engine = createDecisionEngine({ client: { decide: async () => { throw Object.assign(new Error('t'), { code: 'JEV_TIMEOUT', latencyMs: 9 }); } },
    enabled: true, enforce: true, config: {} });
  const gate = await engine.decideActionGate({ state: { tool: 'file.write', toolReadOnly: false } });
  assert.equal(gate.decision, 'REQUIRE_APPROVAL');
  assert.equal(gate.source, 'rule');
  const verify = await engine.judgeVerification({ state: {}, ruleStatus: 'PASS' });
  assert.equal(verify.decision, 'UNCERTAIN', 'existing timeout semantics unchanged');
  const tier = await engine.selectCandidates({ state: { action: { kind: 'SELECT_PLAN_TIER' } },
    candidates: PLAN_TIERS.map((candidateId) => ({ candidateId, status: 'SUCCEEDED' })) });
  assert.equal(tier.source, 'rule');
  const metrics = engine.metrics();
  assert.equal(metrics.byKind.ACTION_GATE.requestErrors, 1);
  assert.equal(metrics.byKind.ACTION_GATE.fallbacks, 1);
  assert.equal(metrics.byKind.VERIFY_BEHAVIOR.latency.totalMs, 9);
  assert.equal(metrics.byKind.SELECT_PLAN_TIER.fallbacks, 1);
  const disabled = createDecisionEngine({ enabled: false });
  await disabled.decideActionGate({ state: { toolReadOnly: true } });
  assert.equal(disabled.metrics().byKind.ACTION_GATE.requests, 0);
});
