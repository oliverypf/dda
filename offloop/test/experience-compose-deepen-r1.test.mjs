import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'offloop/out-experience-compose-deepen-r1');
const experienceSha = '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb';
const composeSha = 'd00f0ef03eb4c30cef9097534db52ee5b3e59acd355d7a204ce83a6beac76e8f';
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

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

test('T-ecd-1: no-product-delta.json records 勾选但无差分 and experience/compose hashes unchanged', () => {
  const npd = JSON.parse(fs.readFileSync(path.join(out, 'no-product-delta.json'), 'utf8'));
  assert.equal(npd.knife, 'experience-compose-deepen-r1');
  assert.equal(npd.productDelta, 'NO_PRODUCT_DELTA');
  assert.equal(npd.conclusion, '勾选但无差分');
  assert.equal(npd.productWrites, 0);
  assert.equal(npd.splitSecondFreeze, false);
  assert.equal(npd.tipPin, tipPin);
  assert.equal(npd.experience.before, experienceSha);
  assert.equal(npd.experience.after, experienceSha);
  assert.equal(npd.experience.unchanged, true);
  assert.equal(npd.compose.before, composeSha);
  assert.equal(npd.compose.after, composeSha);
  assert.equal(npd.compose.unchanged, true);
  assert.deepEqual(npd.closedKnivesScanned.experience, experienceClosed);
  assert.deepEqual(npd.closedKnivesScanned.compose, composeClosed);
  assert.equal(npd.gapsFound.length, 0);

  const beforeText = fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8');
  const before = Object.fromEntries(
    beforeText.trim().split(/\r?\n/).map((line) => {
      const [file, hash] = line.trim().split(/\s+/);
      return [file, hash];
    }),
  );
  assert.equal(before['experience.mjs'], experienceSha);
  assert.equal(before['compose.mjs'], composeSha);
  assert.equal(before.tip, tipPin);

  assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop/experience.mjs'))), experienceSha);
  assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop/compose.mjs'))), composeSha);
  assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop/experience.mjs'))), before['experience.mjs']);
  assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop/compose.mjs'))), before['compose.mjs']);

  const freeze = read('freeze-offloop-experience-compose-deepen-r1.md');
  // Codex must not self-CLOSE; independent SCAN may flip to CLOSED — PASS（NO_PRODUCT_DELTA）.
  const title = freeze.split('\n')[0];
  const statusLine = freeze.split('\n').find((line) => line.includes('**状态：')) || '';
  const frozenHonesty = /\*\*FROZEN \/ 开干\*\*/.test(freeze) && !/CLOSED/.test(title);
  const scanClosed = /CLOSED — PASS（NO_PRODUCT_DELTA）/.test(title)
    && /\*\*状态：CLOSED — PASS/.test(statusLine)
    && /独立 SCAN/.test(freeze);
  assert.ok(frozenHonesty || scanClosed, 'freeze must be FROZEN (Codex honesty) or SCAN CLOSED — PASS（NO_PRODUCT_DELTA）');
  assert.ok(freeze.includes('勾选但无差分'));
  const snapshot = JSON.parse(fs.readFileSync(path.join(out, 'session-start.json'), 'utf8'));
  const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
  assert.equal(sha256(lock), snapshot.freezeLockSha256, '§0 lock remains byte-identical (freeze not self-CLOSED)');
});

test('T-ecd-2: wave7 EXPERIENCE/Compose freezes stay CLOSED; candidates not awaiting promote; STEAL_TIP_PIN pinned', (t) => {
  for (const knife of [...experienceClosed, ...composeClosed]) {
    const body = read(`freeze-offloop-${knife}.md`);
    assert.match(body, /CLOSED/, `${knife} freeze must remain CLOSED`);
    assert.doesNotMatch(body.split('\n')[0], /FROZEN \/ 开干/, `${knife} must not reopen`);
  }

  const stickyCand = read('freeze-candidate-post-dpr-sticky-execute-r1.md');
  const hostCand = read('offloop/out-propose-diversity-dedupe-r1/freeze-candidate-host-note-post-dpr-execute-bias-r1.md');
  for (const [name, body] of [
    ['sticky', stickyCand],
    ['host-note', hostCand],
  ]) {
    const head = body.split('\n').slice(0, 5).join('\n');
    const statusLine = head.split('\n').find((line) => line.includes('**状态：')) || '';
    assert.match(statusLine, /\*\*状态：PROMOTED \/ SHIPPED-soft/, `${name} status bar must be PROMOTED/SHIPPED-soft`);
    assert.match(head, /不作为待冻升格队列/, `${name} must deny awaiting-promote queue`);
    // Status value itself must not be the awaiting-promote label (denial phrase may still mention 待冻升格).
    const statusValue = (statusLine.match(/\*\*状态：([^*]+)/) || [])[1] || '';
    assert.ok(statusValue.startsWith('PROMOTED / SHIPPED-soft'), `${name} status value=${statusValue}`);
    assert.equal(statusValue.includes('待冻升格队列') && !statusValue.includes('不作为'), false,
      `${name} status value must not be awaiting-promote`);
  }

  const pinSrc = read('offloop/path-signals.mjs');
  assert.match(pinSrc, new RegExp(`export const STEAL_TIP_PIN = '${tipPin}'`));
  assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop/path-signals.mjs'))).length, 64);

  const tip = '/workspace/dda-tip-r25';
  if (fs.existsSync(tip)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-ecd-tip-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const output = path.join(tmp, 'tip-head.txt');
    const fd = fs.openSync(output, 'w');
    try {
      execFileSync('git', ['-C', tip, 'rev-parse', 'HEAD'], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', fd, fd],
        timeout: 30_000,
      });
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(fs.readFileSync(output, 'utf8').trim(), tipPin);
  }

  const npd = JSON.parse(fs.readFileSync(path.join(out, 'no-product-delta.json'), 'utf8'));
  assert.equal(npd.candidates.awaitingPromoteQueue, false);
  assert.equal(npd.candidates['post-dpr-sticky-execute'], 'PROMOTED / SHIPPED-soft');
  assert.equal(npd.candidates['host-note-post-dpr-execute-bias'], 'PROMOTED / SHIPPED-soft');
});
