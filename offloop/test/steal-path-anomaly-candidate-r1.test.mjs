import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCandidate } from '../compose.mjs';
import { runDayloopSoft } from '../dayloop-soft.mjs';
import { matchesMergedDirection } from '../merged-directions.mjs';
import { hypothesisIsSteal, isStealShape, STEAL_EVIDENCE_KINDS, STEAL_TIP_PIN } from '../path-signals.mjs';
import { probeL1 } from '../probe.mjs';
import { proposeFromIngest } from '../propose.mjs';

const PIN = STEAL_TIP_PIN;
const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(testDir, 'fixtures');

function temporaryRoot(t) {
  // Keep every new test artifact within the user-authorized offloop tree.
  const root = fs.mkdtempSync(path.join(testDir, '.steal-r1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function candidateFiles(root) {
  return fs.readdirSync(root).filter((name) => /^freeze-candidate-.*\.md$/.test(name));
}

function stealHypothesis(overrides = {}) {
  return {
    id: 'H-steal',
    slug: 'steal-post-amt-terminal-replan',
    title: 'Soft guidance after terminal replan',
    summary: 'Prefer a bounded productive action and verify after the terminal replan.',
    class: 'soft_layer',
    probeKind: 'soft_or_latch_md',
    tags: ['steal', 'soft', 'post-amt', 'path-anomaly'],
    evidence: [{
      cellId: 'steal-cell', sequence: 7, kind: 'post_amt',
      text: 'post_agent_miss_terminal_replan observed',
    }],
    latchDraftMd: null,
    ...overrides,
  };
}

function softAdopt(overrides = {}) {
  return {
    level: 'L1', enabled: true, skipped: false, mode: 'fixture',
    adopt: true, falseWin: false, notes: [],
    tipShaBaseline: PIN,
    softTreeFileListHash: 'a'.repeat(64),
    softTreeFileList: ['docs/steal-soft-guidance.md'],
    baseline: { poison: { count: 1 } },
    contrast: { poison: { count: 0 }, win: { win: true } },
    ...overrides,
  };
}

function composeAt(root, hypothesis, probeResult) {
  return composeCandidate({
    hypothesis, probeResult, outDir: root,
    experienceDir: path.join(root, 'experience'), date: '2026-10-25',
  });
}

function assertExperienceOnly(result, root, reason) {
  assert.equal(result.wroteCandidate, false);
  assert.equal(result.candidatePath, null);
  assert.equal(result.reason, reason);
  assert.deepEqual(candidateFiles(root), []);
  assert.ok(result.experiencePath && fs.existsSync(result.experiencePath));
  const body = fs.readFileSync(result.experiencePath, 'utf8');
  assert.match(body, /^# EXPERIENCE/m);
  assert.ok(body.includes(`**adopted_candidate**: no (${reason})`));
}

test('T-steal-1: script-locked steal kinds exclude UNCERTAIN, agent_miss and generic steal tags', () => {
  assert.deepEqual([...STEAL_EVIDENCE_KINDS].sort(), ['post_agent_miss_terminal_replan', 'post_amt']);
  assert.equal(Object.isFrozen(STEAL_EVIDENCE_KINDS), true);
  for (const positive of [
    { kind: 'post_amt' },
    { kind: 'post_agent_miss_terminal_replan' },
    { kind: 'harness.post_agent_miss_terminal_replan' },
    { tags: ['soft', 'post-amt'] },
    { notes: ['post_agent_miss_terminal_replan observed'] },
    { postAmtCount: 1 },
    { totals: { postAmtCount: 1 } },
    { cells: [{ pathSignals: { postAmtCount: 1 } }] },
    { evidenceQuotes: [{ kind: 'post_amt' }] },
    { pathSignals: { evidenceQuotes: [{ kind: 'post_agent_miss_terminal_replan' }] } },
  ]) assert.equal(isStealShape(positive), true, JSON.stringify(positive));
  for (const negative of [
    null, {}, { postAmtCount: 0 }, { postAmtCount: -1 },
    { postMissUncertainCount: 3 },
    { kind: 'post_miss_uncertain' },
    { kind: 'post_miss_uncertain_replan' },
    { kind: 'post_miss_uncertain_exhausted_replan' },
    { kind: 'harness.post_miss_evidence_delta_replan' },
    { kind: 'dgr_promote', text: 'post_amt not observed; retain monitoring evidence' },
    { kind: 'post_miss_uncertain', text: 'Wait for post_agent_miss_terminal_replan evidence' },
    { summary: 'No new latch unless steal/post_amt appears' },
    { prior: [{ kind: 'post_amt' }] },
    { agentMissCount: 1, evidenceQuotes: [{ kind: 'agent_miss' }] },
    { tags: ['steal', 'path-anomaly'], evidence: [{ kind: 'agent_miss' }] },
    { pathSignals: { dgrPromoteCount: 1, tipPathCount: 1 } },
  ]) assert.equal(isStealShape(negative), false, JSON.stringify(negative));
});

test('T-steal-1: non-steal path anomalies reject an adopt-looking probe with complete pinned evidence', (t) => {
  for (const [kind, counts] of [
    ['dgr_promote', { dgrPromoteCount: 1 }],
    ['tip_path', { tipPathCount: 1 }],
    ['post_miss_uncertain_exhausted_replan', { postMissUncertainCount: 1 }],
    ['agent_miss', { agentMissCount: 1 }],
  ]) {
    for (const form of [
      { class: 'experience', tags: ['experience', 'path-anomaly', 'steal'], slug: `experience-${kind.replaceAll('_', '-')}` },
      { class: 'soft_layer', tags: [kind.replaceAll('_', '-')], slug: 'observational-soft-note' },
      { class: 'soft_layer', tags: ['soft'], slug: 'counter-only-soft-note', evidence: [] },
    ]) {
      const root = temporaryRoot(t);
      const hypothesis = stealHypothesis({
        title: 'Observed path anomaly',
        evidence: [{ kind, text: `${kind} observed` }], pathSignals: counts,
        ...form,
      });
      assert.equal(isStealShape(hypothesis), false);
      assertExperienceOnly(composeAt(root, hypothesis, softAdopt()), root, 'experience_only');
    }
  }
});

test('T-steal-2: allowlisted post_amt + successful soft Probe retains PIN/hash as shipped EXPERIENCE', (t) => {
  const root = temporaryRoot(t);
  const hypothesis = stealHypothesis();
  const softTree = path.join(root, 'soft-tree');
  const probe = probeL1(hypothesis, {
    enabled: true, mode: 'fixture', prepareSoftWorktree: true, softWorktreeDir: softTree,
    baseline: { jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')], tipSha: PIN, verificationPass: false },
    softLayer: { jsonlPaths: [path.join(fixtures, 'l1-soft-clean.jsonl')], tipSha: PIN, verificationPass: true },
  });
  assert.equal(probe.adopt, true);
  assert.equal(matchesMergedDirection(hypothesis), true);
  const result = composeAt(root, hypothesis, probe);
  assertExperienceOnly(result, root, 'shipped_duplicate');
  const body = fs.readFileSync(result.experiencePath, 'utf8');
  assert.ok(body.includes(`tipShaBaseline=\`${PIN}\``));
  const hash = probe.header.softTreeFileListHash;
  assert.match(hash, /^[a-f0-9]{64}$/i);
  assert.ok(body.includes(`softTreeFileListHash=\`${hash}\``));
  const manifest = JSON.parse(fs.readFileSync(path.join(softTree, '.soft-worktree-manifest.json'), 'utf8'));
  assert.equal(manifest.fileListHash, hash);
  assert.ok(manifest.fileList.length > 0);
  for (const file of manifest.fileList) {
    assert.equal(fs.statSync(path.join(softTree, file.relPath)).isFile(), true);
  }
});

test('T-steal-3: sticky, #83 and #84 stay shipped_duplicate despite allowlisted steal evidence', (t) => {
  for (const override of [
    { slug: 'post-dpr-sticky-execute' },
    { title: 'Sticky PTE execute latch after terminal replan' },
    { tags: ['soft', 'post-amt', '#83'] },
    { alignedPr: 84 },
  ]) {
    const root = temporaryRoot(t);
    const hypothesis = stealHypothesis({
      slug: 'soft-evidence-checklist',
      title: 'Verify evidence before reporting',
      tags: ['soft', 'post-amt'],
      ...override,
    });
    assert.equal(isStealShape(hypothesis), true);
    assert.equal(matchesMergedDirection(hypothesis), true);
    assertExperienceOnly(composeAt(root, hypothesis, softAdopt()), root, 'shipped_duplicate');
  }
});

test('T-steal-2: merged rejection precedes missing evidence while non-merged notes retain the PIN/hash gate', (t) => {
  for (const overrides of [
    { softTreeFileListHash: null },
    { softTreeFileListHash: 'a'.repeat(63) },
    { softTreeFileListHash: 'g'.repeat(64) },
    { tipShaBaseline: null },
    { tipShaBaseline: 'a9c0b35' },
    { tipShaBaseline: 'b'.repeat(40) },
    { level: undefined, enabled: undefined, softTreeFileListHash: null },
  ]) {
    const mergedRoot = temporaryRoot(t);
    assertExperienceOnly(composeAt(mergedRoot, stealHypothesis(), softAdopt(overrides)), mergedRoot, 'shipped_duplicate');
    const root = temporaryRoot(t);
    const hypothesis = stealHypothesis({
      slug: 'host-note-documentation-checklist',
      title: 'Document verification evidence before reporting completion',
      summary: 'Keep an evidence checklist for documentation changes.',
      tags: ['soft', 'docs'],
    });
    assert.equal(hypothesisIsSteal(hypothesis), true, 'allowlisted evidence still requires the exact steal PIN');
    assert.equal(matchesMergedDirection(hypothesis), false);
    assertExperienceOnly(composeAt(root, hypothesis, softAdopt(overrides)), root, 'missing_soft_evidence');
  }
});

test('T-steal-2: false-win, hard-gate and non-adopt remain authoritative for steal shapes', (t) => {
  for (const [overrides, reason] of [
    [{ falseWin: true }, 'false_win'],
    [{ adopt: false, falseWin: true }, 'false_win'],
    [{ adopt: false }, 'probe_not_adopt'],
    [{ level: undefined, l1: { level: 'L1', adopt: false } }, 'probe_not_adopt'],
    [{ level: undefined, l1: { level: 'L1', adopt: true, falseWin: true } }, 'false_win'],
    [{ reason: 'hard_gate_path' }, 'hard_gate_path'],
  ]) {
    const root = temporaryRoot(t);
    assertExperienceOnly(composeAt(root, stealHypothesis(), softAdopt(overrides)), root, reason);
  }
});

test('T-steal-2: totals, cell counters and allowlisted quotes retain a sourced shipped soft proposal', () => {
  for (const input of [
    { totals: { postAmtCount: 1 }, cells: [] },
    { pathSignals: { postAmtCount: 1 }, cells: [] },
    { cells: [{ cellId: 'counter', pathSignals: { postAmtCount: 1 }, evidenceQuotes: [] }] },
    { cells: [{ cellId: 'quote', evidenceQuotes: [{ kind: 'post_amt', text: 'terminal replan observed' }] }] },
    { evidenceQuotes: [{ kind: 'post_agent_miss_terminal_replan', text: 'terminal replan observed' }], cells: [] },
  ]) {
    const proposed = proposeFromIngest(input, { skipExperience: true });
    const steal = proposed.accepted.find((h) => isStealShape(h) && h.class !== 'experience');
    assert.ok(steal, `steal proposal for ${JSON.stringify(input)}`);
    assert.equal(steal.class, 'soft_layer');
    assert.ok(steal.tags.includes('steal'));
    assert.equal(matchesMergedDirection(steal), true);
    assert.ok(steal.evidence.length > 0);
    assert.ok(proposed.accepted.length <= 3);
  }
});

test('T-steal-1: UNCERTAIN and agent_miss observations alone never propose a steal knife', () => {
  for (const kind of ['post_miss_uncertain', 'post_miss_uncertain_exhausted_replan', 'agent_miss', 'dgr_promote']) {
    const proposed = proposeFromIngest({
      totals: { postMissUncertainCount: 1, agentMissCount: 1 },
      pathSignals: { dgrPromoteCount: kind === 'dgr_promote' ? 1 : 0 },
      cells: [{ cellId: 'observation', evidenceQuotes: [{ kind, text: `${kind} observed` }] }],
    }, { skipExperience: true });
    assert.equal(proposed.accepted.some((h) => isStealShape(h)), false, kind);
  }
});

test('T-steal-1: incidental post_amt evidence cannot promote generic DGR or agent-miss library observations', (t) => {
  const proposed = proposeFromIngest({
    pathSignals: { dgrPromoteCount: 1, postAmtCount: 1, agentMissCount: 1, progressFailLeaseCount: 1 },
    cells: [{
      cellId: 'sparse-mixed-cell',
      evidenceQuotes: [{ kind: 'post_amt', text: 'post_agent_miss_terminal_replan observed' }],
    }],
  }, { skipExperience: true });
  const observations = proposed.accepted.filter((h) => h.class === 'experience');
  assert.equal(observations.length, 2);
  for (const hypothesis of observations) {
    const root = temporaryRoot(t);
    assert.equal(hypothesisIsSteal(hypothesis), false);
    assertExperienceOnly(composeAt(root, hypothesis, softAdopt()), root, 'experience_only');
  }
  const steal = proposed.accepted.find((h) => h.tags.includes('steal'));
  assert.ok(steal, 'incidental observation evidence must not suppress the dedicated steal direction');
  const root = temporaryRoot(t);
  assertExperienceOnly(composeAt(root, steal, softAdopt()), root, 'shipped_duplicate');
});

test('T-steal-2: mixed proposal saturation cannot discard the shipped steal hypothesis', () => {
  const proposed = proposeFromIngest({
    totals: { poisonLoopCount: 1, dprCount: 1, postAmtCount: 1 },
    pathSignals: { agentMissCount: 1, progressFailLeaseCount: 1, dgrPromoteCount: 1 },
    cells: [{
      cellId: 'mixed', poisonLoopCount: 1, dprCount: 1,
      pathSignals: { postAmtCount: 1, agentMissCount: 1, progressFailLeaseCount: 1 },
      evidenceQuotes: ['poison_loop', 'dpr', 'agent_miss', 'progress_fail_lease', 'dgr_promote', 'post_amt']
        .map((kind, sequence) => ({ kind, sequence, text: `${kind} observed` })),
    }],
  }, { skipExperience: true });
  assert.equal(proposed.truncated, true);
  assert.equal(proposed.accepted.length, 3);
  const steal = proposed.accepted.find((h) => h.tags.includes('steal') && h.class === 'soft_layer');
  assert.ok(steal, 'the three-slot cap must reserve a proposal for present post_amt evidence');
  assert.equal(matchesMergedDirection(steal), true);
  assert.ok(steal.evidence.some((e) => e.kind === 'post_amt'));
});

test('T-steal-2: dayloop retains a shipped steal path-anomaly as EXPERIENCE with complete soft evidence', (t) => {
  for (const hypothesis of [
    stealHypothesis(),
    stealHypothesis({ class: 'experience', slug: 'experience-steal-post-amt-terminal-replan' }),
  ]) {
    const root = temporaryRoot(t);
    const summary = runDayloopSoft({
      fixture: 'soft-clean', tipSha: PIN, outDir: root,
      softWorktreeDir: path.join(root, 'soft-tree'), hypothesis,
    });
    assert.equal(summary.ok, true);
    assert.equal(summary.results.length, 1);
    assert.equal(summary.results[0].l1.adopt, true);
    assert.equal(summary.results[0].reason, 'shipped_duplicate');
    assert.equal(summary.wroteCandidate, false);
    assert.equal(summary.frozenWrites, 0);
    assertExperienceOnly(summary.results[0], root, 'shipped_duplicate');
  }
});

test('T-steal-2: ingest → propose → dayloop retains shipped post_amt and sticky as EXPERIENCE', (t) => {
  const root = temporaryRoot(t);
  const baseline = path.join(root, 'post-amt-baseline.jsonl');
  const event = {
    type: 'runtime_event', schemaVersion: '1.0', runId: 'run-fix', sequence: 7,
    kind: 'harness.post_agent_miss_terminal_replan', payload: { failureCodes: ['JEV_BEHAVIOR_REJECTED'] },
    emittedAtMs: 7,
  };
  fs.writeFileSync(baseline, `${fs.readFileSync(path.join(fixtures, 'poison-loop-yes.jsonl'), 'utf8').trim()}\n${JSON.stringify(event)}\n`);
  const summary = runDayloopSoft({
    fixture: 'soft-clean', tipSha: PIN, outDir: root,
    baselineJsonl: baseline, softJsonl: path.join(fixtures, 'l1-soft-clean.jsonl'),
    softWorktreeDir: path.join(root, 'soft-tree'),
  });
  const steal = summary.results.find((result) => /post-amt/.test(result.hypothesis));
  assert.ok(steal, 'post_amt ingest must reach the probe and compose paths');
  assertExperienceOnly(steal, root, 'shipped_duplicate');
  assert.equal(steal.l1.tipShaBaseline, PIN);
  assert.match(steal.l1.softTreeFileListHash, /^[a-f0-9]{64}$/i);
  assert.equal(summary.frozenWrites, 0);
  const sticky = summary.results.find((result) => result.hypothesis === 'post-dpr-sticky-execute');
  if (sticky) {
    assert.equal(sticky.wroteCandidate, false);
    assert.equal(sticky.reason, 'shipped_duplicate');
  }
  assert.deepEqual(candidateFiles(root), []);
});
