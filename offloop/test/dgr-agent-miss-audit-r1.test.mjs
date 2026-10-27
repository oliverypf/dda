import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countPathSignals } from '../path-signals.mjs';
import { scoreOne } from '../../bench/score-topology-run.mjs';

const DGR = 'deterministic-green-jev-behavior-reject-promote';
const TIP = 'deterministic-green-jev-uncertain-tip-path';
const event = (kind, payload = {}) => ({ type: 'runtime_event', kind, payload });
const verification = (ids, status = 'PASS', failureCodes = []) => event('verification.completed', {
  status, failureCodes, checks: ids.map(id => ({ id, status: 'PASS' })),
});

test('T-dma-2 mid AF/BR/RA and UNCERTAIN replans alone are neither promote nor post_amt', () => {
  const signals = countPathSignals([
    event('harness.agent_miss_replan', { status: 'FAIL', failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED', 'RETRY_ALLOWED'] }),
    event('harness.agent_miss_replan', { status: 'UNCERTAIN' }),
    event('harness.post_miss_uncertain_replan'),
    event('harness.post_miss_evidence_delta_replan'),
    event('harness.post_miss_uncertain_exhausted_replan'),
    event('harness.post_miss_terminal_replan'),
    verification(['jev-behavior-judge'], 'FAIL', ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED']),
  ]);
  assert.equal(signals.agentMissCount, 2);
  assert.equal(signals.postMissUncertainCount, 3);
  assert.equal(signals.postAmtCount, 0);
  assert.equal(signals.dgrPromoteCount, 0);
  assert.equal(signals.tipPathCount, 0);
});

test('T-dma-2 same-run DGR and tip-path cells retain separate evidence and counters', () => {
  const dgr = countPathSignals([event('harness.agent_miss_replan'), verification([DGR]), verification([`execute.${DGR}`])]);
  const tip = countPathSignals([event('harness.agent_miss_replan'), verification([TIP]), verification([`execute.${TIP}`])]);
  assert.deepEqual([dgr.dgrPromoteCount, dgr.tipPathCount, dgr.agentMissCount], [2, 0, 1]);
  assert.deepEqual([tip.dgrPromoteCount, tip.tipPathCount, tip.agentMissCount], [0, 2, 1]);
  assert.equal(dgr.evidenceQuotes.some(q => q.kind === 'tip_path'), false);
  assert.equal(tip.evidenceQuotes.some(q => q.kind === 'dgr_promote'), false);
  const repeated = countPathSignals([verification([DGR]), { harness: { verification: { checks: [{ id: DGR }] } } }]);
  assert.equal(repeated.dgrPromoteCount, 1);
});

function fixtureScore(t, events, { exit = 0, ok = true } = {}) {
  const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dma-score-'));
  t.after(() => fs.rmSync(benchRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(benchRoot, 't1'));
  const file = path.join(benchRoot, 't1', 'fixture');
  fs.writeFileSync(`${file}.jsonl`, [...events, { ok, harness: {} }].map(e => JSON.stringify(e)).join('\n'));
  fs.writeFileSync(`${file}.exit.json`, JSON.stringify({ exit, elapsedMs: 1 }));
  return scoreOne({ T: 1, label: 'fixture', subj: 'fixture', folder: 't1' }, { benchRoot });
}

test('T-dma-2 score labels PASS promote checks without converting agent_miss into DGR', t => {
  for (const [id, expected] of [[DGR, 'DGR'], [TIP, 'tip-path']]) {
    const score = fixtureScore(t, [event('harness.agent_miss_replan'), verification([id]), verification([`execute.${id}`])]);
    assert.equal(score.green, true);
    assert.equal(score.tag, `PASS（${expected}）`);
    assert.deepEqual(score.path_tags, [expected]);
    assert.equal(score.dgrPromoteCount, id === DGR ? 2 : 0);
    assert.equal(score.tipPathCount, id === TIP ? 2 : 0);
  }
  const mid = fixtureScore(t, [event('harness.agent_miss_replan'), verification([])]);
  assert.equal(mid.tag, 'PASS');
  assert.deepEqual(mid.path_tags, []);
  const both = fixtureScore(t, [verification([DGR, TIP])]);
  assert.deepEqual(both.path_tags, ['DGR', 'tip-path']);
});

test('T-dma-2 legacy FAIL/reject without a promote check does not green or label DGR', t => {
  const score = fixtureScore(t, [
    event('plan.step_changed', { reason: 'execute:1:SUCCEEDED' }),
    event('harness.agent_miss_replan'),
    verification([], 'FAIL', ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED']),
  ]);
  assert.equal(score.green, false);
  assert.equal(score.tag, 'MISS');
  assert.deepEqual(score.path_tags, []);
});

test('T-dma-2 promote tags preserve exit/final-ok and plan-UNCERTAIN hard gates', t => {
  for (const options of [{ exit: 1 }, { ok: false }]) {
    const score = fixtureScore(t, [verification([DGR])], options);
    assert.equal(score.green, false);
    assert.equal(score.tag, 'MISS');
    assert.deepEqual(score.path_tags, ['DGR']);
  }
  const score = fixtureScore(t, [event('plan.step_changed', { reason: 'execute:1:UNCERTAIN' }), verification([TIP])]);
  assert.equal(score.green, false);
  assert.equal(score.tag, 'MISS');
});
