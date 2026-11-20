import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePlannerPlan, restorePlannerPlan } from '../src/agent-turns.mjs';
import { createPlanStepCoordinator } from '../src/plan-step-coordinator.mjs';
import { directObservationPlan, applyCouncilReview, councilObservation, councilRegistryObservation, councilProbeFinding, councilStepContext, dependencyFindings } from '../src/plan-review.mjs';
import { readCouncilFinding, saveCouncilFinding, deleteRunResponse, readStepFinding, saveStepFinding } from '../src/run-response-store.mjs';

test('the direct path is limited to bounded observations', () => {
  const options = { prompt: 'Read README.md and report the marker.', taskClass: 'inspect', ruleTaskClass: 'inspect' };
  assert.equal(directObservationPlan(options).steps[0].actionKind, 'READ');
  for (const change of [{ requiresMutation: true }, { requiresBuildTest: true }, { pinnedTopology: 'PLAN_THEN_EXECUTE' },
    { prompt: 'Read README.md, then compare with note.txt' }, { tierEnabled: true, tier: 'PLAN' },
    { taskClass: 'modify' }, { prompt: 'Read README.md and delete it.' }]) assert.equal(directObservationPlan({ ...options, ...change }), undefined);
});

test('plan review keeps initial clarification and original dependencies, and forwards only selected advice', () => {
  const plan = normalizePlannerPlan({ steps: [
    { stepId: 'ask', actionKind: 'CLARIFY', summary: 'Which input?' },
    { stepId: 'inspect', actionKind: 'READ', summary: 'Read the input', dependencies: ['ask'] },
    { stepId: 'report', actionKind: 'REPORT', summary: 'Report the result', dependencies: ['inspect'] }
  ] });
  const proposals = [{ proposalId: 'a', summary: 'Use source A' }, { proposalId: 'b', summary: 'Use source B', nextActions: ['check headers'] }];
  const verdict = { decision: 'REQUEST_PROBE', probe: 'Which format does the input use?', selectedProposalIds: ['b'] };
  const reviewed = applyCouncilReview(plan, { verdict, proposals });
  assert.deepEqual(reviewed.plan.steps.map(s => [s.stepId, s.dependencies]), [
    ['council-probe', ['ask']], ['ask', []], ['inspect', ['ask', 'council-probe']], ['report', ['inspect']]
  ]);
  assert.notEqual(reviewed.plan.planDigest, plan.planDigest);
  assert.match(councilStepContext(reviewed.review, 'report'), /Use source B check headers/);
  assert.doesNotMatch(councilStepContext(reviewed.review, 'report'), /Use source A/);
  const accepted = applyCouncilReview(plan, { proposals, verdict: { decision: 'ACCEPT_PLAN', selectedProposalIds: ['a'] } });
  assert.equal(accepted.plan, plan);
  assert.match(councilStepContext(accepted.review, 'report'), /Use source A/);
  assert.equal(applyCouncilReview(plan, { proposals, verdict: { decision: 'ABSTAIN' } }).plan, plan);
  assert.throws(() => applyCouncilReview(plan, { proposals, verdict: { decision: 'ESCALATE' } }), /COUNCIL_ESCALATION_REQUIRED/);
});

test('resuming a passed probe restores its anchored observations and schedules only remaining work', async () => {
  const plan = normalizePlannerPlan({ steps: [{ stepId: 'report', actionKind: 'REPORT', summary: 'Report the encoding' }] });
  const reviewed = applyCouncilReview(plan, { verdict: { decision: 'REQUEST_PROBE', probe: 'Read the header' }, proposals: [] });
  assert.equal(councilProbeFinding({ text: 'guessed', actions: [] }), undefined);
  const action = { name: 'workspace.read', path: 'input.txt', outputDigest: 'sha256:' + 'a'.repeat(64), state: 'SUCCEEDED' };
  assert.equal(councilProbeFinding({ actions: [{ ...action, invocationAttempted: false }] }), undefined);
  const finding = councilProbeFinding({ actions: [action], conclusionText: 'The header declares UTF-8.' });
  const data = join(await mkdtemp(join(tmpdir(), 'dda-review-')), 'events.db');
  const anchor = await saveCouncilFinding(data, 'source', finding);
  assert.equal(await readCouncilFinding(data, 'another-run', anchor), undefined);
  assert.equal(await readCouncilFinding(data, 'source', 'wrong'), undefined);
  const restored = restorePlannerPlan({ ...reviewed.plan, steps: reviewed.plan.steps.map(s =>
    s.stepId === reviewed.review.probeId ? { ...s, status: 'SUCCEEDED', attempt: 1 } : s) });
  const coordinator = createPlanStepCoordinator({ coordinator: { setPlanStateAndFlush: async () => {} }, plan: restored });
  const executed = [];
  await coordinator.run({ executeStep: async ({ step }) => {
    executed.push(step.stepId);
    const context = councilStepContext(reviewed.review, step.stepId, await readCouncilFinding(data, 'source', anchor));
    assert.ok(context.includes('The header declares UTF-8.'));
    return { text: 'Reported' };
  }, verifyStep: async () => true });
  assert.deepEqual(executed, ['report']);
  await deleteRunResponse(data, 'source');
  assert.equal(await readCouncilFinding(data, 'source', anchor), undefined);
});

test('dependency findings retain separate sibling receipts through restore and deletion', async () => {
  const steps = [{stepId:'a', dependencies:[]}, {stepId:'b', dependencies:[]}, {stepId:'c', dependencies:['a']}, {stepId:'report', dependencies:['c']}];
  const store = join(await mkdtemp(join(tmpdir(), 'dda-dependency-')), 'events');
  const refs = await Promise.all(['a', 'b'].map(async stepId => {
    const finding = councilProbeFinding({ actions: [{ name: 'workspace.read', state: 'SUCCEEDED', outputDigest: 'digest-'+stepId,
      path: stepId+'.txt', verifiedResult: { preview: JSON.stringify({ content: 'read-'+stepId }) } }], text: 'summary-'+stepId });
    return { runId: 'original', stepId, findingDigest: await saveStepFinding(store, 'original', stepId, finding) };
  }));
  const findings = new Map(await Promise.all(refs.map(async ref => [ref.stepId, await readStepFinding(store, ref)])));
  for (const step of [steps[2],steps[3]]) {
    const text = dependencyFindings({steps}, step, findings);
    assert.match(text,/a.txt read-a/);
    assert.match(text,/summary-a/);
    assert.doesNotMatch(text,/b.txt|summary-b/);
  }
  assert.equal(dependencyFindings({steps},steps[1],findings), '');
  assert.equal(await readStepFinding(store,{...refs[0],stepId:'b'}), undefined);
  await deleteRunResponse(store,'original');
  for (const ref of refs) assert.equal(await readStepFinding(store,ref), undefined);
});


test('a legacy planning directive becomes only the exact catalog lookup or escalates', () => {
  const original = '请 planner 回传定向证据并修订计划后重新提交：(1) 确认工作区内存在受治理工具支持的演示文稿写入器（如 fast-generate-pptx），排除直接运行脚本；(2) 补入页数、语言和受众要求。';
  const observed = councilObservation(original);
  assert.equal(observed.toolId, 'fast-generate-pptx');
  assert.equal(observed.question, 'Is `fast-generate-pptx` registered in the runtime tool catalog?');
  const registry = { list: () => [{ name: 'file.write' }, { name: 'shell.execute' }] };
  assert.equal(councilRegistryObservation(observed.toolId, registry).registered, false);
  assert.equal(councilRegistryObservation('file.write', registry).registered, true);
  for (const invalid of ['Revise the plan and resubmit', 'Can you delete the output?', 'Read README.md and write the deck', 'Which file exists? What does it contain?']) {
    assert.throws(() => councilObservation(invalid), /COUNCIL_ESCALATION_REQUIRED/u);
  }
});
