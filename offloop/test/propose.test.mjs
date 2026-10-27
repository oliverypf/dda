import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectForbidden, filterHypotheses, proposeFromIngest, FORBIDDEN_CLASSES } from '../propose.mjs';

const evidence = [{ kind: 'poison_loop', sequence: 1, text: 'demo', cellId: 't3/run60a' }];

test('T-ol-1: Propose ≤3 accepted', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    id: `H${i}`,
    slug: `ok-${i}`,
    title: `Soft note ${i}`,
    summary: 'HOST note soft guidance only',
    probeKind: 'soft_or_latch_md',
    evidence,
  }));
  const { accepted, rejected } = filterHypotheses(many, { max: 3 });
  assert.equal(accepted.length, 3);
  assert.ok(rejected.some((r) => r.rejectReason === 'over_cap_gt_3'));
});

test('T-ol-1: reject lease / hardDecision / denylist', () => {
  for (const [cls, title] of [
    [FORBIDDEN_CLASSES.LEASE, 'Relax lease for probes'],
    [FORBIDDEN_CLASSES.HARD_DECISION, 'Bypass hardDecision gate'],
    [FORBIDDEN_CLASSES.DENYLIST, 'Remove tool from denylist'],
  ]) {
    const r = rejectForbidden({ id: 'X', slug: 'bad', title, summary: title, evidence });
    assert.equal(r.ok, false, title);
    assert.equal(r.class, cls);
  }
});

test('T-ol-1: reject tip TOPOLOGY default / Jev-provider main / host patch', () => {
  assert.equal(
    rejectForbidden({
      id: 'A',
      slug: 'tip-topo',
      title: 'Set tip product default TOPOLOGY=on',
      summary: 'change tip default topology',
      evidence,
    }).class,
    FORBIDDEN_CLASSES.TIP_TOPOLOGY_DEFAULT,
  );
  assert.equal(
    rejectForbidden({
      id: 'B',
      slug: 'jev',
      title: 'Switch Jev to Zen',
      summary: 'switch jev provider',
      evidence,
    }).class,
    FORBIDDEN_CLASSES.JEV_PROVIDER_MAIN,
  );
  assert.equal(
    rejectForbidden({
      id: 'C',
      slug: 'host',
      title: 'Fix sticky',
      summary: 'ok',
      probeKind: 'host_code_patch',
      evidence,
    }).class,
    FORBIDDEN_CLASSES.HOST_CODE_PATCH,
  );
});

test('T-ol-1: no evidence → rejected', () => {
  const { rejected } = filterHypotheses([
    { id: 'Z', slug: 'none', title: 'x', summary: 'HOST note', evidence: [] },
  ]);
  assert.equal(rejected[0].rejectReason, 'no_evidence');
});

test('T-ol-1: proposeFromIngest caps at 3 with evidence', () => {
  const ingest = {
    totals: { poisonLoopCount: 2, dprCount: 2, stickyCount: 0 },
    cells: [
      {
        cellId: 't3/run60a',
        poisonLoopCount: 1,
        dprCount: 1,
        evidenceQuotes: [
          { kind: 'poison_loop', sequence: 10, text: 'upgrade probe-only' },
          { kind: 'dpr', sequence: 5, text: 'dpr ordinal=1' },
          { kind: 'budget_blocked', sequence: 6, text: 'TOPOLOGY_BUDGET_PROBES' },
        ],
      },
    ],
  };
  const { accepted } = proposeFromIngest(ingest);
  assert.ok(accepted.length >= 1 && accepted.length <= 3);
  assert.ok(accepted.every((h) => h.evidence.length >= 1));
  assert.ok(accepted.some((h) => h.slug === 'post-dpr-sticky-execute'));
});
