import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeL1 } from '../probe.mjs';
import { composeCandidate } from '../compose.mjs';
import { countPoisonLoops } from '../poison-loop.mjs';
import { readJsonlEvents } from '../ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures');

const stickyHyp = {
  id: 'H1',
  slug: 'post-dpr-sticky-execute',
  title: 'Sticky PTE after DPR',
  probeKind: 'soft_or_latch_md',
  class: 'latch',
};

test('T-l1-1: probeL1 default skipped; enabled produces contrast summary', () => {
  const skipped = probeL1(stickyHyp, {});
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.enabled, false);
  assert.equal(skipped.adopt, null);
  assert.ok(skipped.notes?.some((n) => /skip/i.test(n)));

  const enabled = probeL1(stickyHyp, {
    enabled: true,
    mode: 'fixture',
    subjects: ['t3/run60a'],
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: '4439768',
      verificationPass: false,
      exitOk: true,
      summaryOk: true,
    },
    softLayer: {
      jsonlPaths: [path.join(fixtures, 'l1-soft-clean.jsonl')],
      tipSha: '4439768',
      worktree: 'soft-layer/docs-only',
      verificationPass: true,
      exitOk: true,
      summaryOk: true,
    },
  });
  assert.equal(enabled.skipped, false);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.level, 'L1');
  assert.ok(enabled.summary, 'must produce contrast summary');
  assert.equal(enabled.summary.contrast.softLayerOnly, true);
  assert.ok('poisonLoopCount' in enabled.summary.baseline);
  assert.ok('poisonLoopCount' in enabled.summary.contrast);
  assert.equal(enabled.summary.baseline.poisonLoopCount, 1);
  assert.equal(enabled.summary.contrast.poisonLoopCount, 0);
  assert.equal(enabled.adopt, true);
  assert.equal(enabled.falseWin, false);
  assert.equal(enabled.header.tipShaBaseline, '4439768');
});

test('T-l1-2: false-win (green but poison-loop not zero) → adopt=false', () => {
  const softEvents = readJsonlEvents(path.join(fixtures, 'l1-soft-false-win.jsonl'));
  const poison = countPoisonLoops(softEvents);
  assert.ok(poison.count > 0, 'fixture must keep poison-loop nonzero');

  const r = probeL1(stickyHyp, {
    enabled: true,
    mode: 'fixture',
    subjects: ['t3/fixture-fw'],
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: '4439768',
      verificationPass: false,
    },
    softLayer: {
      jsonlPaths: [path.join(fixtures, 'l1-soft-false-win.jsonl')],
      tipSha: '4439768',
      // scriptable green facade
      verificationPass: true,
      exitOk: true,
      summaryOk: true,
    },
  });
  assert.equal(r.skipped, false);
  assert.equal(r.falseWin, true);
  assert.equal(r.adopt, false);
  assert.equal(r.summary.contrast.poisonLoopCount > 0, true);
  assert.equal(r.contrast.win.falseWin, true);

  const composed = composeCandidate({
    hypothesis: stickyHyp,
    probeResult: r,
    write: false,
  });
  assert.equal(composed.wroteCandidate, false);
  assert.equal(composed.reason, 'false_win');
});

test('T-l1-1b: sim soft-layer sticky suppress → adopt; live header carries model/Jev', () => {
  const r = probeL1(stickyHyp, {
    enabled: true,
    mode: 'sim',
    subjects: ['t3/run60a', 't3/run60b'],
    model: 'fixture-model',
    jev: 'fixture-jev',
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: '4439768',
      verificationPass: false,
    },
    softLayer: {
      // empty → sim suppress
      tipSha: '4439768',
      worktree: 'soft-layer/docs-only',
      verificationPass: true,
    },
  });
  assert.equal(r.mode, 'sim');
  assert.equal(r.adopt, true);
  assert.equal(r.falseWin, false);
  assert.equal(r.header.model, 'fixture-model');
  assert.equal(r.header.jev, 'fixture-jev');
  assert.ok(r.notes.some((n) => /model=fixture-model/.test(n)));
  assert.equal(r.summary.subjects.length, 2);
});
