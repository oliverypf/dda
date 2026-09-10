import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCouncil } from '../src/agent-council.mjs';

test('runs bounded independent proposals and requires an explicit judge', async () => {
  const council = createAgentCouncil({
    members: [{ id: 'planner-a', role: 'planner' }, { id: 'planner-b', role: 'planner' }],
    runMember: async ({ member }) => ({ claim: `${member.id} plan`, summary: 'bounded plan', confidence: 0.7 }),
    timeoutMs: 1000
  });
  const result = await council.run({ runId: 'run-1', input: { taskClass: 'inspect' } });
  assert.equal(result.state, 'ABSTAINED');
  assert.equal(result.verdict.reasonCode, 'JUDGE_REQUIRED');
  assert.equal(result.proposals.length, 2);
  assert.match(result.resultDigest, /^sha256:/);
});

test('judge can accept a proposal but cannot smuggle forbidden fields', async () => {
  const council = createAgentCouncil({
    members: [{ id: 'a', role: 'planner' }, { id: 'b', role: 'critic' }],
    runMember: async ({ member }) => ({ claim: member.id, summary: member.id }),
    judge: async ({ proposals }) => ({ decision: 'ACCEPT_PLAN', selectedProposalIds: [proposals[0].proposalId], rationale: 'evidence-backed' })
  });
  const result = await council.run({ runId: 'run-2', input: { safe: true }, evidence: [{ ref: 'e1' }] });
  assert.equal(result.state, 'DECIDED');
  assert.equal(result.verdict.decision, 'ACCEPT_PLAN');
  assert.equal(result.verdict.selectedProposalIds.length, 1);
  assert.equal(result.proposals[0].prompt, undefined);
  const forbidden = createAgentCouncil({
    members: [{ id: 'unsafe' }],
    runMember: async () => ({ prompt: 'secret', summary: 'bad' })
  });
  const rejected = await forbidden.run({ runId: 'run-3' });
  assert.equal(rejected.members[0].state, 'FAILED');
  assert.equal(rejected.proposals.length, 0);
});

test('contains member timeout and cancellation without executing effects', async () => {
  const controller = new AbortController();
  const council = createAgentCouncil({
    members: [{ id: 'slow', role: 'critic' }, { id: 'cancelled', role: 'critic' }],
    timeoutMs: 10,
    runMember: async ({ member, signal }) => {
      if (member.id === 'slow') await new Promise((resolve) => setTimeout(resolve, 40));
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'COUNCIL_CANCELLED' });
      return { claim: member.id, summary: member.id };
    }
  });
  const timed = await council.run({ runId: 'run-4' });
  assert.equal(timed.members[0].state, 'TIMED_OUT');
  controller.abort();
  const cancelled = await council.run({ runId: 'run-5', signal: controller.signal });
  assert.equal(cancelled.verdict.reasonCode, 'COUNCIL_CANCELLED');
  assert.ok(cancelled.members.every((member) => member.state === 'CANCELLED'));
});
