import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'offloop/out-harness2-compose-experience-gap-audit-r1');
const knife = 'harness2-compose-experience-gap-audit-r1';
const experienceSha = '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb';
const composeSha = 'd00f0ef03eb4c30cef9097534db52ee5b3e59acd355d7a204ce83a6beac76e8f';
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const lockSha = '787f542ac54f63dc60e4788768ce093151253890ef23304673139683eb852c19';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const experienceClosed = [
  'path-anomaly-experience-complete-r1',
  'path-anomaly-experience-consume-r1',
  'experience-dedupe-retrieve-r1',
  'experience-slug-filter-before-dedupe-r1',
  'experience-soft-priors-r1',
  'dgr-mid-reject-experience-structure-r1',
];
const composeClosed = [
  'compose-soft-footer-contract-r1',
  'verify-audit-compose-pin-refresh-r1',
  'path-anomaly-compose-drift-closeout-r1',
];

function hashRows(name) {
  const rows = read(`offloop/out-${knife}/${name}`).trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^(\S+)\s+([a-f0-9]+)$/);
    assert.ok(match, `invalid ${name} row: ${line}`);
    return [match[1], match[2]];
  });
  assert.equal(new Set(rows.map(([key]) => key)).size, rows.length, `${name} keys unique`);
  return Object.fromEntries(rows);
}

test('T-hceg-1: STOP evidence records 勾选但无差分, unchanged product hashes and FROZEN lock', () => {
  const evidencePath = path.join(out, 'no-product-delta.json');
  assert.ok(fs.existsSync(evidencePath), 'STOP evidence exists');
  const npd = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const session = readJson(`offloop/out-${knife}/session-start.json`);
  assert.equal(npd.knife, knife);
  assert.equal(npd.wave, 'wave11');
  assert.equal(npd.knifeNumber, 6);
  assert.equal(npd.pack, 'B');
  assert.equal(npd.productDelta, 'NO_PRODUCT_DELTA');
  assert.match(npd.conclusion, /勾选但无差分/);
  assert.equal(npd.productWrites, 0);
  assert.equal(npd.stop, true);
  assert.equal(npd.tipPin, tipPin);
  assert.equal(npd.freezeRemainsFROZEN, true);
  assert.equal(npd.selfClosed, false);
  assert.deepEqual(npd.gapsFound, []);
  assert.deepEqual(npd.productGapsFound, []);
  assert.deepEqual(npd.closedKnivesScanned.experience, experienceClosed);
  assert.deepEqual(npd.closedKnivesScanned.compose, composeClosed);

  assert.equal(session.experienceSha, experienceSha);
  assert.equal(session.composeSha, composeSha);
  assert.equal(session.freezeLockSha256, lockSha);
  const before = hashRows('before-hashes.txt');
  const after = hashRows('after-hashes.txt');
  assert.deepEqual(Object.keys(after), Object.keys(before), 'after snapshot keeps before row format and keys');
  assert.equal(before['experience.mjs'], experienceSha);
  assert.equal(before['compose.mjs'], composeSha);
  assert.equal(before.tip, tipPin);
  assert.equal(after['experience.mjs'], experienceSha);
  assert.equal(after['compose.mjs'], composeSha);
  assert.equal(after.tip, tipPin);
  for (const [name, expected] of [['experience', experienceSha], ['compose', composeSha]]) {
    const product = npd[name];
    assert.equal(product.path, `offloop/${name}.mjs`);
    assert.equal(product.before, expected);
    assert.equal(product.after, expected);
    assert.equal(product.unchanged, true);
    const live = sha256(fs.readFileSync(path.join(root, product.path)));
    assert.equal(live, expected, `${name} live hash`);
    assert.equal(live, before[`${name}.mjs`], `${name} equals session-start hash`);
  }

  const freeze = read(`freeze-offloop-${knife}.md`);
  const title = freeze.split('\n')[0];
  const statusLine = freeze.split('\n').find((line) => line.includes('**状态：')) || '';
  const frozen = title.includes('**FROZEN / 开干**') && statusLine.includes('**状态：FROZEN / 开干');
  const scanClosed = title.includes('CLOSED — PASS（NO_PRODUCT_DELTA）')
    && statusLine.includes('**状态：CLOSED — PASS') && freeze.includes('独立 SCAN');
  assert.ok(frozen || scanClosed, 'freeze stays FROZEN or is independently SCAN CLOSED');
  const lockStart = freeze.indexOf('## 0. 锁定');
  const lockEnd = freeze.indexOf('## 1. 不做');
  assert.ok(lockStart >= 0 && lockEnd > lockStart, '§0 boundaries exist');
  const lock = freeze.slice(lockStart, lockEnd);
  assert.equal(sha256(lock), session.freezeLockSha256, '§0 lock remains byte-identical');
  assert.equal(npd.freezeLockSha256, session.freezeLockSha256);
});

test('T-hceg-2: scoped freezes stay CLOSED, candidates stay promoted, tip stays pinned and no CANDIDATE is promoted', () => {
  for (const closedKnife of [...experienceClosed, ...composeClosed, 'experience-compose-deepen-r1']) {
    const body = read(`freeze-offloop-${closedKnife}.md`);
    const title = body.split('\n')[0];
    const statusLine = body.split('\n').find((line) => line.includes('**状态：')) || '';
    assert.match(title, /\bCLOSED\b/, `${closedKnife} title remains CLOSED`);
    assert.match(statusLine, /\*\*状态：CLOSED\b/, `${closedKnife} status remains CLOSED`);
    assert.doesNotMatch(title, /FROZEN \/ 开干/, `${closedKnife} title not reopened`);
  }

  const candidates = [
    ['post-dpr-sticky-execute', 'freeze-candidate-post-dpr-sticky-execute-r1.md'],
    ['host-note-post-dpr-execute-bias', 'offloop/out-propose-diversity-dedupe-r1/freeze-candidate-host-note-post-dpr-execute-bias-r1.md'],
  ];
  for (const [name, rel] of candidates) {
    const head = read(rel).split('\n').slice(0, 5).join('\n');
    const statusLine = head.split('\n').find((line) => line.includes('**状态：')) || '';
    assert.match(statusLine, /^- \*\*状态：PROMOTED \/ SHIPPED-soft/, `${name} already promoted`);
    assert.match(head, /不作为待冻升格队列/, `${name} excluded from awaiting queue`);
  }

  const pinSource = read('offloop/path-signals.mjs');
  assert.match(pinSource, new RegExp(`export const STEAL_TIP_PIN = '${tipPin}'`));
  const tip = '/workspace/dda-tip-r25';
  if (fs.existsSync(tip)) {
    const head = execFileSync('git', ['-C', tip, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      timeout: 30_000,
    }).trim();
    assert.equal(head, tipPin);
  }

  const npd = readJson(`offloop/out-${knife}/no-product-delta.json`);
  assert.equal(npd.candidates['post-dpr-sticky-execute'], 'PROMOTED / SHIPPED-soft');
  assert.equal(npd.candidates['host-note-post-dpr-execute-bias'], 'PROMOTED / SHIPPED-soft');
  assert.equal(npd.candidates.awaitingPromoteQueue, false);
  assert.equal(npd.candidateWrites, 0);
  assert.equal(npd.candidatePromotions, 0);
  assert.equal(npd.autoCandidatePromote, false);
  assert.deepEqual(fs.readdirSync(out, { recursive: true }).filter((name) => /freeze-candidate-/i.test(name)), []);
  for (const family of ['third', 'fourth']) {
    const record = readJson(`offloop/out-tip-soft-adopt-${family}-family-live-r1/adopt-record.json`);
    assert.equal(record.adopt, true, `${family} family L1 adopted`);
    assert.equal(record.candidateAdopt, false, `${family} family did not adopt candidate`);
    assert.equal(record.candidateCount, 0, `${family} family wrote no CANDIDATE`);
  }
  assert.equal(npd.wave10TipSoftYellows.composeExperienceProductGap, false);
});
