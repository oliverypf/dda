import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreOne } from '../../bench/score-topology-run.mjs';

// Locked by out-audit-run172-t2-312-r1/{conclusion.md,validation.json}:
// scorer L150–156 searches only the last verification for a test-id PASS;
// L188 defines classic without tests_green; L197–199 sets green/tag.
const classicGreen = score => score.exit === 0 && score.ok_final === true
  && score.last_ver === 'PASS' && score.pfu === 0;
const event = (kind, payload) => ({ type: 'runtime_event', kind, payload });
const verification = (checks, status = 'PASS') => event('verification.completed', {
  status, failureCodes: [], checks,
});

function fixtureScore(t, events, { exit = 0, ok = true } = {}) {
  const outputRoot = fileURLToPath(new URL('../out-tests-green-classic-lock-r1/', import.meta.url));
  fs.mkdirSync(outputRoot, { recursive: true });
  const benchRoot = fs.mkdtempSync(path.join(outputRoot, 'tgcl-score-'));
  t.after(() => fs.rmSync(benchRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(benchRoot, 't1'));
  const file = path.join(benchRoot, 't1', 'fixture');
  fs.writeFileSync(`${file}.jsonl`, [...events, { ok, harness: {} }].map(e => JSON.stringify(e)).join('\n'));
  fs.writeFileSync(`${file}.exit.json`, JSON.stringify({ exit, elapsedMs: 1 }));
  return scoreOne({ T: 1, label: 'fixture', subj: 'fixture', folder: 't1' }, { benchRoot });
}

test('T-tgcl-1 classic PASS permits final tests SKIPPED despite earlier test PASS', t => {
  const score = fixtureScore(t, [
    verification([{ id: 'evidence.tests', status: 'PASS' }]),
    verification([
      { id: 'evidence.tests', status: 'SKIPPED' },
      { id: 'output.non_empty', status: 'PASS' },
      { id: 'workspace.authorized', status: 'PASS' },
    ]),
  ]);
  assert.deepEqual([score.exit, score.ok_final, score.last_ver, score.pfu], [0, true, 'PASS', 0]);
  const classic = classicGreen(score);
  assert.equal(classic, true);
  assert.equal(score.tests_green, false);
  assert.notEqual(score.tests_green, classic);
  assert.equal(score.green, true);
  assert.equal(score.tag, 'PASS');
  assert.deepEqual(score.path_tags, []);
});

test('T-tgcl-2 final test-id PASS and independently computed classic can both be true', t => {
  for (const id of ['evidence.tests', 'execute.evidence.tests']) {
    const score = fixtureScore(t, [
      verification([{ id, status: 'SKIPPED' }]),
      verification([{ id, status: 'PASS' }, { id: 'output.non_empty', status: 'PASS' }]),
    ]);
    assert.deepEqual([score.exit, score.ok_final, score.last_ver, score.pfu], [0, true, 'PASS', 0]);
    assert.equal(score.tests_green, true, id);
    assert.equal(classicGreen(score), true, id);
    assert.equal(score.green, true, id);
    assert.equal(score.tag, 'PASS', id);
  }
});

test('T-tgcl-3 final test PASS does not satisfy any missing classic gate', t => {
  for (const { name, options, events = [], status = 'PASS', expected } of [
    { name: 'nonzero exit', options: { exit: 1 }, expected: [1, true, 'PASS', 0] },
    { name: 'final ok false', options: { ok: false }, expected: [0, false, 'PASS', 0] },
    { name: 'last verification FAIL', status: 'FAIL', expected: [0, true, 'FAIL', 0] },
    {
      name: 'plan UNCERTAIN',
      events: [event('plan.step_changed', { reason: 'execute:1:UNCERTAIN' })],
      expected: [0, true, 'PASS', 1],
    },
  ]) {
    const score = fixtureScore(t, [
      ...events,
      verification([{ id: 'evidence.tests', status: 'PASS' }], status),
    ], options);
    assert.deepEqual([score.exit, score.ok_final, score.last_ver, score.pfu], expected, name);
    const classic = classicGreen(score);
    assert.equal(classic, false, name);
    assert.equal(score.tests_green, true, name);
    assert.notEqual(score.tests_green, classic, name);
    assert.equal(score.green, false, name);
    assert.equal(score.tag, 'MISS', name);
  }
});

test('T-tgcl-4 read-only run172a replay preserves the t2-312 NO_PRODUCT_KNIFE audit', () => {
  const benchRoot = fileURLToPath(new URL('../../bench/', import.meta.url));
  const score = scoreOne({ T: 2, label: 'run172a', subj: 't2-312', folder: 't2' }, { benchRoot });
  assert.deepEqual([score.exit, score.ok_final, score.last_ver, score.pfu], [0, true, 'PASS', 0]);
  const classic = classicGreen(score);
  assert.equal(classic, true);
  assert.equal(score.tests_green, false);
  assert.notEqual(score.tests_green, classic);
  assert.equal(score.green, true);
  assert.equal(score.tag, 'PASS');
  assert.deepEqual(score.path_tags, []);
  assert.equal(score.dgrPromoteCount, 0);
  assert.equal(score.tipPathCount, 0);
});
