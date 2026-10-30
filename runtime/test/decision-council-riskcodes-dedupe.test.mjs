// freeze-harness-council-riskcodes-dedupe-r1
//
// Run run-288259bb died in PLANNING with DECISION_INVALID_OPTIONS: the council
// decision mapped model-authored `proposal.risks` onto the cleanCodes alphabet,
// so every non-Latin risk collapsed to `_` and the duplicate check in
// decision-trace.mjs `cleanIds` failed the whole run.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentDecisionTrace } from '../src/decision-trace.mjs';
import { normalizeDecisionCodeList } from '../src/decision/reason-codes.mjs';

const CODE_CHARSET = /^[A-Za-z0-9_.:-]+$/;

// The exact mapping the council producer used before the fix.
const legacyRiskCodes = (risks) => (Array.isArray(risks)
  ? risks.map((risk) => String(risk).toUpperCase().replace(/[^A-Z0-9_.:-]+/gu, '_').slice(0, 120)).filter(Boolean).slice(0, 32)
  : []);

const baseInput = (overrides = {}) => ({
  runId: 'run-council',
  stepId: 'plan-review',
  agentInstanceId: 'agent-council',
  role: 'council',
  roleContextId: 'role-council',
  bindingSnapshotId: 'binding-1',
  decisionType: 'REVIEW_PLAN',
  objectiveRef: 'objective-1',
  constraintSnapshotId: 'constraints-1',
  featureSnapshotId: 'features-1',
  evidenceRefs: [],
  assumptions: [],
  options: [{
    optionId: 'council-proposal-a',
    actionKind: 'COUNCIL_PROPOSAL',
    summary: 'Council proposal A',
    requiredCapabilityIds: [],
    evidenceRefs: [],
    riskCodes: [],
    rejectionReasonCodes: []
  }],
  selectedOptionId: 'council-proposal-a',
  decisionSummary: 'Council APPROVE after 1 proposal',
  selectionCriteria: ['council-judge-selection'],
  reasonCodes: ['COUNCIL_APPROVE'],
  uncertaintyCodes: [],
  expectedOutcome: {
    successCriteriaRefs: ['criterion-plan-review'],
    predictedOutcomeCode: 'COUNCIL_PROPOSAL',
    predictedProgress: 0,
    predictedRiskCodes: []
  },
  outputRefs: [],
  sensitivity: 'INTERNAL',
  ...overrides
});

const traceAt = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-council-risk-'));
  return new AgentDecisionTrace({ storagePath: join(directory, 'decision-trace.json'), now: () => 100 });
};

test('non-Latin risks collapse to duplicate `_` under the legacy mapping', () => {
  const legacy = legacyRiskCodes(['编译耗时长', '依赖缺失']);
  assert.deepEqual(legacy, ['_', '_']);
  assert.notEqual(new Set(legacy).size, legacy.length);
});

test('normalizeDecisionCodeList keeps non-Latin risks distinct and valid', () => {
  const codes = normalizeDecisionCodeList(['编译耗时长', '依赖缺失'], { fallbackPrefix: 'RISK', uppercase: true });
  assert.equal(codes.length, 2);
  assert.equal(new Set(codes).size, 2);
  for (const code of codes) {
    assert.match(code, CODE_CHARSET);
    assert.match(code, /^RISK_[0-9a-f]{12}$/);
  }
});

test('normalizeDecisionCodeList dedupes differently spelled equal codes', () => {
  const codes = normalizeDecisionCodeList(['Missing dependency', 'missing_dependency'], { uppercase: true });
  assert.deepEqual(codes, ['MISSING_DEPENDENCY']);
});

test('normalizeDecisionCodeList caps at 32 and tolerates absent lists', () => {
  const many = Array.from({ length: 40 }, (_, index) => `RISK_${index}`);
  assert.equal(normalizeDecisionCodeList(many).length, 32);
  assert.deepEqual(normalizeDecisionCodeList(undefined), []);
  assert.deepEqual(normalizeDecisionCodeList('not-a-list'), []);
});

test('legacy council risk codes still fail closed at the trace store', async () => {
  const trace = await traceAt();
  const options = baseInput().options.map((option) => ({ ...option, riskCodes: legacyRiskCodes(['编译耗时长', '依赖缺失']) }));
  await assert.rejects(
    trace.propose(baseInput({ options })),
    /DECISION_INVALID_OPTIONS/
  );
});

test('normalized council risk codes propose and commit cleanly', async () => {
  const trace = await traceAt();
  const risks = ['编译耗时长', '依赖缺失', 'Missing dependency', 'missing_dependency'];
  const options = baseInput().options.map((option) => ({
    ...option,
    riskCodes: normalizeDecisionCodeList(risks, { fallbackPrefix: 'RISK', uppercase: true })
  }));
  const proposed = await trace.propose(baseInput({ options }));
  assert.equal(proposed.status, 'PROPOSED');
  const stored = proposed.options[0].riskCodes;
  assert.equal(new Set(stored).size, stored.length);
  for (const code of stored) assert.match(code, CODE_CHARSET);
  const committed = await trace.commit(proposed.decisionId);
  assert.equal(committed.status, 'COMMITTED');
});
