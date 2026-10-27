import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proposeFromIngest } from '../propose.mjs';
import { parseExperienceBody } from '../experience.mjs';
import { composeCandidate } from '../compose.mjs';
import { probeL1 } from '../probe.mjs';
import { runDayloopSoft } from '../dayloop-soft.mjs';
import { MERGED_DIRECTIONS, MERGED_REJECT_REASON, matchesMergedDirection } from '../merged-directions.mjs';

const PIN = 'a9c0b357bb0340325a02b3b50378851e22ddb4d9';
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offloop-pdd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function candidates(dir) {
  return fs.readdirSync(dir).filter((name) => /^freeze-candidate-.*\.md$/.test(name));
}

function softHypothesis() {
  return {
    id: 'H-host-note',
    slug: 'host-note-artifact-verification',
    title: 'HOST note: verify generated artifacts before reporting',
    summary: 'Soft guidance to verify generated artifacts before reporting completion.',
    class: 'soft_layer',
    probeKind: 'soft_or_latch_md',
    tags: ['soft', 'host-note'],
    evidence: [{ cellId: 'fixture', kind: 'dpr', sequence: 1, text: 'DPR observed' }],
    latchDraftMd: null,
  };
}

function softAdopt() {
  return {
    level: 'L1',
    enabled: true,
    skipped: false,
    mode: 'fixture',
    adopt: true,
    falseWin: false,
    header: { tipShaBaseline: PIN, softTreeFileListHash: 'a'.repeat(64) },
    softTreeFileList: ['HOST.md'],
    baseline: { poison: { count: 1 } },
    contrast: { poison: { count: 0 }, win: { win: true } },
    notes: [],
  };
}

function experience(slug, lesson, reason = 'experience_only') {
  return parseExperienceBody([
    `# EXPERIENCE — ${slug}`,
    '',
    `- **slug**: ${slug}`,
    `- **adopted_candidate**: no (${reason})`,
    `- **lesson**: ${lesson}`,
  ].join('\n'), { file: `${slug}.md` });
}

test('T-pdd-1: poison evidence cannot hide non-sticky DPR and path signals in other cells', () => {
  const result = proposeFromIngest({
    totals: { poisonLoopCount: 1, dprCount: 1 },
    pathSignals: { agentMissCount: 1, progressFailLeaseCount: 1, dgrPromoteCount: 1 },
    cells: [
      {
        cellId: 'poison-cell', poisonLoopCount: 1,
        evidenceQuotes: [{ kind: 'poison_loop', sequence: 1, text: 'probe-only re-upgrade' }],
      },
      {
        cellId: 'non-sticky-cell', dprCount: 1,
        pathSignals: { agentMissCount: 1, progressFailLeaseCount: 1 },
        evidenceQuotes: [
          { kind: 'dpr', sequence: 2, text: 'DPR demote observed' },
          { kind: 'agent_miss', sequence: 3, text: 'agent_miss_replan before DGR' },
          { kind: 'progress_fail_lease', sequence: 4, text: 'actions.progress FAIL' },
          { kind: 'dgr_promote', sequence: 5, text: 'independent DGR promote observed' },
        ],
      },
    ],
  }, { skipExperience: true });

  assert.equal(result.accepted.length, 3);
  assert.equal(result.truncated, true);
  assert.ok(result.accepted.some((h) => h.slug === 'post-dpr-sticky-execute' && matchesMergedDirection(h)), 'sticky remains available as a probe/library hypothesis');
  const host = result.accepted.find((h) => h.slug === 'host-note-post-dpr-execute-bias');
  assert.ok(host, 'non-sticky soft direction must retain its own DPR evidence');
  assert.equal(matchesMergedDirection(host), true, 'shipped host-note remains available as library evidence');
  assert.ok(host.evidence.some((e) => e.cellId === 'non-sticky-cell' && e.kind === 'dpr'));
  assert.ok(result.accepted.some((h) => h.slug === 'experience-agent-miss-progress-fail-not-dgr'));
});

test('T-pdd-1: non-sticky EXPERIENCE alone proposes sourced library hypotheses', () => {
  for (const [entry, expected] of [
    [experience('agent-miss-progress-fail-not-dgr', 'agent_miss with progress FAIL is not a DGR observation.'), 'experience-agent-miss-progress-fail-not-dgr'],
    [experience('dgr-promote-observed', 'DGR promote was observed in a closed cell.'), 'experience-dgr-promote-observed'],
    [experience('soft-dayloop-reject', 'A missing soft hash cannot establish adoption.', 'missing_soft_evidence'), 'experience-soft-reject-lesson'],
    [experience('host-note-observation', 'HOST note advice was observed after demote.'), 'experience-host-note-lesson'],
  ]) {
    const result = proposeFromIngest({ totals: {}, cells: [] }, { experienceEntries: [entry] });
    assert.ok(result.accepted.length >= 1 && result.accepted.length <= 3);
    const hyp = result.accepted.find((h) => h.slug === expected);
    assert.ok(hyp, `source-backed proposal for ${entry.slug}`);
    assert.equal(hyp.class, 'experience');
    assert.equal(matchesMergedDirection(hyp), false);
    assert.ok(hyp.evidence.some((e) => e.text === entry.lesson && e.file === entry.file));
  }
});

test('T-pdd-1: sticky retrieval saturation cannot exclude a non-sticky library lesson', () => {
  const entries = Array.from({ length: 6 }, (_, i) => experience(
    `post-dpr-sticky-execute-${i}`,
    'poison-loop sticky post-dpr soft latch dayloop soft-reject recurrence.',
  ));
  entries.push(experience('agent-miss-progress-fail-not-dgr', 'Agent observations must remain EXPERIENCE only.'));
  const result = proposeFromIngest({ totals: { poisonLoopCount: 1 }, cells: [] }, { experienceEntries: entries });
  assert.equal(result.experienceContext.length, 5);
  assert.ok(result.experienceContext.every((e) => /sticky/.test(e.slug)));
  assert.ok(result.accepted.some((h) => h.slug === 'experience-agent-miss-progress-fail-not-dgr'));
  assert.ok(result.accepted.length <= 3);
});

test('T-pdd-1: poison-only input retains a non-sticky observational lesson', () => {
  const result = proposeFromIngest({
    totals: { poisonLoopCount: 1 },
    cells: [{
      cellId: 'poison-cell', poisonLoopCount: 1,
      evidenceQuotes: [{ kind: 'poison_loop', sequence: 1, text: 'residual probe-only loop' }],
    }],
  }, { skipExperience: true });
  const lesson = result.accepted.find((h) => h.slug === 'experience-poison-loop-lesson');
  assert.ok(lesson);
  assert.equal(lesson.class, 'experience');
  assert.equal(matchesMergedDirection(lesson), false);
  assert.match(lesson.summary, /false win/);
  assert.doesNotMatch(lesson.summary, /correct latch|#83|#84/);
});

test('T-pdd-1: hard-gate words in a source observation cannot suppress safe library diversity', () => {
  const entry = {
    slug: 'lease-observation', title: 'Lease expiry observation',
    lesson: 'A recorded expiry is observation only.', tags: ['experience'], adopted: false,
  };
  const result = proposeFromIngest({
    totals: { poisonLoopCount: 1 },
    cells: [{
      cellId: 'poison-cell', poisonLoopCount: 1,
      evidenceQuotes: [{ kind: 'poison_loop', sequence: 1, text: 'residual probe-only loop' }],
    }],
  }, { experienceEntries: [entry] });
  const lesson = result.accepted.find((h) => !matchesMergedDirection(h));
  assert.ok(lesson, 'an observational source must not leave only sticky accepted');
  assert.equal(lesson.class, 'experience');
  assert.ok(lesson.evidence.some((e) => e.experienceSlug === entry.slug && e.text === entry.lesson));
  assert.ok(result.accepted.length <= 3);
  assert.equal(result.accepted.some((h) => h.class === 'host_code_patch'), false);
});

test('T-pdd-2: sticky aliases, titles, tags and PR references write only shipped-duplicate EXPERIENCE', (t) => {
  assert.ok(MERGED_DIRECTIONS.length >= 1);
  const aliases = [
    { slug: 'post-dpr-sticky-execute', title: 'Sticky PTE after DPR' },
    { slug: 'sticky-execute', title: 'Existing execute direction' },
    { slug: 'renamed-latch', title: 'Post-DPR sticky execute latch' },
    { slug: 'tagged-latch', title: 'Existing latch', tags: ['sticky', '#83'] },
    { slug: 'pr83-aligned', title: 'Align with PR #83' },
    { slug: 'pr84-evidence-only', title: 'PR #84 evidence-only sticky latch direction' },
  ];
  for (const alias of aliases) {
    const dir = temporaryRoot(t);
    const hypothesis = { ...softHypothesis(), ...alias };
    assert.equal(matchesMergedDirection(hypothesis), true, alias.slug);
    const result = composeCandidate({
      hypothesis, probeResult: softAdopt(), outDir: dir,
      experienceDir: path.join(dir, 'experience'), date: '2026-10-26',
    });
    assert.equal(result.wroteCandidate, false, alias.slug);
    assert.equal(result.candidatePath, null);
    assert.equal(result.reason, MERGED_REJECT_REASON);
    assert.equal(result.reason, 'shipped_duplicate');
    assert.deepEqual(candidates(dir), []);
    assert.ok(result.experiencePath && fs.existsSync(result.experiencePath));
    assert.match(fs.readFileSync(result.experiencePath, 'utf8'), /adopted_candidate\*\*: no \(shipped_duplicate\)/);
  }
});

test('T-pdd-2: ordinary host notes do not collide through inherited shipped priors or evidence', () => {
  const hyp = {
    ...softHypothesis(),
    prior: [
      { slug: 'post-dpr-sticky-execute', lesson: 'PR #83 / #84 already shipped.', tags: ['sticky', '#83'] },
      { slug: 'host-note-post-dpr-execute-bias', lesson: 'PR #82 already shipped.', tags: ['host-note', '#82'] },
    ],
    evidence: [
      { kind: 'experience', text: 'PR #83 sticky execute is already shipped.' },
      { kind: 'experience', text: 'PR #82 host-note post-DPR execute bias is already shipped.' },
    ],
  };
  assert.equal(matchesMergedDirection(hyp), false);
});

test('T-pdd-3: non-colliding soft adoption writes a true CANDIDATE with PIN and actual file hash', (t) => {
  const dir = temporaryRoot(t);
  const hypothesis = softHypothesis();
  const probeResult = probeL1(hypothesis, {
    enabled: true, mode: 'fixture', prepareSoftWorktree: true,
    softWorktreeDir: path.join(dir, 'soft-tree'),
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: PIN, verificationPass: false,
    },
    softLayer: {
      jsonlPaths: [path.join(fixtures, 'l1-soft-clean.jsonl')],
      tipSha: PIN, verificationPass: true,
    },
  });
  assert.equal(probeResult.adopt, true);
  assert.equal(matchesMergedDirection(hypothesis), false);
  const result = composeCandidate({
    hypothesis, probeResult, outDir: dir,
    experienceDir: path.join(dir, 'experience'), date: '2026-10-26',
  });
  assert.equal(result.wroteCandidate, true);
  assert.deepEqual(candidates(dir), [path.basename(result.candidatePath)]);
  const body = fs.readFileSync(result.candidatePath, 'utf8');
  assert.match(body, /\*\*CANDIDATE\*\*/);
  assert.ok(body.includes(`| tipShaBaseline | \`${PIN}\` |`));
  const hash = probeResult.header.softTreeFileListHash;
  assert.match(hash, /^[a-f0-9]{64}$/i);
  assert.ok(body.includes(`| softTreeFileListHash | \`${hash}\` |`));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'soft-tree', '.soft-worktree-manifest.json'), 'utf8'));
  assert.equal(manifest.fileListHash, hash);
});

test('T-pdd-4: path-anomaly stays EXPERIENCE-only even with a successful clean soft contrast', (t) => {
  const dir = temporaryRoot(t);
  const result = runDayloopSoft({
    fixture: 'soft-clean', tipSha: PIN, outDir: dir,
    softWorktreeDir: path.join(dir, 'soft-tree'),
    hypothesis: {
      ...softHypothesis(),
      slug: 'experience-agent-miss-progress-fail-not-dgr',
      title: 'EXPERIENCE: agent_miss when progress FAIL (not DGR)',
      class: 'experience', tags: ['experience', 'path-anomaly'],
    },
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].l1.adopt, true, 'the soft contrast itself is clean');
  assert.equal(result.wroteCandidate, false);
  assert.equal(result.results[0].reason, 'experience_only');
  assert.deepEqual(candidates(dir), []);
  assert.ok(fs.existsSync(result.results[0].experiencePath));
});
