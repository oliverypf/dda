import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildExperienceQuery, parseExperienceBody, retrieveExperience } from '../experience.mjs';
import {
  attachPrior, filterHypotheses, FORBIDDEN_CLASSES, isSoftHypothesis,
  proposeFromIngest, selectPriorsForHypothesis,
} from '../propose.mjs';
import { isArchivedOrShipped, isPendingCandidate } from '../candidate-archive.mjs';
import { matchesMergedDirection } from '../merged-directions.mjs';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'adopt-experience-propose-prior-r1';
const out = path.join(root, 'offloop', `out-${knife}`);
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const baselines = {
  'experience.mjs': '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb',
  'propose.mjs': '08390e92bc5de89c5b29286b24c942e93ec5256f6fc20e643f9bf09b0ea5c411',
};
const lockHash = '6db0d6253e27fc9ff5bbe53ea645675bead607bf0a9d9f48ebd47da984ba3c77';
const evidenceRoot = path.join(root, 'offloop/out-dayloop-tip-soft-adopt-live-r1');
const evidenceFile = path.join(evidenceRoot,
  'temporary-miss-drive-t2H55F/out/experience/2026-10-25-experience-dgr-promote-observed-rejected.md');
// EXTERNAL: live evidence may gain dated siblings; directory reads pin the original adopt bytes.
const fixtureDir = path.join(root, 'offloop/out-aepp-experience-date-fixture-r1/fixture-experience');
const slug = 'experience-dgr-promote-observed';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// These are read/API tests only: never invoke Compose, Probe or dayloop.
// Catch write attempts even if a future implementation swallows the error.
function forbidFileWrites(t) {
  const mocks = [];
  for (const name of [
    'writeFile', 'appendFile', 'copyFile', 'rename', 'truncate',
    'writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'truncateSync',
    'createWriteStream',
  ]) {
    mocks.push(t.mock.method(fs, name, () => assert.fail(`unexpected fs.${name} write`)));
  }
  for (const name of ['writeFile', 'appendFile', 'copyFile', 'rename', 'truncate']) {
    mocks.push(t.mock.method(fs.promises, name, () => assert.fail(`unexpected fs.promises.${name} write`)));
  }
  t.after(() => {
    assert.ok(mocks.every(fn => fn.mock.callCount() === 0), 'retrieve/propose must attempt zero file writes');
  });
}

function assertNoCandidateFiles() {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  assert.deepEqual(walk(out).filter(file => /candidate/i.test(path.basename(file))), [],
    'this knife output must contain no CANDIDATE file');
  assert.deepEqual(fs.readdirSync(root).filter(file =>
    /^freeze-candidate-/.test(file) && file.includes(knife)), []);
}

function assertNoHostOrCandidate(proposal) {
  assert.notEqual(proposal.wroteCandidate, true);
  assert.equal(proposal.candidatePath ?? null, null);
  for (const hypothesis of [...proposal.accepted, ...proposal.rejected]) {
    assert.ok(!['host_code_patch', 'host_latch_adopt', 'host_code_patch_adopt'].includes(hypothesis.class));
    assert.notEqual(hypothesis.probeKind, 'host_code_patch');
    assert.notEqual(hypothesis.adopted, true);
    assert.notEqual(hypothesis.adopt, true);
    assert.notEqual(hypothesis.wroteCandidate, true);
    assert.equal(hypothesis.candidatePath ?? null, null);
  }
}

function realExperience() {
  return parseExperienceBody(fs.readFileSync(evidenceFile, 'utf8'), {
    file: path.basename(evidenceFile), full: evidenceFile,
  });
}

function fixtureExperience(slug, reason, lesson) {
  return parseExperienceBody([
    `# EXPERIENCE — ${slug}`, '', `- **slug**: ${slug}`,
    `- **adopted_candidate**: no (${reason})`, `- **lesson**: ${lesson}`, '',
  ].join('\n'), { file: `2026-10-25-${slug}-rejected.md` });
}

test('T-aepp-1: real adopt EXPERIENCE retrieves into Propose prior, never host adoption or CANDIDATE', t => {
  forbidFileWrites(t);
  assert.deepEqual(fs.readdirSync(fixtureDir), [path.basename(evidenceFile)]);
  assert.deepEqual(fs.readFileSync(path.join(fixtureDir, path.basename(evidenceFile))),
    fs.readFileSync(evidenceFile), 'isolated fixture must preserve the real adopt-written bytes');
  const record = readJson(path.join(evidenceRoot, 'adopt-record.json'));
  const adoptedRun = record.results.find(row => row.hypothesis === slug);
  assert.ok(adoptedRun, 'first-hand adopt record must contain the target hypothesis');
  assert.equal(record.adopt, true, 'top-level adopt describes the L1 contrast');
  assert.equal(record.candidateAdopt, false);
  assert.equal(record.candidateCount, 0);
  assert.equal(adoptedRun.l1.adopt, true);
  assert.equal(adoptedRun.adopt, false);
  assert.equal(adoptedRun.reason, 'experience_only');
  assert.equal(adoptedRun.wroteCandidate, false);
  assert.equal(adoptedRun.candidatePath, null);
  assert.equal(adoptedRun.experiencePath, evidenceFile);
  assert.equal(adoptedRun.l1.tipShaBaseline, pin);

  const entry = realExperience();
  assert.equal(entry.slug, slug);
  assert.equal(entry.adoptedRaw, 'no (experience_only)');
  assert.equal(entry.adopted, false);
  assert.equal(entry.rejectReason, 'experience_only');
  assert.deepEqual(entry.pathCounts, { dgr: 2, tipPath: 0, postAmt: 0, agentMiss: 2 });
  // Reuse recorded counters and check IDs; this fixture executes no runtime.
  const ingest = {
    totals: {}, runId: entry.runId.split(', ')[0],
    pathSignals: { dgrPromoteCount: 2, tipPathCount: 0, postAmtCount: 0, agentMissCount: 2 },
    cells: [{ cellId: 'adopt-evidence-fixture', evidenceQuotes: [
      { kind: 'dgr_promote', text: entry.checkIds[0] },
    ] }],
  };
  const hits = retrieveExperience(fixtureDir, {
    slug, reason: 'experience_only', query: buildExperienceQuery(ingest),
    pathSignals: ingest.pathSignals, runId: ingest.runId,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, path.basename(evidenceFile));
  assert.equal(hits[0].slug, slug);
  assert.equal(hits[0].adopted, false);
  assert.equal(hits[0].rejectReason, 'experience_only');

  // Exercise both injected parse fixtures and the existing directory read path.
  for (const opts of [{ experienceEntries: [entry] }, { experienceDir: fixtureDir }]) {
    const proposal = proposeFromIngest(ingest, opts);
    assert.deepEqual(proposal.rejected, []);
    const hypothesis = proposal.accepted.find(h => h.slug === slug);
    assert.ok(hypothesis, 'DGR observation must survive into accepted hypotheses');
    assert.equal(hypothesis.class, 'experience');
    assert.equal(hypothesis.latchDraftMd, null);
    const prior = hypothesis.prior.find(p => p.slug === slug);
    assert.ok(prior, 'adopt-written EXPERIENCE must attach as a prior');
    assert.equal(prior.file, path.basename(evidenceFile));
    assert.equal(prior.adopted, false, 'L1 adopt=true cannot become prior adopted=true');
    assert.equal(prior.reason, 'experience_only');
    assert.ok(hypothesis.prior.length <= 3);
    assertNoHostOrCandidate(proposal);
  }
  assertNoCandidateFiles();
});

test('T-aepp-2: diversity/archive/hard_gate refusal holds; PIN, hashes, FROZEN lock and zero CANDIDATE stay fixed', t => {
  forbidFileWrites(t);
  const hard = fixtureExperience('soft-hard-gate-observation', 'hard_gate_path',
    'Soft worktree touched a hard gate; retain the rejection as a warning only.');
  assert.equal(hard.adopted, false);
  assert.equal(hard.softReject, true);
  const poison = {
    totals: { poisonLoopCount: 1, dprCount: 1 },
    cells: [{ cellId: 'poison-fixture', poisonLoopCount: 1, dprCount: 1, evidenceQuotes: [
      { kind: 'poison_loop', text: 'probe-only recurrence' },
      { kind: 'dpr', text: 'demote observed' },
    ] }],
  };
  const proposal = proposeFromIngest(poison, { experienceEntries: [hard] });
  const soft = proposal.accepted.filter(isSoftHypothesis);
  assert.ok(soft.length > 0, 'hard_gate prior assertions must not be vacuous');
  for (const hypothesis of soft) {
    const prior = hypothesis.prior.find(p => p.slug === hard.slug);
    assert.ok(prior, 'soft hypothesis must retain the hard_gate warning');
    assert.equal(prior.reason, 'hard_gate_path');
    assert.equal(prior.adopted, false);
    assert.equal(prior.softReject, true);
  }
  assertNoHostOrCandidate(proposal);
  const contradictory = attachPrior(soft[0], [{ ...hard, adopted: true }]);
  assert.equal(contradictory.prior[0].adopted, false, 'soft rejection overrides an inconsistent adopted flag');
  assert.deepEqual(selectPriorsForHypothesis({ class: 'experience' }, [hard], [hard]), []);
  const gated = filterHypotheses(['host_code_patch', 'host_latch_adopt', 'host_code_patch_adopt'].map(cls => ({
    id: cls, slug: cls, title: 'Attempted promotion', class: cls,
    evidence: [{ kind: 'experience', text: hard.lesson }], prior: soft[0].prior,
  })));
  assert.deepEqual(gated.accepted, []);
  assert.equal(gated.rejected.length, 3);
  assert.ok(gated.rejected.every(h => h.forbiddenClass === FORBIDDEN_CLASSES.HOST_CODE_PATCH));

  const crowded = Array.from({ length: 6 }, (_, i) => fixtureExperience(
    `post-dpr-sticky-execute-${i}`, 'experience_only',
    'poison-loop sticky post-dpr soft latch dayloop soft-reject recurrence.',
  ));
  const diversity = proposeFromIngest({ totals: { poisonLoopCount: 1 }, cells: [] }, {
    experienceEntries: [...crowded, realExperience()],
  });
  assert.equal(diversity.experienceContext.length, 5);
  assert.ok(diversity.experienceContext.every(e => /sticky/.test(e.slug)), 'fixture saturates the diagnostic retrieval cap');
  const observation = diversity.accepted.find(h => !matchesMergedDirection(h));
  assert.ok(observation, 'a non-sticky lesson must survive retrieval saturation');
  assert.equal(observation.class, 'experience');
  assert.equal(matchesMergedDirection(observation), false);
  assert.ok(observation.evidence.some(e => e.experienceSlug === slug && e.text === realExperience().lesson),
    'the observational hypothesis must preserve the adopt-written source');
  assert.equal(observation.prior.find(p => p.slug === slug)?.adopted, false);
  assert.ok(diversity.accepted.length <= 3);
  assertNoHostOrCandidate(diversity);

  // Archive controls are strings, never CANDIDATE fixture files.
  for (const marker of ['ARCHIVED', 'SHIPPED', '挂着']) {
    for (const [title, status] of [[marker, 'CANDIDATE'], ['CANDIDATE', marker]]) {
      const body = `# Draft：**${title}**\n\n- **状态：${status}（勿开干）。**\n`;
      assert.equal(isArchivedOrShipped(body), true);
      assert.equal(isPendingCandidate(body), false);
    }
  }
  assert.equal(isPendingCandidate('# Draft：**CANDIDATE**\n'), true, 'pure in-memory positive control');
  assert.equal(isPendingCandidate(fs.readFileSync(path.join(root,
    'freeze-candidate-post-dpr-sticky-execute-r1.md'), 'utf8')), false);

  assert.equal(STEAL_TIP_PIN, pin);
  for (const [file, hash] of Object.entries(baselines)) {
    assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop', file))), hash, file);
  }
  const freeze = fs.readFileSync(path.join(root, `freeze-offloop-${knife}.md`), 'utf8');
  const title = freeze.split('\n')[0];
  const status = freeze.split('\n').find(line => /^- \*\*状态[：:]/.test(line)) || '';
  // Codex must not self-CLOSE; independent SCAN may flip to CLOSED — PASS（NO_PRODUCT_DELTA）.
  const frozenHonesty = /\*\*FROZEN \/ 开干\*\*/.test(freeze) && !/CLOSED/.test(title);
  const scanClosed = /CLOSED — PASS/.test(title)
    && /\*\*状态：CLOSED — PASS/.test(status)
    && /独立 SCAN/.test(freeze);
  assert.ok(frozenHonesty || scanClosed, 'freeze must stay FROZEN (Codex) or SCAN CLOSED');
  const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
  assert.equal(sha256(lock), lockHash, '§0 lock body must remain byte-identical');
  assertNoCandidateFiles();
});
