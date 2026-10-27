import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ownKnife = 'post-dtelp-suite-pin-archive-reconcile-r1';
const out = path.join(root, `offloop/out-${ownKnife}`);
const sessionDir = '/tmp/codex-post-dtelp-suite-pin-archive-reconcile-r1';
const ownLockSha256 = '11997122d94246cc1af61f557e9deb768847ff44b3e418b3bef61ba1c78e1ddb';
const sessionSha256 = '4f6fb58de49184b6c133283dc735c4364037ab3a8869e9c8b06ef96f72002897';
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const dayloopSoftNow = '39dbf330b3143335163e6209c0a5d8d32538cfb72ededc40ab979b689e48fef3';
const composeNow = 'e284a70868d3954cfe6ce2461683b9e3edbd3d5305c5754cd2eedcafe7aa4e4b';
const allowedLabels = new Set([
  'POST_DTELP_PRODUCT_PIN',
  'HISTORICAL_PRODUCT_COPY',
  'APPROVED_HASH_REFRESH',
  'PREEXISTING_REPLAY_SNAPSHOT',
  'MATCH',
]);

const readBytes = relative => fs.readFileSync(path.join(root, relative));
const read = relative => readBytes(relative).toString('utf8');
const readJson = relative => JSON.parse(read(relative));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = relative => digest(readBytes(relative));

function parseShaList(bytes) {
  const lines = bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.map(line => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match, `valid sha256 row: ${line}`);
    return { hash: match[1], file: match[2] };
  });
}

function section0Digest(bytes) {
  const start = bytes.indexOf(Buffer.from('\n## 0.')) + 1;
  const end = bytes.indexOf(Buffer.from('\n## 1.'), start) + 1;
  assert.ok(start > 0 && end > start, 'freeze §0 extraction exists');
  return digest(bytes.subarray(start, end));
}

function freezeLifecycleHonest(freeze) {
  const title = freeze.split('\n')[0];
  const status = freeze.match(/^-\s+\*\*状态[：:][^\n]*$/m)?.[0] ?? '';
  return /FROZEN \/ (?:开干|SCAN READY)/.test(title)
    && /FROZEN \/ (?:开干|SCAN READY)/.test(status)
    && !/\bCLOSED\b/.test(`${title}\n${status}`);
}

function benchLifecycleHonest(bench) {
  const status = bench.match(/^- Status:.*$/m)?.[0] ?? '';
  return /FROZEN \/ SCAN READY/.test(status) && !/\bCLOSED\b/.test(status);
}

function probeTipHead(tipDir) {
  try {
    const output = execFileSync('git', ['-C', tipDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      timeout: 30_000,
    });
    return { ok: true, head: output.trim() };
  } catch (error) {
    const message = [error?.message, error?.stderr?.toString()].filter(Boolean).join('\n');
    const environment = ['EPERM', 'ENOENT', 'ENOTDIR', 'EACCES', 'ETIMEDOUT'].includes(error?.code)
      || /not a git repository|spawnSync git EPERM|No such file|not a directory|permission denied|invalid gitfile format/i.test(message);
    if (!environment) throw error;
    return { ok: false, environment: true, code: error?.code ?? 'GIT_UNAVAILABLE', message };
  }
}

function inventoryRows() {
  const inventory = readJson(`offloop/out-${ownKnife}/classification-inventory.json`);
  assert.equal(inventory.knife, ownKnife);
  assert.equal(inventory.tipPin, pin);
  assert.equal(inventory.disposition, 'STOP');
  assert.equal(inventory.productDelta, 0);
  assert.equal(inventory.productWrites, 0);
  assert.equal(inventory.selfClosed, false);
  assert.ok(inventory.generatedAt.includes('2026-10-26T'), 'generatedAt is session date');
  assert.ok(inventory.generatedAt.endsWith('-09:00'), 'generatedAt is America/Adak offset');
  assert.ok(Array.isArray(inventory.rows) && inventory.rows.length >= 30, 'classification rows are durable');
  for (const row of inventory.rows) {
    assert.ok(row.id && row.subject && row.path && row.note, 'row has id/subject/path/note');
    assert.ok(allowedLabels.has(row.classification), `${row.id}: allowed classification`);
  }
  return inventory;
}

test('T-w14-spar-1: classification inventory, external reds, authority MATCH, and one EXTERNAL bench ledger', () => {
  const inventory = inventoryRows();
  const labels = new Set(inventory.rows.map(row => row.classification));
  for (const label of allowedLabels) assert.ok(labels.has(label), `${label}: represented in inventory`);

  const redIds = ['T-tlsc-2', 'T-tgeh-2', 'T-lwsa-2', 'T-lw11a-2'];
  for (const id of redIds) {
    const row = inventory.rows.find(candidate => candidate.id === `external-red-${id}`);
    assert.ok(row, `${id}: inventory row exists`);
    assert.ok(['POST_DTELP_PRODUCT_PIN', 'HISTORICAL_PRODUCT_COPY'].includes(row.classification));
    assert.match(row.note, /EXTERNAL|external/);
  }
  const rawTap = read('offloop/out-lifecycle-wave12-sibling-accept-r1/regression-unfiltered-external.tap');
  assert.match(rawTap, /1\.\.11/);
  assert.match(rawTap, /# pass 7/);
  assert.match(rawTap, /# fail 4/);
  for (const id of redIds) assert.match(rawTap, new RegExp(`not ok \\d+ - ${id}`));
  assert.equal(inventory.unfilteredExternal.score, '7/11');
  assert.deepEqual(inventory.unfilteredExternal.redIds, redIds);

  const authorityRows = parseShaList(readBytes(`offloop/out-${ownKnife}/authority-before-hashes.txt`));
  assert.equal(authorityRows.length, 3, 'three authority rows');
  assert.deepEqual(readBytes(`offloop/out-${ownKnife}/authority-before-hashes.txt`),
    fs.readFileSync(path.join(sessionDir, 'authority-before-hashes.txt')),
    'authority-before-hashes is a verbatim session copy');
  for (const { file, hash } of authorityRows) {
    assert.equal(sha(file), hash, `${file}: authority MATCH`);
    const row = inventory.rows.find(candidate => candidate.path === file);
    assert.ok(row, `${file}: inventory authority row`);
    assert.equal(row.classification, 'MATCH');
    assert.equal(row.historicalSha, hash);
    assert.equal(row.currentSha, hash);
  }

  const bench = read(`bench-log-offloop-${ownKnife}.md`);
  assert.equal((bench.match(/^## EXTERNAL \/ 并行哈希$/gm) || []).length, 1,
    'own bench has exactly one EXTERNAL section');
  assert.match(bench, /\| 文件 \| 历史 \| 现盘 \| 判定 \|/);
  assert.match(bench, /EXTERNAL_DRIFT/);
  assert.match(bench, /T-tlsc-2/);
  assert.match(bench, /T-tgeh-2/);
  assert.match(bench, /T-lwsa-2/);
  assert.match(bench, /T-lw11a-2/);
  assert.match(bench, /authority 3\/3 MATCH/);
  assert.match(bench, /POST_DTELP_PRODUCT_PIN/);
  assert.match(bench, /HISTORICAL_PRODUCT_COPY/);
  assert.match(bench, /APPROVED_HASH_REFRESH/);
  assert.match(bench, /PREEXISTING_REPLAY_SNAPSHOT/);
  assert.match(bench, /pin-refresh.json/);
  assert.ok(inventory.rows.some(row => row.path.endsWith('/pin-refresh.json') && row.classification === 'APPROVED_HASH_REFRESH'));
  assert.match(bench, /NO_PRODUCT_DELTA/);
  assert.match(bench, /EXTERNAL reds.*not|EXTERNAL.*不是|EXTERNAL product-baseline/);
  assert.match(read(`offloop/out-${ownKnife}/classification-summary.md`), /MATCH/);
});

test('T-w14-spar-2: product 0x, PIN, FROZEN handoff, §0 lock, session copies, and peer locks remain honest', t => {
  assert.equal(STEAL_TIP_PIN, pin);
  const beforeBytes = readBytes(`offloop/out-${ownKnife}/before-hashes.txt`);
  assert.deepEqual(beforeBytes, fs.readFileSync(path.join(sessionDir, 'before-hashes.txt')),
    'before-hashes is a verbatim session copy');
  assert.deepEqual(beforeBytes, readBytes(`offloop/out-${ownKnife}/after-hashes.txt`),
    'before/after product lists are byte-identical');
  const productRows = parseShaList(beforeBytes);
  assert.equal(productRows.length, 18, 'all 18 durable product rows are listed');
  assert.equal(new Set(productRows.map(row => row.file)).size, 18, 'product rows are unique');
  for (const { file, hash } of productRows) assert.equal(sha(file), hash, `${file}: NO_PRODUCT_DELTA`);
  assert.equal(sha('offloop/compose.mjs'), composeNow);
  assert.equal(sha('offloop/dayloop-soft.mjs'), dayloopSoftNow);

  const sessionBytes = readBytes(`offloop/out-${ownKnife}/session-start.json`);
  assert.deepEqual(sessionBytes, fs.readFileSync(path.join(sessionDir, 'session-start.json')),
    'session-start is a verbatim session copy');
  assert.equal(digest(sessionBytes), sessionSha256, 'session-start durable digest');
  const session = JSON.parse(sessionBytes.toString('utf8'));
  assert.equal(session.knife, ownKnife);
  assert.equal(session.tipPin, pin);
  assert.equal(session.tipHead, pin);
  assert.equal(session.STEAL_TIP_PIN, pin);
  assert.equal(session.selfClosed, false);
  assert.equal(session.productWrites, 0);
  assert.equal(session.runtimeWrites, 0);
  assert.equal(read(`offloop/out-${ownKnife}/tip-head.txt`), `${pin}\n`);

  const tip = probeTipHead('/workspace/dda-tip-r25');
  if (tip.ok) assert.equal(tip.head, pin, 'readable tip HEAD remains pinned');
  else t.diagnostic(`ENVIRONMENT skip: tip HEAD (${tip.code}) ${tip.message}; session PIN checked`);

  const freeze = read(`freeze-offloop-${ownKnife}.md`);
  assert.equal(freezeLifecycleHonest(freeze), true, 'freeze remains FROZEN and not self-CLOSED');
  assert.match(freeze.split('\n')[0], /FROZEN \/ 开干/);
  assert.match(freeze, /已交卷 \/ 等待独立 SCAN/);
  assert.equal(section0Digest(Buffer.from(freeze)), ownLockSha256, 'freeze §0 lock unchanged');
  const status = freeze.match(/^-\s+\*\*状态[：:]\s*([^*]+)\*\*/m)?.[1] ?? '';
  assert.match(status, /^FROZEN \/ 开干/);
  assert.doesNotMatch(freeze.split('\n')[0] + status, /\bCLOSED\b/);

  const bench = read(`bench-log-offloop-${ownKnife}.md`);
  assert.equal(benchLifecycleHonest(bench), true, 'bench remains FROZEN / SCAN READY');
  assert.match(bench, /selfClosed=false/);
  assert.doesNotMatch(bench, /selfClosed\s*=\s*true/);
  for (const line of bench.split(/\r?\n/).filter(line => /空\s*tip.*双绿/.test(line))) {
    assert.match(line, /未执行|不可|禁止|不得/);
  }

  const peerBefore = readJson(`offloop/out-${ownKnife}/peer-lock-before.json`);
  const peerAfter = readJson(`offloop/out-${ownKnife}/peer-lock-after.json`);
  for (const [knife, expected] of Object.entries(peerBefore)) {
    const peerFreeze = read(`freeze-offloop-${knife}.md`);
    const peerSection = section0Digest(Buffer.from(peerFreeze));
    const peerFull = digest(Buffer.from(peerFreeze));
    assert.equal(peerSection, expected.section0Sha256, `${knife}: peer §0 lock unchanged`);
    assert.equal(peerFull, expected.fullSha256, `${knife}: peer freeze unchanged`);
    assert.match(peerFreeze, /CLOSED — PASS/);
    assert.equal(peerAfter[knife]?.section0Sha256, expected.section0Sha256, `${knife}: after §0 expected`);
    assert.equal(peerAfter[knife]?.fullSha256, expected.fullSha256, `${knife}: after full expected`);
    assert.equal(peerAfter[knife]?.observedSection0Sha256, expected.section0Sha256, `${knife}: after observed §0`);
    assert.equal(peerAfter[knife]?.observedFullSha256, expected.fullSha256, `${knife}: after observed full`);
    assert.equal(peerAfter[knife]?.unchanged, true, `${knife}: after ledger unchanged`);
  }
  assert.ok(Object.hasOwn(peerBefore, 'wave12-closeout-cleanup-r1'));
  assert.ok(Object.hasOwn(peerBefore, 'post-dtelp-product-pin-hygiene-r1'));

  const inventory = readJson(`offloop/out-${ownKnife}/classification-inventory.json`);
  assert.equal(inventory.disposition, 'STOP');
  assert.equal(inventory.productDelta, 0);
  assert.equal(inventory.productWrites, 0);
  assert.ok(inventory.rows.some(row => row.classification === 'PREEXISTING_REPLAY_SNAPSHOT'));
  t.diagnostic('18/18 product rows MATCH; PIN and FROZEN handoff stable; §0 and CLOSED peer locks unchanged');
});
