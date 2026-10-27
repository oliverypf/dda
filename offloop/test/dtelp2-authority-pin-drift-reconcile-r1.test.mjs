import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { freezeLifecycleHonest, benchLifecycleHonest } from './test-lifecycle-scan-closed-accept-r1.test.mjs';
import { probeTipHead } from './test-git-eperm-env-harden-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'offloop/out-dtelp2-authority-pin-drift-reconcile-r1');
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const expectedHistorical = '19660cbd1be3942fb507fcaf2c30de6b00d3e71971a652cc9be7a23d5901e240';
const currentDisk = '42923766bd629d853c0b13f5368570ed209c3d7a67a3ee9f8264b30d30dfef4a';
const freezeLockSha256 = '15431f94409376af8c7daaaabafade2108f152f41c7985cf7f223f2cfa0ba076';
const driftedBench = 'bench-log-offloop-tip-soft-adopt-fifth-family-live-r1.md';
const authorityPath = 'offloop/out-tip-soft-adopt-fifth-family-live-r1/dtelp-suite-overlay/authority-before.json';
const transportPath = 'offloop/out-tip-soft-adopt-fifth-family-live-r1/transport-record.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = relative => JSON.parse(read(relative));
const digest = relative => sha256(fs.readFileSync(path.join(root, relative)));

function parseHashRows(text) {
  const rows = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
    assert.ok(match, 'invalid hash row: ' + line);
    assert.equal(rows.has(match[2]), false, 'duplicate hash row: ' + match[2]);
    rows.set(match[2], match[1]);
  }
  return rows;
}

const closedVerdict = 'CLOSED — PASS（STOP / EXTERNAL_DRIFT / NO_PRODUCT_DELTA）';
const independentCloseoutEvidence = body => /Codex 检验/.test(body)
  && /独立 SCAN/.test(body)
  && /2026-10-26 \(America\/Adak\)/.test(body)
  && /selfClosed=false/.test(body);
const closedFreezeHonest = freeze => {
  const title = freeze.split('\n')[0].match(/\*\*([^*]+)\*\*\s*$/)?.[1] ?? '';
  const status = freeze.match(/^-\s+\*\*状态[：:]\s*([^*]+)\*\*/m)?.[1] ?? '';
  return title === closedVerdict && status === closedVerdict && independentCloseoutEvidence(freeze);
};
const closedBenchHonest = bench => {
  const status = bench.match(/^- Status:\s+\*\*([^*]+)\*\*/m)?.[1] ?? '';
  return status === closedVerdict && independentCloseoutEvidence(bench);
};

test('T-w14-dtelp-1: historical authority and current disk pins remain separately visible; STOP is auditable', () => {
  const authority = readJson(authorityPath);
  assert.equal(authority[driftedBench], expectedHistorical);
  assert.equal(digest(driftedBench), currentDisk);
  assert.notEqual(expectedHistorical, currentDisk);

  const snapshot = readJson('offloop/out-dtelp2-authority-pin-drift-reconcile-r1/authority-snapshot.json');
  assert.equal(snapshot.authorityBefore.path, authorityPath);
  assert.equal(snapshot.authorityBefore.sha256, digest(authorityPath));
  assert.equal(snapshot.authorityBefore.sha256, '462ca12c1021d1c8088625e8c41a1c43fd49b744c8c25ee3ec92d95bbe3c33c6');
  assert.equal(snapshot.authorityBefore.expectedHistoricalSha256, expectedHistorical);
  assert.equal(snapshot.authorityBefore.currentDiskSha256, currentDisk);
  assert.equal(snapshot.transportRecord.path, transportPath);
  assert.equal(snapshot.transportRecord.sha256, digest(transportPath));
  assert.equal(snapshot.transportRecord.sha256, '10818dca46ad948efc7b39cbe2d4849369d7d1f82f21d346d1a88b011ade955d');
  assert.equal(snapshot.authorityBytesChanged, false);
  assert.equal(snapshot.transportRecordBytesChanged, false);

  const bench = read('bench-log-offloop-dtelp2-authority-pin-drift-reconcile-r1.md');
  assert.equal((bench.match(/^## EXTERNAL \/ 并行哈希$/gm) || []).length, 1);
  assert.match(bench, /\| 文件 \| 历史 \| 现盘 \| 判定 \|/);
  const row = '| ' + driftedBench + ' | ' + expectedHistorical + ' | ' + currentDisk + ' | EXTERNAL_DRIFT |';
  assert.ok(bench.includes(row), 'EXTERNAL table must show historical and current pins');
  assert.match(bench, new RegExp(expectedHistorical));
  assert.match(bench, new RegExp(currentDisk));

  const summary = readJson('offloop/out-dtelp2-authority-pin-drift-reconcile-r1/summary.json');
  assert.equal(summary.verdict, 'STOP / EXTERNAL_DRIFT');
  assert.equal(summary.classification, 'EXTERNAL_DRIFT');
  assert.equal(summary.stop, true);
  assert.equal(summary.product_delta, 0);
  assert.equal(summary.freshUpstreamAuthorityEvidence, false);
});

test('T-w14-dtelp-2: PIN, all session hashes, honest FROZEN handoff or independent CLOSED scan, §0 lock, and no-promotion boundaries hold', t => {
  assert.equal(STEAL_TIP_PIN, pin);

  const session = readJson('offloop/out-dtelp2-authority-pin-drift-reconcile-r1/session-start.json');
  assert.equal(session.knife, 'dtelp2-authority-pin-drift-reconcile-r1');
  assert.equal(session.selfClosed, false);
  assert.equal(session.tipPin, pin);
  assert.equal(session.STEAL_TIP_PIN, pin);
  assert.equal(session.tipHead, pin);
  assert.equal(session.productWrites, 0);
  assert.equal(session.runtimeWrites, 0);
  assert.equal(read('offloop/out-dtelp2-authority-pin-drift-reconcile-r1/session-start.json'),
    fs.readFileSync('/tmp/codex-dtelp2-authority-pin-drift-reconcile-r1/session-start.json', 'utf8'),
    'session-start.json is copied verbatim');
  assert.equal(read('offloop/out-dtelp2-authority-pin-drift-reconcile-r1/before-hashes.txt'),
    fs.readFileSync('/tmp/codex-dtelp2-authority-pin-drift-reconcile-r1/before-hashes.txt', 'utf8'),
    'before-hashes.txt is copied verbatim');

  const beforeText = read('offloop/out-dtelp2-authority-pin-drift-reconcile-r1/before-hashes.txt');
  const afterText = read('offloop/out-dtelp2-authority-pin-drift-reconcile-r1/after-hashes.txt');
  assert.equal(afterText, beforeText, 'before and after hashes are byte-identical');
  const rows = parseHashRows(beforeText);
  assert.equal(rows.size, 18, 'the supplied session has 18 immutable rows');
  for (const [relative, expected] of rows) {
    assert.equal(digest(relative), expected, relative + ': unchanged from session start');
  }
  const productRows = [...rows].filter(([relative]) => relative.startsWith('offloop/') && relative.endsWith('.mjs'));
  assert.equal(productRows.length, fs.readdirSync(path.join(root, 'offloop')).filter(name => name.endsWith('.mjs')).length);
  for (const [relative, expected] of productRows) assert.equal(digest(relative), expected, relative + ': product 0×');

  const tipHead = probeTipHead('/workspace/dda-tip-r25');
  if (tipHead.ok) assert.equal(tipHead.head, pin, 'tip HEAD remains pinned');
  else t.diagnostic('ENVIRONMENT skip: tip HEAD (' + tipHead.code + '): ' + tipHead.message);

  const freeze = read('freeze-offloop-dtelp2-authority-pin-drift-reconcile-r1.md');
  assert.equal(freezeLifecycleHonest(freeze) || closedFreezeHonest(freeze), true);
  const title = freeze.split('\n')[0];
  const statusLine = freeze.match(/^-\s+\*\*状态[：:].*$/m)?.[0] ?? '';
  const frozenHandoff = /\*\*FROZEN \/ SCAN READY\*\*$/.test(title)
    && /\*\*状态：FROZEN \/ SCAN READY(?:[（(]|\*\*)/.test(statusLine)
    && !/\bCLOSED\b/.test(title + '\n' + statusLine);
  assert.ok(frozenHandoff || closedFreezeHonest(freeze),
    'freeze must remain FROZEN / SCAN READY or carry independent CLOSED closeout evidence');
  const lockStart = freeze.indexOf('## 0. 锁定\n');
  const lockEnd = freeze.indexOf('## 1. 不做');
  assert.ok(lockStart >= 0 && lockEnd > lockStart, 'freeze §0 boundaries exist');
  assert.equal(sha256(freeze.slice(lockStart, lockEnd)), freezeLockSha256);
  assert.equal(session.freezeLockSha256, freezeLockSha256);

  const bench = read('bench-log-offloop-dtelp2-authority-pin-drift-reconcile-r1.md');
  assert.equal(benchLifecycleHonest(bench) || closedBenchHonest(bench), true);
  const benchStatuses = [...bench.matchAll(/^- Status: \*\*([^*\n]+)\*\*/gm)];
  assert.equal(benchStatuses.length, 1);
  assert.ok(['FROZEN / SCAN READY', closedVerdict].includes(benchStatuses[0][1]));
  assert.match(bench, /selfClosed=false/);
  assert.doesNotMatch(bench, /selfClosed\s*=\s*true/);

  const summary = readJson('offloop/out-dtelp2-authority-pin-drift-reconcile-r1/summary.json');
  assert.equal(summary.tip, pin);
  assert.equal(summary.product_delta, 0);
  assert.equal(summary.productWrites, 0);
  assert.equal(summary.runtimeWrites, 0);
  assert.equal(summary.selfClosed, false);
  assert.equal(summary.candidatePromote, false);
  assert.equal(summary.emptyTipDualGreen, false);
  assert.equal(summary.noEmptyTipDualGreenPassClaim, true);
  assert.equal(summary.tests['T-w14-dtelp-1'], 'PASS');
  assert.equal(summary.tests['T-w14-dtelp-2'], 'PASS');
  assert.match(bench, /禁升 CANDIDATE|no CANDIDATE promotion/i);
  assert.match(bench, /empty-tip dual-green|空 tip 双绿/i);
  assert.match(bench, /no empty-tip dual-green pass claim|未执行|not claimed|not a pass claim/i);
});
