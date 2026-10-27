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
const knife = 'experience-transport-prior-live-wire-r1';
const out = path.join(root, 'offloop', `out-${knife}`);
const liveRoot = path.join(root, 'offloop/out-tip-soft-adopt-second-family-live-r1');
const evidenceFile = path.join(liveRoot, 'transport-record.json');
const fixtureFile = path.join(root,
  'offloop/out-transport-timeout-experience-prior-r1/experience/' +
  '2026-10-26-experience-transport-timeout-honest-stop-rejected.md');
const aeppRoot = path.join(root, 'offloop/out-dayloop-tip-soft-adopt-live-r1');
const aeppFile = path.join(aeppRoot,
  'temporary-miss-drive-t2H55F/out/experience/2026-10-25-experience-dgr-promote-observed-rejected.md');
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const requestSha = '82a7a2dab9de482955b86fef7dae9fba2cc9e3e6a10d13681266296c21ca08af';
const baselines = {
  'experience.mjs': '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb',
  'propose.mjs': '08390e92bc5de89c5b29286b24c942e93ec5256f6fc20e643f9bf09b0ea5c411',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const relative = file => path.relative(root, file).split(path.sep).join('/');
const readExperience = file => parseExperienceBody(fs.readFileSync(file, 'utf8'), {
  file: path.basename(file), full: file,
});

// The evidence and fixture exist before either test. A swallowed write error
// still fails the after-hook; retrieve/propose must be read-only.
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
    if (typeof fs.promises[name] === 'function') {
      t.mock.method(fs.promises, name, denied(`fs.promises.${name}`));
    }
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

function experienceMarkdownOutsideSuiteTmp(dir) {
  const found = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'suite-tmp') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md') && path.basename(current) === 'experience') {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found.sort();
}

function assertNoCandidateOrHost(proposal) {
  assert.ok(proposal.accepted.length > 0, 'prior claims must have an accepted hypothesis');
  assert.ok(proposal.accepted.length <= 3);
  for (const item of [proposal, ...proposal.accepted, ...proposal.rejected]) {
    assert.ok(!['host_code_patch', 'host_latch_adopt', 'host_code_patch_adopt'].includes(item.class));
    assert.notEqual(item.probeKind, 'host_code_patch');
    assert.notEqual(item.adopted, true);
    assert.notEqual(item.adopt, true);
    assert.notEqual(item.wroteCandidate, true);
    assert.equal(item.candidatePath ?? null, null);
  }
  assert.ok(proposal.accepted.every(h => h.prior.length <= 3));
}

function assertKnifeHasNoCandidate() {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    assert.doesNotMatch(entry.name, /candidate/i, 'this knife must have no CANDIDATE artifact');
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  for (const file of walk(out).filter(file => file.endsWith('.md'))) {
    assert.equal(isPendingCandidate(fs.readFileSync(file, 'utf8')), false, file);
  }
  assert.deepEqual(fs.readdirSync(root).filter(file =>
    /^freeze-candidate-/.test(file) && file.includes(knife)), []);
}

function memoryExperience(slug, reason, lesson) {
  return parseExperienceBody([
    `# EXPERIENCE — ${slug}`, '', `- **slug**: ${slug}`,
    `- **adopted_candidate**: no (${reason})`, `- **lesson**: ${lesson}`, '',
  ].join('\n'), { file: `2026-10-26-${slug}-rejected.md` });
}

test('T-etpl-1: real TimeoutError live tree has no TRANSPORT EXPERIENCE deposit; separate fixture still reaches warn-only prior', t => {
  forbidFileWrites(t);
  const session = readJson(path.join(out, 'session-start.json'));
  const record = readJson(evidenceFile);
  const sibling = readJson(path.join(liveRoot, 'summary.json'));
  assert.equal(sha256(fs.readFileSync(evidenceFile)), session.transportEvidence.sha256);
  assert.equal(record.requestSha256, requestSha);
  assert.equal(record.result, 'TRANSPORT');
  assert.equal(record.transportClass, 'TimeoutError');
  assert.deepEqual(record.subjects, ['t4/a', 't4/b']);
  assert.equal(record.elapsedMs, 50059);
  assert.equal(record.requestTimeoutMs, 45000);
  assert.equal(record.responseAudit, null);
  assert.equal(sibling.requestSha256, requestSha);
  assert.equal(sibling.adopt, false);
  assert.equal(sibling.candidateAdopt, false);
  assert.equal(sibling.candidateCount, 0);

  const scanned = experienceMarkdownOutsideSuiteTmp(liveRoot);
  const durableDir = path.join(liveRoot, 'temporary-miss-drive-Dvue4b/out/experience');
  const durable = scanned.filter(file => path.dirname(file) === durableDir);
  assert.equal(durable.length, 2, 'scan both durable run172 EXPERIENCE lessons');
  assert.ok(scanned.length >= durable.length, 'scan all non-suite-tmp EXPERIENCE dirs');
  const shaHits = [];
  const lessonHits = [];
  for (const file of scanned) {
    const body = fs.readFileSync(file, 'utf8');
    if (body.includes(requestSha) || body.includes(requestSha.slice(0, 8))) shaHits.push(relative(file));
    if (/\bTRANSPORT\b/i.test(body) && /TimeoutError|honest[- ]stop/i.test(body)) {
      lessonHits.push(relative(file));
    }
  }
  assert.deepEqual(shaHits, [], 'no live EXPERIENCE cites the timeout request SHA');
  assert.deepEqual(lessonHits, [], 'no live EXPERIENCE teaches this TRANSPORT/TimeoutError stop');
  const probe = readJson(path.join(out, 'live-probe.json'));
  assert.deepEqual(probe.scannedPaths, scanned.map(relative));
  assert.deepEqual(probe.requestShaHits, shaHits);
  assert.deepEqual(probe.transportTimeoutLessonHits, lessonHits);
  assert.equal(probe.liveWritePathProven, false);

  // Wave10 ttep authored this fixture after the live burn. Its read path is
  // useful coverage, but cannot be counted as a live write-path deposit.
  assert.ok(!fixtureFile.startsWith(liveRoot + path.sep));
  const fixture = readExperience(fixtureFile);
  const ttepSummary = readJson(path.join(root, 'offloop/out-transport-timeout-experience-prior-r1/summary.json'));
  assert.equal(ttepSummary.fixture.liveBurnWroteThisFile, false);
  assert.match(fixture.body, /\*\*fixture\*\*: true.*not emitted by the live burn/);
  assert.equal(fixture.adopted, false);
  assert.equal(fixture.rejectReason, 'experience_only');
  assert.equal(fixture.pathCounts, null);
  assert.ok(fixture.body.includes(`- **requestSha256**: ${requestSha}`));
  assert.ok(fixture.body.includes(`- **evidence_path**: ${evidenceFile}`));
  assert.match(fixture.lesson, /TRANSPORT \/ TimeoutError.*82a7a2da/);
  assert.match(fixture.lesson, /not adopt=true or CANDIDATE authorization/);

  const ingest = {
    totals: {},
    cells: record.subjects.map(cellId => ({ cellId, evidenceQuotes: [{
      kind: 'observation', source: evidenceFile,
      text: `${record.result} / ${record.transportClass}; requestSha256=${record.requestSha256}`,
    }] })),
  };
  for (const query of ['TRANSPORT TimeoutError', buildExperienceQuery(ingest)]) {
    const hits = retrieveExperience(path.dirname(fixtureFile), { query });
    assert.deepEqual(hits.map(hit => hit.slug), [fixture.slug]);
    assert.equal(hits[0].adopted, false);
    assert.equal(hits[0].rejectReason, 'experience_only');
    assert.ok(hits[0].score > 0);
  }
  for (const opts of [{ experienceEntries: [fixture] }, { experienceDir: path.dirname(fixtureFile) }]) {
    const proposal = proposeFromIngest(ingest, opts);
    assert.deepEqual(proposal.rejected, []);
    assert.ok(proposal.experienceContext.some(hit => hit.slug === fixture.slug && hit.adopted === false));
    for (const hypothesis of proposal.accepted) {
      assert.equal(hypothesis.class, 'experience');
      assert.equal(hypothesis.latchDraftMd, null);
      const prior = hypothesis.prior.find(p => p.slug === fixture.slug);
      assert.ok(prior, 'fixture lesson is visible in Propose prior');
      assert.equal(prior.adopted, false);
      assert.equal(prior.reason, 'experience_only');
      assert.equal(prior.lesson, fixture.lesson);
      assert.ok(hypothesis.evidence.some(e => e.experienceSlug === fixture.slug &&
        e.file === path.basename(fixtureFile) && e.text === fixture.lesson));
    }
    assertNoCandidateOrHost(proposal);
  }
  assertKnifeHasNoCandidate();
});

test('T-etpl-2: aepp/ttep diversity, soft rejection and archive refuse promotion; PIN, hashes and FROZEN lock hold', t => {
  forbidFileWrites(t);
  const aepp = readExperience(aeppFile);
  const transportFixture = readExperience(fixtureFile);
  const aeppRecord = readJson(path.join(aeppRoot, 'adopt-record.json'));
  const row = aeppRecord.results.find(result => result.hypothesis === aepp.slug);
  assert.ok(row);
  assert.equal(row.l1.adopt, true, 'historical L1 adoption is distinct from candidate adoption');
  assert.equal(row.adopt, false);
  assert.equal(row.wroteCandidate, false);
  assert.equal(row.candidatePath, null);
  assert.equal(row.reason, 'experience_only');
  assert.equal(row.l1.tipShaBaseline, pin);
  assert.equal(aepp.adopted, false);
  assert.equal(aepp.pathCounts.dgr, 2);
  const aeppProposal = proposeFromIngest({
    totals: {}, pathSignals: { dgrPromoteCount: aepp.pathCounts.dgr },
    cells: [{ cellId: 'historical-aepp-read-control', evidenceQuotes: [
      { kind: 'dgr_promote', text: aepp.checkIds[0] },
    ] }],
  }, { experienceEntries: [aepp] });
  const observation = aeppProposal.accepted.find(h => h.slug === aepp.slug);
  assert.ok(observation);
  assert.equal(observation.class, 'experience');
  assert.equal(observation.prior.find(p => p.slug === aepp.slug)?.adopted, false);
  assert.equal(observation.prior.find(p => p.slug === aepp.slug)?.reason, 'experience_only');
  assertNoCandidateOrHost(aeppProposal);

  const hard = memoryExperience('soft-hard-gate-observation', 'hard_gate_path',
    'Soft worktree touched a hard gate; retain the rejection as a warning only.');
  const poison = {
    totals: { poisonLoopCount: 1, dprCount: 1 },
    cells: [{ cellId: 'in-memory-control', poisonLoopCount: 1, dprCount: 1, evidenceQuotes: [
      { kind: 'poison_loop', text: 'synthetic probe-only recurrence' },
      { kind: 'dpr', text: 'synthetic demote observation' },
    ] }],
  };
  const softProposal = proposeFromIngest(poison, { experienceEntries: [hard] });
  const soft = softProposal.accepted.filter(isSoftHypothesis);
  assert.ok(soft.length > 0);
  for (const hypothesis of soft) {
    const prior = hypothesis.prior.find(p => p.slug === hard.slug);
    assert.ok(prior);
    assert.equal(prior.reason, 'hard_gate_path');
    assert.equal(prior.adopted, false);
    assert.equal(prior.softReject, true);
  }
  assert.equal(attachPrior(soft[0], [{ ...hard, adopted: true }]).prior[0].adopted, false);
  assert.deepEqual(selectPriorsForHypothesis({ class: 'experience' }, [hard], [hard]), []);
  const gated = filterHypotheses(['host_code_patch', 'host_latch_adopt', 'host_code_patch_adopt'].map(cls => ({
    id: cls, slug: cls, title: 'Attempted promotion', class: cls,
    evidence: [{ kind: 'experience', text: hard.lesson }], prior: soft[0].prior,
  })));
  assert.deepEqual(gated.accepted, []);
  assert.equal(gated.rejected.length, 3);
  assert.ok(gated.rejected.every(h => h.forbiddenClass === FORBIDDEN_CLASSES.HOST_CODE_PATCH));
  assertNoCandidateOrHost(softProposal);

  const crowded = Array.from({ length: 6 }, (_, i) => memoryExperience(
    `post-dpr-sticky-execute-${i}`, 'experience_only',
    'poison-loop sticky post-dpr soft latch dayloop soft-reject recurrence.',
  ));
  for (const source of [aepp, transportFixture]) {
    const diversity = proposeFromIngest({ totals: { poisonLoopCount: 1 }, cells: [] }, {
      experienceEntries: [...crowded, source],
    });
    assert.equal(diversity.experienceContext.length, 5);
    assert.ok(diversity.experienceContext.every(e => /sticky/.test(e.slug)));
    const lesson = diversity.accepted.find(h => !matchesMergedDirection(h));
    assert.ok(lesson, 'non-sticky sourced lesson survives saturated retrieval');
    assert.equal(lesson.class, 'experience');
    assert.equal(lesson.latchDraftMd, null);
    assert.ok(lesson.evidence.some(e => e.experienceSlug === source.slug && e.text === source.lesson));
    const prior = lesson.prior.find(p => p.slug === source.slug);
    assert.equal(prior?.adopted, false);
    assert.equal(prior?.reason, 'experience_only');
    assertNoCandidateOrHost(diversity);
  }

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

  const session = readJson(path.join(out, 'session-start.json'));
  const delta = readJson(path.join(out, 'no-product-delta.json'));
  const summary = readJson(path.join(out, 'summary.json'));
  assert.equal(STEAL_TIP_PIN, pin);
  assert.equal(session.tipPin, pin);
  assert.equal(fs.readFileSync(path.join(out, 'tip-head.txt'), 'utf8').trim(), pin);
  assert.equal(delta.tipPin, pin);
  assert.equal(delta.productDelta, 'NO_PRODUCT_DELTA');
  assert.equal(delta.productWrites, 0);
  assert.equal(delta.candidateWrites, 0);
  assert.equal(delta.liveWritePathProven, false);
  assert.deepEqual(delta.productGapsFound, []);
  assert.equal(delta.runtimeExecutions, 0);
  assert.equal(delta.liveRequests, 0);
  assert.equal(delta.replayExecutions, 0);
  assert.equal(delta.freezeRemainsFROZEN, true);
  assert.equal(delta.selfClosed, false);
  assert.equal(summary.status, 'FROZEN / SCAN READY');
  assert.equal(summary.productWrites, 0);
  assert.equal(summary.selfClosed, false);
  assert.deepEqual(fs.readFileSync(path.join(out, 'after-hashes.txt')),
    fs.readFileSync(path.join(out, 'before-hashes.txt')));
  for (const [file, hash] of Object.entries(baselines)) {
    assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop', file))), hash, file);
    assert.equal(session[file === 'experience.mjs' ? 'experienceSha' : 'proposeSha'], hash);
    assert.deepEqual(delta[file === 'experience.mjs' ? 'experience' : 'propose'], {
      before: hash, after: hash, unchanged: true,
    });
  }
  const freeze = fs.readFileSync(path.join(root, `freeze-offloop-${knife}.md`), 'utf8');
  assert.ok(freezeLifecycleHonest(freeze),
    'freeze must be FROZEN honesty or independent SCAN CLOSED — PASS (incl NO_PRODUCT_DELTA/STOP)');
  const lock = freeze.slice(freeze.indexOf('## 0. 锁定\n'), freeze.indexOf('## 1. 不做'));
  assert.equal(sha256(lock), session.freezeLockSha256);
  assert.equal(session.freezeLockSha256,
    'a9637824a3f9da9d1f9a7d41b81add1d77e1a5bf9a1a5b5202f47b8b92948cc2');
  assertKnifeHasNoCandidate();
});
