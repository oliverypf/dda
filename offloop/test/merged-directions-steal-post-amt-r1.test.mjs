import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCandidate } from '../compose.mjs';
import { MERGED_DIRECTIONS, matchesMergedDirection } from '../merged-directions.mjs';
import { hypothesisIsSteal, isExperienceOnlyHypothesis, STEAL_TIP_PIN } from '../path-signals.mjs';
import { probeL1 } from '../probe.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(testDir, 'fixtures');
const date = '2026-10-25';

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(testDir, '.merged-steal-r1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function assertShipped(hypothesis, outDir, probeResult = { adopt: true, falseWin: false, notes: [] }) {
  assert.equal(matchesMergedDirection(hypothesis), true, JSON.stringify(hypothesis));
  const result = composeCandidate({
    hypothesis, probeResult, outDir, experienceDir: path.join(outDir, 'experience'), date,
  });
  assert.equal(result.wroteCandidate, false);
  assert.equal(result.candidatePath, null);
  assert.equal(result.reason, 'shipped_duplicate');
  assert.ok(fs.existsSync(result.experiencePath));
  assert.match(fs.readFileSync(result.experiencePath, 'utf8'), /\*\*adopted_candidate\*\*: no \(shipped_duplicate\)/);
  assert.deepEqual(fs.readdirSync(outDir).filter((name) => name.startsWith('freeze-candidate-')), []);
  return result;
}

test('T-steal-merged-1: shipped #90 entry locks both direction slugs without generic observations', () => {
  const direction = MERGED_DIRECTIONS.find((entry) => entry.id === 'steal-post-amt-terminal-replan');
  assert.ok(direction);
  assert.deepEqual(direction.pullRequests, [90]);
  assert.ok(direction.slugs.includes('steal-post-amt-terminal-replan'));
  assert.ok(direction.slugs.includes('steal_post_amt_terminal_replan'));
  assert.equal(direction.slugs.includes('post_amt'), false);
  assert.equal(direction.slugs.includes('steal'), false);
  assert.equal(direction.directionPattern.test('Steal post-amt terminal-replan soft guidance'), true);
});

test('T-steal-merged-2: own aliases, product titles, tags and #90 references reject adoption', (t) => {
  const root = temporaryRoot(t);
  const variants = [
    { slug: 'steal-post-amt-terminal-replan' },
    { slug: 'steal_post_amt_terminal_replan' },
    { title: 'Freeze harness steal post_amt terminal replan r1' },
    { title: 'STEAL: post_agent_miss_terminal_replan soft guidance' },
    { title: 'Terminal-replan steal product guidance' },
    { title: 'Soft guidance after post_amt terminal replan' },
    { tags: ['steal', 'post-amt'] },
    { tags: ['steal', 'post_amt'] },
    { tags: ['post_amt', 'terminal-replan'] },
    { tags: ['steal', 'post_amt', 'terminal-replan'] },
    { tags: ['steal-post-amt-terminal-replan'] },
    { title: 'Align with PR #90 soft guidance' },
    { tags: ['soft', '#90'] },
    { pr: 90 },
    { prs: ['PR-90'] },
    { prRef: 'PR_90' },
    { prRefs: ['https://github.com/oliverypf/dda/pull/90'] },
    { pullRequest: { number: 90 } },
    { pullRequests: [90] },
    { pullRequestRefs: [{ url: 'https://github.com/oliverypf/dda/pull/90' }] },
    { alignedPr: 'PR #90' },
    { alignedPrs: [{ ref: '#90' }] },
  ];
  for (const [index, variant] of variants.entries()) {
    assertShipped({
      id: `H${index}`, slug: 'renamed-soft-guidance', title: 'Soft guidance', class: 'soft_layer',
      ...variant,
    }, path.join(root, String(index)));
  }
});

test('T-steal-merged-3: merged gate rejects allowlisted post_amt with valid, missing or wrong steal PIN evidence', (t) => {
  const root = temporaryRoot(t);
  assert.equal(STEAL_TIP_PIN, '2258685ce9793639ebc9698c8961dcedccf6e49b');
  const hypothesis = {
    id: 'H-steal', slug: 'steal-post-amt-terminal-replan',
    title: 'Soft guidance after post_amt terminal replan', class: 'soft_layer',
    tags: ['soft', 'steal', 'post-amt'],
    evidence: [{ cellId: 'allowlisted-cell', sequence: 7, kind: 'post_amt', text: 'post_agent_miss_terminal_replan observed' }],
  };
  assert.equal(hypothesisIsSteal(hypothesis), true);
  assert.equal(isExperienceOnlyHypothesis(hypothesis), false);
  const evidenceVariants = [
    { tipShaBaseline: STEAL_TIP_PIN, softTreeFileListHash: 'a'.repeat(64) },
    { tipShaBaseline: null, softTreeFileListHash: null },
    { tipShaBaseline: 'a9c0b357bb0340325a02b3b50378851e22ddb4d9', softTreeFileListHash: 'b'.repeat(64) },
  ];
  for (const [index, header] of evidenceVariants.entries()) {
    const result = assertShipped(hypothesis, path.join(root, String(index)), {
      level: 'L1', enabled: true, skipped: false, adopt: true, falseWin: false,
      header, notes: ['Clean soft contrast'],
      softWorktree: { ok: true, rejected: false, fileList: ['docs/soft-guidance.md'] },
      baseline: { poison: { count: 1 }, win: { win: false } },
      contrast: { poison: { count: 0 }, win: { win: true, reason: 'green_and_poison_loop_zero' } },
    });
    assert.equal(result.missingSoftEvidence, undefined, 'merged rejection must precede the steal PIN/hash gate');
    assert.doesNotMatch(result.experienceBody, /\*\*missing_soft_evidence\*\*/);
    if (header.tipShaBaseline) assert.ok(result.experienceBody.includes(header.tipShaBaseline));
    if (header.softTreeFileListHash) assert.ok(result.experienceBody.includes(header.softTreeFileListHash));
  }
});

test('T-steal-merged-4: host-note and sticky identities still reject as shipped duplicates', (t) => {
  const root = temporaryRoot(t);
  const variants = [
    { slug: 'host-note-post-dpr-execute-bias' },
    { slug: 'host_note_post_dpr_execute_bias' },
    { title: 'HOST note: post-DPR execute bias' },
    { tags: ['host-note', 'post-dpr', 'execute-bias'] },
    { pullRequest: 82 },
    { slug: 'sticky-execute' },
    { slug: 'post-dpr-sticky-execute' },
    { title: 'Sticky PTE guidance' },
    { pullRequest: 83 },
    { pullRequest: 84 },
  ];
  for (const [index, variant] of variants.entries()) {
    assertShipped({ slug: 'renamed-soft-guidance', title: 'Soft guidance', class: 'soft_layer', ...variant },
      path.join(root, String(index)));
  }
});

test('T-steal-merged-5: non-merged docs with inherited #90 context still write CANDIDATE after clean L1', (t) => {
  const root = temporaryRoot(t);
  const hypothesis = {
    id: 'H-docs', slug: 'host-note-documentation-checklist',
    title: 'HOST note: documentation review checklist', class: 'soft_layer',
    probeKind: 'soft_or_latch_md', tags: ['soft', 'host-note'],
    summary: 'Review documentation; PR #90 steal-post-amt-terminal-replan remains library context.',
    evidence: [{ cellId: 'library-cell', sequence: 2, text: 'PR #90 is a library source.' }],
    prior: [{
      slug: 'steal-post-amt-terminal-replan', title: 'Steal post_amt terminal replan',
      tags: ['steal', 'post-amt'], pullRequests: [90],
      lesson: 'PR #90 post_agent_miss_terminal_replan is shipped.',
    }],
  };
  assert.equal(matchesMergedDirection(hypothesis), false);
  const probeResult = probeL1(hypothesis, {
    enabled: true, mode: 'fixture', prepareSoftWorktree: true,
    softWorktreeDir: path.join(root, 'soft'),
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: STEAL_TIP_PIN, verificationPass: false,
    },
    softLayer: {
      jsonlPaths: [path.join(fixtures, 'l1-soft-clean.jsonl')],
      tipSha: STEAL_TIP_PIN, verificationPass: true,
    },
  });
  assert.equal(probeResult.adopt, true);
  assert.match(probeResult.header.softTreeFileListHash, /^[a-f0-9]{64}$/i);
  const outDir = path.join(root, 'out');
  const result = composeCandidate({
    hypothesis, probeResult, outDir, experienceDir: path.join(outDir, 'experience'), date,
  });
  assert.equal(result.wroteCandidate, true);
  assert.equal(result.reason, 'probe_adopt');
  assert.deepEqual(fs.readdirSync(outDir).filter((name) => name.startsWith('freeze-candidate-')), [
    'freeze-candidate-host-note-documentation-checklist-r1.md',
  ]);
  const candidate = fs.readFileSync(result.candidatePath, 'utf8');
  assert.match(candidate, /\*\*CANDIDATE\*\*/);
  assert.ok(candidate.includes(probeResult.header.softTreeFileListHash));
  assert.match(fs.readFileSync(result.experiencePath, 'utf8'), /\*\*adopted_candidate\*\*: yes \(probe_adopt\)/);
});

test('T-steal-merged-6: #900, #901 and unrelated own PR references do not match #90', () => {
  for (const number of [900, 901, 91, 820]) {
    for (const reference of [
      { title: `PR #${number} unrelated documentation` },
      { tags: [`#${number}`] },
      { pr: number },
      { prs: [`PR-${number}`] },
      { prRef: `PR_${number}` },
      { prRefs: [`https://github.com/oliverypf/dda/pull/${number}`] },
      { pullRequest: { number } },
      { pullRequests: [number] },
      { pullRequestRefs: [{ url: `https://github.com/oliverypf/dda/pull/${number}` }] },
      { alignedPr: `PR #${number}` },
      { alignedPrs: [{ ref: `#${number}` }] },
    ]) {
      const hypothesis = { slug: 'ordinary-documentation-note', title: 'Documentation checklist', ...reference };
      assert.equal(matchesMergedDirection(hypothesis), false, JSON.stringify(hypothesis));
    }
  }
});

test('T-steal-merged-7: bare observations and isolated or split-line wording stay outside merged directions', () => {
  for (const hypothesis of [
    { slug: 'post_amt', title: 'Observation only' },
    { slug: 'post-amt-observation', title: 'Observed post_amt counter' },
    { slug: 'post_agent_miss_terminal_replan', title: 'Observed counter only' },
    { slug: 'steal', title: 'Ordinary soft note' },
    { slug: 'path-anomaly', title: 'Path observation' },
    { slug: 'dgr', title: 'DGR observation' },
    { slug: 'tip-path', title: 'Tip-path observation' },
    { slug: 'ordinary-documentation-note', title: 'Document the steal label', tags: ['soft'] },
    { slug: 'ordinary-documentation-note', title: 'Document the post_amt counter', tags: ['soft'] },
    { slug: 'ordinary-documentation-note', title: 'Document terminal-replan terminology', tags: ['soft'] },
    { slug: 'ordinary-documentation-note', title: 'Steal terminology\npost_amt observations', tags: ['soft'] },
    { slug: 'ordinary-documentation-note', title: 'Steal terminology\nterminal-replan observations', tags: ['soft'] },
    { slug: 'ordinary-documentation-note', title: 'post_amt counter\nterminal-replan glossary', tags: ['soft'] },
    { slug: 'ordinary-documentation-note', title: 'Ordinary documentation checklist', tags: ['soft'] },
  ]) assert.equal(matchesMergedDirection(hypothesis), false, JSON.stringify(hypothesis));
});
