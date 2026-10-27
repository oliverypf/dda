/**
 * T-esp-1/2: soft reject EXPERIENCE → soft hyp prior; hard_gate must not
 * promote to host_code_patch adopt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExperienceBody,
  retrieveSoftPriors,
  isSoftRejectExperience,
  SOFT_REJECT_REASONS,
} from '../experience.mjs';
import {
  proposeFromIngest,
  attachPrior,
  filterHypotheses,
  isSoftHypothesis,
  selectPriorsForHypothesis,
  FORBIDDEN_CLASSES,
} from '../propose.mjs';

function softRejectEntry({
  slug = 'soft-missing-hash-lesson',
  reason = 'missing_soft_evidence',
  lesson = 'L1 soft adopt without tipShaBaseline/softTreeFileListHash must reject CANDIDATE.',
  file = '2026-10-24-soft-missing-hash-lesson-rejected.md',
} = {}) {
  return parseExperienceBody(
    `# EXPERIENCE — soft reject ${reason}

- **slug**: ${slug}
- **adopted_candidate**: no (${reason})
- **lesson**: ${lesson}
- **soft_evidence**: tipShaBaseline=(absent) softTreeFileListHash=(absent)
`,
    { file },
  );
}

function hardGateEntry() {
  return parseExperienceBody(
    `# EXPERIENCE — soft worktree hard gate

- **slug**: soft-hard-gate-lease-path
- **adopted_candidate**: no (hard_gate_path)
- **lesson**: Soft worktree touched runtime lease path; reject and do not patch host.
`,
    { file: '2026-10-24-soft-hard-gate-lease-path-rejected.md' },
  );
}

function poisonIngest() {
  return {
    totals: { poisonLoopCount: 1, dprCount: 1, stickyCount: 0, agentMissCount: 0 },
    pathSignals: {
      agentMissCount: 0,
      dgrPromoteCount: 0,
      tipPathCount: 0,
      postAmtCount: 0,
      progressFailLeaseCount: 0,
    },
    cells: [
      {
        cellId: 't3/run60a',
        poisonLoopCount: 1,
        dprCount: 1,
        evidenceQuotes: [
          { kind: 'poison_loop', sequence: 10, text: 'upgrade probe-only' },
          { kind: 'dpr', sequence: 5, text: 'dpr ordinal=1' },
        ],
      },
    ],
  };
}

test('T-esp-1: soft reject lesson attaches into soft hypothesis prior (slug/reason)', () => {
  const soft = softRejectEntry();
  assert.equal(soft.rejectReason, 'missing_soft_evidence');
  assert.equal(isSoftRejectExperience(soft), true);
  assert.ok(soft.tags.includes('missing_soft_evidence'));
  assert.ok(soft.tags.includes('soft-reject'));

  const softs = retrieveSoftPriors(null, { entries: [soft], limit: 3 });
  assert.ok(softs.length >= 1);
  assert.equal(softs[0].slug, 'soft-missing-hash-lesson');

  const proposal = proposeFromIngest(poisonIngest(), { experienceEntries: [soft] });
  assert.ok(proposal.accepted.length >= 1);

  const softHyp = proposal.accepted.find(
    (h) => h.class === 'soft_layer' || h.class === 'latch_draft_md' || isSoftHypothesis(h),
  );
  assert.ok(softHyp, 'expected a soft_layer / latch_draft_md hypothesis');
  assert.ok(Array.isArray(softHyp.prior));
  assert.ok(softHyp.prior.length >= 1, 'soft hyp prior must include soft reject lesson');

  const hit = softHyp.prior.find(
    (p) =>
      p.slug === 'soft-missing-hash-lesson' ||
      p.reason === 'missing_soft_evidence' ||
      (p.tags || []).includes('missing_soft_evidence'),
  );
  assert.ok(hit, `prior should contain soft reject slug/reason; got ${JSON.stringify(softHyp.prior)}`);
  assert.equal(hit.reason, 'missing_soft_evidence');
  assert.equal(hit.adopted, false, 'soft reject prior must not mark adopted');
  assert.ok(softHyp.prior.length <= 3);

  // fixture-fallback / false_win / hard_gate_path also parse as soft rejects
  for (const reason of ['hard_gate_path', 'false_win', 'fixture-fallback', 'baseline_fixture_fallback']) {
    const e = softRejectEntry({ slug: `lesson-${reason}`, reason, file: `x-${reason}.md` });
    assert.equal(isSoftRejectExperience(e), true, reason);
    assert.ok(SOFT_REJECT_REASONS.includes(e.rejectReason) || e.rejectReason === reason);
  }
});

test('T-esp-2: hard_gate reject lesson does NOT become host_code_patch adopt hypothesis', () => {
  const hard = hardGateEntry();
  assert.equal(hard.rejectReason, 'hard_gate_path');
  assert.equal(isSoftRejectExperience(hard), true);

  const proposal = proposeFromIngest(poisonIngest(), { experienceEntries: [hard] });

  // No accepted hyp may be host_code_patch / host latch adopt
  for (const h of proposal.accepted) {
    assert.notEqual(h.class, 'host_code_patch');
    assert.notEqual(h.class, 'host_latch_adopt');
    assert.notEqual(h.probeKind, 'host_code_patch');
    assert.ok(
      !/host.?code.?patch|patch.?runtime|host.?latch.?adopt/i.test(
        `${h.slug} ${h.title} ${h.summary} ${h.probeKind}`,
      ),
      `accepted hyp must not promote hard_gate to host patch: ${h.slug}`,
    );
  }

  // Soft hyp may carry hard_gate as warn prior (adopted:false), never as adopt
  const softHyp = proposal.accepted.find((h) => isSoftHypothesis(h));
  if (softHyp) {
    const hg = softHyp.prior.find((p) => p.reason === 'hard_gate_path' || p.slug === hard.slug);
    if (hg) {
      assert.equal(hg.adopted, false);
      assert.equal(hg.softReject, true);
    }
  }

  // Crafted host_code_patch citing hard_gate must be rejected by the gate
  const malicious = {
    id: 'HX',
    slug: 'patch-runtime-from-hard-gate-lesson',
    title: 'Patch runtime host code from hard_gate_path EXPERIENCE',
    summary: 'Adopt host latch / host code patch because soft worktree hit hard_gate_path',
    class: 'host_code_patch',
    probeKind: 'host_code_patch',
    tags: ['hard_gate_path', 'host'],
    evidence: [{ kind: 'poison_loop', sequence: 1, text: 'x' }],
    prior: [
      {
        slug: hard.slug,
        reason: 'hard_gate_path',
        adopted: false,
        softReject: true,
        lesson: hard.lesson,
      },
    ],
  };
  const gated = filterHypotheses([malicious]);
  assert.equal(gated.accepted.length, 0);
  assert.ok(gated.rejected.length >= 1);
  assert.equal(gated.rejected[0].forbiddenClass, FORBIDDEN_CLASSES.HOST_CODE_PATCH);

  // Non-soft hyp must not receive hard_gate soft-reject as prior (no accidental promote)
  const nonSoft = { id: 'N', slug: 'experience-only', class: 'experience', tags: ['experience'] };
  const selected = selectPriorsForHypothesis(nonSoft, [hard], [hard]);
  assert.equal(
    selected.filter((e) => e.rejectReason === 'hard_gate_path').length,
    0,
    'non-soft hyp must not attach hard_gate soft-reject prior',
  );

  // Empty soft library → empty prior OK
  const empty = proposeFromIngest(poisonIngest(), { experienceEntries: [] });
  assert.ok(empty.accepted.every((h) => Array.isArray(h.prior)));
});
