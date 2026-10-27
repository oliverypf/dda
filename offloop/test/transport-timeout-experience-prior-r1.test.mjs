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
import { freezeLifecycleHonest } from './test-lifecycle-scan-closed-accept-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'transport-timeout-experience-prior-r1';
const out = path.join(root, 'offloop', `out-${knife}`);
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const baselines = {
  'experience.mjs': '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb',
  'propose.mjs': '08390e92bc5de89c5b29286b24c942e93ec5256f6fc20e643f9bf09b0ea5c411',
};
const freezeHash = 'bcbe4b756bc9a316996f74cb253eee45b8ef08c86edac22f6b1b4b3a3324f42c';
const lockHash = '5cfbfa079320f432b78bd58421aaa48b7c527b8b2667fdced6817eff2ec2fed6';
const evidenceRoot = path.join(root, 'offloop/out-tip-soft-adopt-second-family-live-r1');
const evidenceFile = path.join(evidenceRoot, 'transport-record.json');
const requestSha = '82a7a2dab9de482955b86fef7dae9fba2cc9e3e6a10d13681266296c21ca08af';
const slug = 'experience-transport-timeout-honest-stop';
const fixtureFile = path.join(out, 'experience', `2026-10-26-${slug}-rejected.md`);
const aeppRoot = path.join(root, 'offloop/out-dayloop-tip-soft-adopt-live-r1');
const aeppFile = path.join(aeppRoot,
  'temporary-miss-drive-t2H55F/out/experience/2026-10-25-experience-dgr-promote-observed-rejected.md');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const readExperience = file => parseExperienceBody(fs.readFileSync(file, 'utf8'), {
  file: path.basename(file), full: file,
});

// The fixture is already on disk. Retrieval and Propose run with writes forbidden;
// a swallowed write error still fails the after-hook. No write-side module runs.
function forbidFileWrites(t) {
  let attempts = 0;
  const denied = name => () => {
    attempts += 1;
    assert.fail(`unexpected filesystem mutation: ${name}`);
  };
  const mutations = [
    'writeFile', 'appendFile', 'copyFile', 'cp', 'rename', 'truncate',
    'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'link', 'symlink',
    'write', 'writev', 'ftruncate', 'chmod', 'fchmod', 'chown', 'fchown',
    'lchmod', 'lchown', 'utimes', 'futimes', 'lutimes',
  ];
  for (const name of [...mutations, ...mutations.map(name => `${name}Sync`), 'createWriteStream']) {
    if (typeof fs[name] === 'function') t.mock.method(fs, name, denied(`fs.${name}`));
  }
  for (const name of mutations) {
    if (typeof fs.promises[name] === 'function') t.mock.method(fs.promises, name, denied(`fs.promises.${name}`));
  }
  const writeFlags = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND |
    fs.constants.O_CREAT | fs.constants.O_TRUNC;
  for (const [owner, name] of [[fs, 'open'], [fs, 'openSync'], [fs.promises, 'open']]) {
    const original = owner[name];
    t.mock.method(owner, name, function (file, flags, ...args) {
      const readOnly = typeof flags === 'number' ? (flags & writeFlags) === 0 : /^(r|rs|sr)$/.test(flags);
      if (!readOnly) return denied(`${name}(${flags})`)();
      return Reflect.apply(original, this, [file, flags, ...args]);
    });
  }
  t.after(() => assert.equal(attempts, 0, 'retrieve/propose must attempt zero filesystem writes'));
}

function assertNoCandidateFiles() {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    assert.doesNotMatch(entry.name, /candidate/i, 'no CANDIDATE files or directories in this knife output');
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  for (const file of walk(out).filter(file => file.endsWith('.md'))) {
    assert.equal(isPendingCandidate(fs.readFileSync(file, 'utf8')), false, file);
  }
  assert.deepEqual(fs.readdirSync(root).filter(file =>
    /^freeze-candidate-/.test(file) && file.includes(knife)), []);
}

function assertNoHostOrCandidate(proposal) {
  for (const item of [proposal, ...proposal.accepted, ...proposal.rejected]) {
    assert.ok(!['host_code_patch', 'host_latch_adopt', 'host_code_patch_adopt'].includes(item.class));
    assert.notEqual(item.probeKind, 'host_code_patch');
    assert.notEqual(item.adopted, true);
    assert.notEqual(item.adopt, true);
    assert.notEqual(item.wroteCandidate, true);
    assert.equal(item.candidatePath ?? null, null);
  }
  assert.ok(proposal.accepted.length <= 3);
  assert.ok(proposal.accepted.every(h => h.prior.length <= 3));
}

function memoryExperience(slug, reason, lesson) {
  return parseExperienceBody([
    `# EXPERIENCE — ${slug}`, '', `- **slug**: ${slug}`,
    `- **adopted_candidate**: no (${reason})`, `- **lesson**: ${lesson}`, '',
  ].join('\n'), { file: `2026-10-26-${slug}-rejected.md` });
}

test('T-ttep-1: TRANSPORT/TimeoutError fixture (82a7a2da…) retrieves into Propose prior, never host adoption or CANDIDATE', t => {
  forbidFileWrites(t);
  const record = readJson(evidenceFile);
  assert.equal(record.result, 'TRANSPORT');
  assert.equal(record.transportClass, 'TimeoutError');
  assert.equal(record.requestSha256, requestSha);
  assert.deepEqual(record.subjects, ['t4/a', 't4/b']);
  assert.equal(record.elapsedMs, 50059);
  assert.equal(record.requestTimeoutMs, 45000);
  assert.equal(record.responseAudit, null, 'timeout supplies no successful audit or adoption');
  const scanned = readJson(path.join(evidenceRoot, 'summary.json'));
  assert.equal(scanned.requestSha256, record.requestSha256);
  assert.equal(scanned.result, 'TRANSPORT');
  assert.equal(scanned.transportClass, 'TimeoutError');
  assert.equal(scanned.adopt, false);
  assert.equal(scanned.candidateAdopt, false);
  assert.equal(scanned.candidateCount, 0);

  const entry = readExperience(fixtureFile);
  assert.equal(entry.slug, slug);
  assert.equal(entry.adoptedRaw, 'no (experience_only)');
  assert.equal(entry.adopted, false);
  assert.equal(entry.rejectReason, 'experience_only');
  assert.equal(entry.pathCounts, null, 'transport evidence must not invent runtime path counters');
  assert.equal(entry.checkIds, null);
  assert.match(entry.body, /\*\*fixture\*\*: true.*not emitted by the live burn/);
  assert.ok(entry.body.includes(`- **evidence_path**: ${evidenceFile}`));
  for (const field of ['requestSha256', 'result', 'transportClass', 'elapsedMs', 'requestTimeoutMs']) {
    assert.ok(entry.body.includes(`- **${field}**: ${record[field]}`), field);
  }
  assert.ok(entry.body.includes(`- **subjects**: ${record.subjects.join(',')}`));
  assert.ok(entry.lesson.length <= 240, 'the complete warning must survive the prior text cap');
  assert.match(entry.lesson, /not adopt=true or CANDIDATE authorization/);

  // Historical subjects and transport facts only: no synthetic green/path event.
  const ingest = {
    totals: {},
    cells: record.subjects.map(cellId => ({ cellId, evidenceQuotes: [{
      kind: 'observation', source: evidenceFile,
      text: `${record.result} / ${record.transportClass}; requestSha256=${record.requestSha256}`,
    }] })),
  };
  for (const query of ['TRANSPORT TimeoutError', buildExperienceQuery(ingest)]) {
    const hits = retrieveExperience(path.dirname(fixtureFile), { query });
    assert.deepEqual(hits.map(hit => hit.slug), [slug], 'unfiltered retrieval must surface the lesson');
    assert.equal(hits[0].adopted, false);
    assert.equal(hits[0].rejectReason, 'experience_only');
    assert.equal(hits[0].path, fixtureFile);
    assert.ok(hits[0].score > 0);
  }

  for (const opts of [{ experienceEntries: [entry] }, { experienceDir: path.dirname(fixtureFile) }]) {
    const proposal = proposeFromIngest(ingest, opts);
    assert.deepEqual(proposal.rejected, []);
    assert.ok(proposal.experienceContext.some(hit => hit.slug === slug && hit.adopted === false));
    assert.equal(proposal.experienceContext.find(hit => hit.slug === slug)?.path, fixtureFile);
    assert.ok(proposal.accepted.length > 0, 'the prior assertions must not be vacuous');
    for (const hypothesis of proposal.accepted) {
      assert.equal(hypothesis.class, 'experience');
      assert.equal(hypothesis.latchDraftMd, null);
      const prior = hypothesis.prior.find(p => p.slug === slug);
      assert.ok(prior, 'TRANSPORT EXPERIENCE must attach as a visible prior');
      assert.equal(prior.file, path.basename(fixtureFile));
      assert.equal(prior.adopted, false);
      assert.equal(prior.reason, 'experience_only');
      assert.equal(prior.lesson, entry.lesson);
      assert.match(prior.lesson, /TRANSPORT \/ TimeoutError.*82a7a2da/);
      assert.ok(hypothesis.evidence.some(e => e.experienceSlug === slug &&
        e.file === path.basename(fixtureFile) && e.text === entry.lesson), 'retain the deposited fixture as the source');
    }
    assertNoHostOrCandidate(proposal);
  }
  assertNoCandidateFiles();
});

test('T-ttep-2: aepp/diversity/archive/hard_gate refusal holds; PIN, hashes, FROZEN lock and zero CANDIDATE stay fixed', t => {
  forbidFileWrites(t);
  const aepp = readExperience(aeppFile);
  const aeppRecord = readJson(path.join(aeppRoot, 'adopt-record.json'));
  const row = aeppRecord.results.find(result => result.hypothesis === aepp.slug);
  assert.ok(row);
  assert.equal(row.l1.adopt, true, 'historical aepp L1 adoption remains distinct from candidate adoption');
  assert.equal(row.adopt, false);
  assert.equal(row.wroteCandidate, false);
  assert.equal(row.candidatePath, null);
  assert.equal(row.reason, 'experience_only');
  assert.equal(row.l1.tipShaBaseline, pin);
  assert.equal(aepp.adopted, false);
  assert.equal(aepp.pathCounts.dgr, 2);
  assert.ok(aepp.checkIds[0]);
  const aeppProposal = proposeFromIngest({
    totals: {}, pathSignals: { dgrPromoteCount: aepp.pathCounts.dgr },
    cells: [{ cellId: 'historical-aepp-read-control', evidenceQuotes: [
      { kind: 'dgr_promote', text: aepp.checkIds[0] },
    ] }],
  }, { experienceEntries: [aepp] });
  const aeppObservation = aeppProposal.accepted.find(h => h.slug === aepp.slug);
  assert.ok(aeppObservation);
  assert.equal(aeppObservation.class, 'experience');
  assert.equal(aeppObservation.latchDraftMd, null);
  const aeppPrior = aeppObservation.prior.find(p => p.slug === aepp.slug);
  assert.equal(aeppPrior?.adopted, false);
  assert.equal(aeppPrior?.reason, 'experience_only');
  assertNoHostOrCandidate(aeppProposal);

  const hard = memoryExperience('soft-hard-gate-observation', 'hard_gate_path',
    'Soft worktree touched a hard gate; retain the rejection as a warning only.');
  const poison = {
    totals: { poisonLoopCount: 1, dprCount: 1 },
    cells: [{ cellId: 'in-memory-regression-control', poisonLoopCount: 1, dprCount: 1, evidenceQuotes: [
      { kind: 'poison_loop', text: 'synthetic probe-only recurrence' },
      { kind: 'dpr', text: 'synthetic demote observation' },
    ] }],
  };
  const proposal = proposeFromIngest(poison, { experienceEntries: [hard] });
  const soft = proposal.accepted.filter(isSoftHypothesis);
  assert.ok(soft.length > 0, 'hard_gate assertions must not be vacuous');
  for (const hypothesis of soft) {
    const prior = hypothesis.prior.find(p => p.slug === hard.slug);
    assert.ok(prior, 'soft hypotheses retain the hard_gate warning');
    assert.equal(prior.reason, 'hard_gate_path');
    assert.equal(prior.adopted, false);
    assert.equal(prior.softReject, true);
  }
  assert.equal(attachPrior(soft[0], [{ ...hard, adopted: true }]).prior[0].adopted, false,
    'soft rejection overrides contradictory adoption');
  assert.deepEqual(selectPriorsForHypothesis({ class: 'experience' }, [hard], [hard]), []);
  const gated = filterHypotheses(['host_code_patch', 'host_latch_adopt', 'host_code_patch_adopt'].map(cls => ({
    id: cls, slug: cls, title: 'Attempted promotion', class: cls,
    evidence: [{ kind: 'experience', text: hard.lesson }], prior: soft[0].prior,
  })));
  assert.deepEqual(gated.accepted, []);
  assert.equal(gated.rejected.length, 3);
  assert.ok(gated.rejected.every(h => h.forbiddenClass === FORBIDDEN_CLASSES.HOST_CODE_PATCH));
  assertNoHostOrCandidate(proposal);

  const crowded = Array.from({ length: 6 }, (_, i) => memoryExperience(
    `post-dpr-sticky-execute-${i}`, 'experience_only',
    'poison-loop sticky post-dpr soft latch dayloop soft-reject recurrence.',
  ));
  for (const source of [aepp, readExperience(fixtureFile)]) {
    const diversity = proposeFromIngest({ totals: { poisonLoopCount: 1 }, cells: [] }, {
      experienceEntries: [...crowded, source],
    });
    assert.equal(diversity.experienceContext.length, 5);
    assert.ok(diversity.experienceContext.every(e => /sticky/.test(e.slug)), 'saturate the diagnostic retrieval cap');
    const observation = diversity.accepted.find(h => !matchesMergedDirection(h));
    assert.ok(observation, 'a sourced non-sticky observation must survive the crowded library');
    assert.equal(observation.class, 'experience');
    assert.equal(observation.latchDraftMd, null);
    assert.ok(observation.evidence.some(e => e.experienceSlug === source.slug && e.text === source.lesson));
    const prior = observation.prior.find(p => p.slug === source.slug);
    assert.equal(prior?.adopted, false);
    assert.equal(prior?.reason, 'experience_only');
    assertNoHostOrCandidate(diversity);
  }

  // Archive controls stay in memory; never create a CANDIDATE fixture file.
  for (const marker of ['ARCHIVED', 'SHIPPED', '挂着']) {
    for (const [title, status] of [[marker, 'CANDIDATE'], ['CANDIDATE', marker]]) {
      const body = `# Draft：**${title}**\n\n- **状态：${status}（勿开干）。**\n`;
      assert.equal(isArchivedOrShipped(body), true);
      assert.equal(isPendingCandidate(body), false);
    }
  }
  assert.equal(isPendingCandidate('# Draft：**CANDIDATE**\n'), true);
  assert.equal(isPendingCandidate(fs.readFileSync(path.join(root,
    'freeze-candidate-post-dpr-sticky-execute-r1.md'), 'utf8')), false);

  assert.equal(STEAL_TIP_PIN, pin);
  const session = readJson(path.join(out, 'session-start.json'));
  assert.equal(session.tipPin, pin);
  for (const [file, hash] of Object.entries(baselines)) {
    assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop', file))), hash, file);
  }
  assert.equal(sha256(fs.readFileSync(path.join(out, 'before-hashes.txt'))), session.beforeHashesSha256);
  for (const [file, hash] of Object.entries(session.sourceHashes)) {
    assert.equal(sha256(fs.readFileSync(path.join(root, file))), hash, 'historical evidence stays byte-intact');
  }
  const freeze = fs.readFileSync(path.join(root, `freeze-offloop-${knife}.md`), 'utf8');
  assert.ok(freezeLifecycleHonest(freeze),
    'freeze must stay FROZEN (Codex handoff) or independent SCAN CLOSED — PASS');
  const lock = freeze.slice(freeze.indexOf('## 0. 锁定\n'), freeze.indexOf('## 1. 不做'));
  assert.equal(sha256(lock), lockHash, '§0 including its heading stays byte-intact');
  assert.equal(session.freezeSha256, freezeHash);
  assert.equal(session.freezeLockSha256, lockHash);
  assertNoCandidateFiles();
});
