import test from 'node:test';
import assert from 'node:assert/strict';
import { notesPathAnomaly } from '../path-signals.mjs';

test('T-dma-2 notes: mid agent_miss and UNCERTAIN do not assert DGR or tip-path', () => {
  for (const notes of [
    'mid UNCERTAIN → agent_miss alone ≠ tip-path/DGR',
    'mid UNCERTAIN alone ≠ tip-path/DGR',
    'mid AF/BR alone ≠ DGR/tip-path（无 promote check）',
    'mid STALLED/RA alone ≠ tip-path/DGR',
  ]) {
    const flags = notesPathAnomaly(notes);
    assert.equal(flags.dgr, false, notes);
    assert.equal(flags.tipPath, false, notes);
    assert.equal(flags.any, true, `retain mid observation: ${notes}`);
    assert.equal(flags.agentMiss, notes.includes('agent_miss'), notes);
  }
  assert.deepEqual(notesPathAnomaly('直 PASS；无 DGR/tip-path'), {
    agentMiss: false, dgr: false, tipPath: false,
    postAmt: false, progressFail: false, any: false,
  });
});

test('T-dma-2 notes: positive promote clauses survive separate negative comparisons', () => {
  for (const [notes, dgr, tipPath] of [
    ['**tip-path**（`uncertain-tip-path`）；≠ DGR；同跑双信号未混标', false, true],
    ['**DGR**（`behavior-reject-promote`）；≠ tip-path', true, false],
    ['**DGR**（`behavior-reject-promote`）；mid AF/BR 为 DGR 前奏，alone ≠ DGR 标法', true, false],
    ['**DGR**；非 tip-path', true, false],
    ['agent_miss (not DGR); tip-path observed', false, true],
  ]) {
    const flags = notesPathAnomaly(notes);
    assert.equal(flags.dgr, dgr, notes);
    assert.equal(flags.tipPath, tipPath, notes);
    assert.equal(flags.any, true, notes);
  }
});

test('T-dma-2 notes: post_miss replans do not become post_amt', () => {
  for (const notes of [
    '`post_miss_terminal_replan`≠post_amt',
    '`post_miss_uncertain_replan` / `evidence_delta_replan` ≠ post_amt',
    'mid harness replan ≠ post_amt',
  ]) {
    const flags = notesPathAnomaly(notes);
    assert.equal(flags.postAmt, false, notes);
    assert.equal(flags.dgr, false, notes);
    assert.equal(flags.tipPath, false, notes);
    assert.equal(flags.any, true, notes);
  }
  assert.equal(notesPathAnomaly('post_amt observed').postAmt, true);
  assert.equal(notesPathAnomaly('harness.post_agent_miss_terminal_replan observed').postAmt, true);
});
