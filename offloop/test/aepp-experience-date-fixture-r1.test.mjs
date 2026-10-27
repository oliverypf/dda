import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildExperienceQuery, parseExperienceBody, retrieveExperience } from '../experience.mjs';
import { proposeFromIngest } from '../propose.mjs';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { freezeLifecycleHonest } from './test-lifecycle-scan-closed-accept-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'aepp-experience-date-fixture-r1';
const out = path.join(root, 'offloop', `out-${knife}`);
const fixtureDir = path.join(out, 'fixture-experience');
const mixedDir = path.join(out, 'fixture-experience-with-newer-sibling');
const pinned = '2026-10-25-experience-dgr-promote-observed-rejected.md';
const newer = '2099-01-01-experience-dgr-promote-observed-rejected.md';
const evidenceFile = path.join(root,
  'offloop/out-dayloop-tip-soft-adopt-live-r1/temporary-miss-drive-t2H55F/out/experience', pinned);
const slug = 'experience-dgr-promote-observed';
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const lockHash = 'a8d5ed8f0c4ad9d2522655c43d2dcb6e6742f926a37711fed2570dd0d1f2974b';
const baselines = {
  'experience.mjs': '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb',
  'propose.mjs': '08390e92bc5de89c5b29286b24c942e93ec5256f6fc20e643f9bf09b0ea5c411',
};
const sha256 = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');

function assertPrior(proposal, file, lesson) {
  assert.deepEqual(proposal.rejected, []);
  const hypothesis = proposal.accepted.find(h => h.slug === slug);
  assert.ok(hypothesis, 'the adopt-written DGR observation must survive');
  assert.equal(hypothesis.class, 'experience');
  assert.equal(hypothesis.latchDraftMd, null);
  const prior = hypothesis.prior.find(p => p.slug === slug);
  assert.ok(prior, 'the adopt-written lesson must attach as a prior');
  assert.equal(prior.file, file);
  assert.equal(prior.lesson, lesson);
  assert.equal(prior.adopted, false);
  assert.equal(prior.reason, 'experience_only');
}

test('T-aedf-1: isolated adopt bytes and explicit file pin ignore a newer same-slug date decoy', () => {
  const body = read(evidenceFile);
  assert.equal(sha256(body), 'feed0fcef801ada1b750b949520f292a75da3194f5aadec710fac1b2c6800928');
  assert.deepEqual(fs.readdirSync(fixtureDir), [pinned]);
  assert.deepEqual(fs.readdirSync(mixedDir).sort(), [pinned, newer]);
  assert.equal(read(path.join(fixtureDir, pinned)), body);
  assert.equal(read(path.join(mixedDir, pinned)), body);
  // Synthetic future date exists only in this knife's negative fixture, never live evidence.
  assert.equal(read(path.join(mixedDir, newer)), body.replace(
    '- **date**: 2026-10-25 (America/Adak)', '- **date**: 2099-01-01 (America/Adak)'));

  // Select the full pinned path while both dated siblings are present.
  const full = path.join(mixedDir, pinned);
  const entry = parseExperienceBody(read(full), { file: pinned, full });
  const ingest = {
    totals: {}, runId: entry.runId.split(', ')[0],
    pathSignals: { dgrPromoteCount: 2, tipPathCount: 0, postAmtCount: 0, agentMissCount: 2 },
    cells: [{ cellId: 'adopt-evidence-fixture', evidenceQuotes: [
      { kind: 'dgr_promote', text: entry.checkIds[0] },
    ] }],
  };
  const query = {
    slug, reason: 'experience_only', query: buildExperienceQuery(ingest),
    pathSignals: ingest.pathSignals, runId: ingest.runId,
  };

  // Positive control for the original false red: unpinned selection prefers the decoy.
  assert.deepEqual(retrieveExperience(mixedDir, query).map(hit => hit.file), [newer]);
  assertPrior(proposeFromIngest(ingest, { experienceDir: mixedDir }), newer, entry.lesson);

  // The same isolated directory path used by T-aepp stays pinned across date drift.
  for (const [dir, opts] of [[fixtureDir, query], [null, { ...query, entries: [entry] }]]) {
    const hits = retrieveExperience(dir, opts);
    assert.deepEqual(hits.map(hit => hit.file), [pinned]);
    assert.equal(hits[0].lesson, entry.lesson);
    assert.equal(hits[0].adopted, false);
    assert.equal(hits[0].rejectReason, 'experience_only');
  }
  for (const opts of [{ experienceDir: fixtureDir }, { experienceEntries: [entry] }]) {
    assertPrior(proposeFromIngest(ingest, opts), pinned, entry.lesson);
  }
});

test('T-aedf-2: hardened T-aepp passes 2/2; PIN, product bytes and §0 lock stay fixed across independent SCAN', () => {
  const env = { ...process.env };
  // Nested node --test must report named cases, independent of the parent runner context.
  delete env.NODE_TEST_CONTEXT;
  const tap = execFileSync('/home/box/.local/node24/bin/node', [
    '--test', '--test-reporter=tap', 'test/adopt-experience-propose-prior-r1.test.mjs',
  ], {
    cwd: path.join(root, 'offloop'), env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  assert.match(tap, /^ok 1 - T-aepp-1:/m);
  assert.match(tap, /^ok 2 - T-aepp-2:/m);
  assert.match(tap, /^# tests 2$/m);
  assert.match(tap, /^# pass 2$/m);
  assert.match(tap, /^# fail 0$/m);
  assert.doesNotMatch(tap, /^not ok|# SKIP|# TODO/m);

  const session = JSON.parse(read(path.join(out, 'session-start.json')));
  assert.equal(STEAL_TIP_PIN, pin);
  assert.equal(session.tipPin, pin);
  assert.equal(read(path.join(out, 'tip-head.txt')).trim(), pin);
  const before = new Map(read(path.join(out, 'before-hashes.txt')).trim().split('\n').map(line => {
    const match = line.match(/^([a-f0-9]{64})  (offloop\/[\w-]+\.mjs)$/);
    assert.ok(match, `invalid product baseline: ${line}`);
    return [match[2], match[1]];
  }));
  const products = fs.readdirSync(path.join(root, 'offloop'))
    .filter(file => file.endsWith('.mjs')).map(file => `offloop/${file}`).sort();
  assert.deepEqual(products, [...before.keys()].sort());
  const changedProducts = products.filter(file => sha256(fs.readFileSync(path.join(root, file))) !== before.get(file));
  assert.deepEqual(changedProducts, [], 'productWrites=0: all product bytes match session baseline');
  for (const [file, hash] of Object.entries(baselines)) {
    assert.equal(session.productBaselines[file], hash);
    assert.equal(before.get(`offloop/${file}`), hash);
    assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop', file))), hash);
  }

  const freeze = read(path.join(root, `freeze-offloop-${knife}.md`));
  assert.ok(freezeLifecycleHonest(freeze),
    'freeze must stay FROZEN (Codex handoff) or independent SCAN CLOSED — PASS');
  const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
  assert.equal(session.freezeLockSha256, lockHash);
  assert.equal(sha256(lock), lockHash, '§0 lock body must remain byte-identical');
  assert.match(read(path.join(root, 'freeze-offloop-adopt-experience-propose-prior-r1.md')).split('\n')[0],
    /CLOSED — PASS（NO_PRODUCT_DELTA）/, 'wave9 independent SCAN PASS remains closed');
});
