import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countPoisonLoops, evaluateWin, isProbeBudgetOnlyFailure } from '../poison-loop.mjs';
import { readJsonlEvents } from '../ingest.mjs';
import { probeL0 } from '../probe.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures');

test('T-ol-2: poison-loop-yes counts 1', () => {
  const events = readJsonlEvents(path.join(fixtures, 'poison-loop-yes.jsonl'));
  const r = countPoisonLoops(events);
  assert.equal(r.count, 1);
  assert.equal(r.dprCount, 1);
  assert.equal(r.instances[0].from, 'PLAN_THEN_EXECUTE');
  assert.equal(r.instances[0].to, 'DIAGNOSE_PROBE_RECOVER');
});

test('T-ol-2: poison-loop-no (TESTS_FAILED) counts 0', () => {
  const events = readJsonlEvents(path.join(fixtures, 'poison-loop-no.jsonl'));
  const r = countPoisonLoops(events);
  assert.equal(r.count, 0);
  assert.equal(r.dprCount, 1);
});

test('T-ol-2: false win = green without poison loop zero → do not adopt', () => {
  const win = evaluateWin({
    exitOk: true,
    summaryOk: true,
    verificationPass: true,
    poisonLoopCount: 2,
  });
  assert.equal(win.win, false);
  assert.equal(win.falseWin, true);

  const hyp = {
    id: 'H1',
    slug: 'post-dpr-sticky-execute',
    probeKind: 'soft_or_latch_md',
  };
  // Without simulate suppress, contrast still has poison → false win / no adopt
  const probe = probeL0(hyp, {
    jsonlPaths: [path.join(fixtures, 'false-win-poison.jsonl')],
    exitOk: true,
    summaryOk: true,
    verificationPass: true,
    simulateStickySuppress: false,
  });
  assert.equal(probe.adopt, false);
  assert.equal(probe.falseWin, true);
  assert.ok(probe.baseline.poison.count > 0);
});

test('T-ol-2: sticky suppress contrast → win and adopt', () => {
  const hyp = {
    id: 'H1',
    slug: 'post-dpr-sticky-execute',
    probeKind: 'soft_or_latch_md',
  };
  const probe = probeL0(hyp, {
    jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
    exitOk: true,
    summaryOk: true,
    verificationPass: true,
    simulateStickySuppress: true,
  });
  assert.equal(probe.baseline.poison.count, 1);
  assert.equal(probe.contrast.poison.count, 0);
  assert.equal(probe.adopt, true);
  assert.equal(probe.falseWin, false);
});

test('T-ol-2: isProbeBudgetOnlyFailure requires TOPOLOGY_BUDGET signal', () => {
  assert.equal(
    isProbeBudgetOnlyFailure(
      { failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'] },
      {
        failureCodes: ['ACTION_FAILED'],
        checks: [{ id: 'actions.progress', message: '1 fail (TOPOLOGY_BUDGET_PROBES)' }],
      },
    ),
    true,
  );
  assert.equal(
    isProbeBudgetOnlyFailure(
      { failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'] },
      { failureCodes: ['ACTION_FAILED'], checks: [{ id: 'actions.progress', message: 'write failed' }] },
    ),
    false,
  );
});
