import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { probeTipHead } from './test-git-eperm-env-harden-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const offloop = path.join(root, 'offloop');
const out = path.join(offloop, 'out-tip-soft-integrity-scan-closed-accept-r1');
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const freezeLockSha256 = 'eebad11445b8e5d55e29c0d0cf2917946b58a452d39a552c94d85dc1eb80a30c';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Tip-soft's broader integrity contract: Codex may hand off FROZEN, while an
 * independent SCAN may close any PASS variant (adopt, transport, delta, stop,
 * or experience-only).  A bare self-CLOSED record is never sufficient.
 */
export function tipSoftFreezeIntegrityHonest(freezeText) {
  const title = freezeText.split('\n')[0] || '';
  const titleStates = [...title.matchAll(/\*\*([^*]+)\*\*/g)]
    .map(match => match[1])
    .filter(value => /\b(?:FROZEN|CLOSED)\b/.test(value));
  const titleState = titleStates[titleStates.length - 1] || title;
  const statusLine = freezeText.split('\n').find(line => /^- \*\*状态[：:]/.test(line)) || '';
  const frozenHonesty = /\bFROZEN\b/.test(titleState)
    && !/\bCLOSED\b/.test(titleState)
    && /\*\*状态[：:]\s*FROZEN\b/.test(statusLine);
  const scanClosed = /CLOSED — PASS/.test(titleState)
    && /\*\*状态[：:]\s*CLOSED — PASS\b/.test(statusLine)
    && (/独立 SCAN/.test(freezeText) || /SCAN\s*·/.test(statusLine));
  return frozenHonesty || scanClosed;
}

export const tipSoftIntegrityAccepts = tipSoftFreezeIntegrityHonest;

const freezeSample = (title, status, note = '') => `# Freeze: **${title}**\n\n- **状态：${status}**\n${note}\n`;
const liveFreezeFiles = [
  'freeze-offloop-tip-soft-adopt-fifth-family-live-r1.md',
  'freeze-offloop-tip-soft-adopt-fourth-family-live-r1.md',
  'freeze-offloop-tip-soft-adopt-third-family-live-r1.md',
  'freeze-offloop-tip-soft-adopt-t4-retry-live-r1.md',
];
const integrityFiles = [
  'offloop/out-tip-soft-adopt-fifth-family-live-r1/integrity.mjs',
  'offloop/out-tip-soft-adopt-fourth-family-live-r1/integrity.mjs',
  'offloop/out-tip-soft-adopt-third-family-live-r1/integrity.mjs',
  'offloop/out-tip-soft-adopt-t4-retry-live-r1/integrity.mjs',
];

// Register once in a shared-process run, or only at this entry point with file isolation.
if (process.execArgv.includes('--test-isolation=none')
    || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  test('T-tisc-1: tip-soft integrity accepts FROZEN or independent SCAN CLOSED and rejects bare self-CLOSED', () => {
    for (const relative of liveFreezeFiles) {
      const freeze = read(relative);
      assert.equal(tipSoftFreezeIntegrityHonest(freeze), true, `${relative}: live SCAN close accepted`);
    }

    assert.equal(tipSoftFreezeIntegrityHonest(freezeSample('FROZEN / 开干', 'FROZEN / 开干')), true);
    assert.equal(tipSoftFreezeIntegrityHonest(freezeSample('FROZEN / 开干', 'FROZEN / SCAN READY')), true);

    for (const variant of [
      '（adopt=true · EXPERIENCE-only）',
      '（TRANSPORT）',
      '（NO_PRODUCT_DELTA）',
      '（PRODUCT_DELTA）',
      '（STOP）',
    ]) {
      const title = `CLOSED — PASS${variant}`;
      assert.equal(
        tipSoftFreezeIntegrityHonest(freezeSample(title, 'CLOSED — PASS（SCAN · wave13）')),
        true,
        `${title}: status SCAN marker accepted`,
      );
      assert.equal(
        tipSoftFreezeIntegrityHonest(freezeSample(title, 'CLOSED — PASS · SCAN · wave13')),
        true,
        `${title}: unparenthesized status SCAN marker accepted`,
      );
      assert.equal(
        tipSoftFreezeIntegrityHonest(freezeSample(title, 'CLOSED — PASS', '独立 SCAN')),
        true,
        `${title}: body SCAN evidence accepted`,
      );
      assert.equal(
        tipSoftFreezeIntegrityHonest(freezeSample(title, 'CLOSED — PASS')),
        false,
        `${title}: PASS without SCAN rejected`,
      );
    }

    for (const state of ['CLOSED', 'CLOSED — FAIL（NO_PRODUCT_DELTA）', 'CLOSED — PASS']) {
      assert.equal(tipSoftFreezeIntegrityHonest(freezeSample(state, state)), false, `${state}: self-CLOSED rejected`);
    }
    assert.equal(
      tipSoftFreezeIntegrityHonest(freezeSample('CLOSED', 'CLOSED', '独立 SCAN')),
      false,
      'SCAN cannot rescue bare CLOSED',
    );
    assert.equal(
      tipSoftFreezeIntegrityHonest(freezeSample('CLOSED — FAIL（NO_PRODUCT_DELTA）', 'CLOSED — FAIL（NO_PRODUCT_DELTA）', '独立 SCAN')),
      false,
      'SCAN cannot rescue CLOSED — FAIL',
    );

    for (const relative of integrityFiles) {
      const source = read(relative);
      assert.match(source, /frozenHonesty\s*\|\|\s*scanClosed/,
        `${relative}: explicit FROZEN-or-SCAN gate remains visible`);
      const frozenBlock = source.slice(source.indexOf('const frozenHonesty'), source.indexOf('const scanClosed'));
      assert.doesNotMatch(frozenBlock, /sha\(before\.freeze\.path\)\s*===\s*before\.freeze\.sha256/,
        `${relative}: whole-freeze SHA is not the sole acceptance gate`);
    }
  });

  test('T-tisc-2: PIN, product hashes, freeze lock, zero writes, and knife5 PRODUCT_DELTA evidence stay fixed', (t) => {
    assert.equal(STEAL_TIP_PIN, tipPin);
    const sessionPath = path.join(out, 'session-start.json');
    const session = readJson(sessionPath);
    assert.equal(
      fs.readFileSync(sessionPath, 'utf8'),
      fs.readFileSync('/tmp/codex-tip-soft-integrity-scan-closed-accept-r1/session-start.json', 'utf8'),
      'session-start.json is copied verbatim',
    );
    assert.equal(session.knife, 'tip-soft-integrity-scan-closed-accept-r1');
    assert.equal(session.STEAL_TIP_PIN, tipPin);
    assert.equal(session.tipHead, tipPin);
    assert.equal(session.productWrites, 0);
    assert.equal(session.runtimeWrites, 0);
    assert.equal(session.selfClosed, false);
    assert.equal(session.freezeLockSha256, freezeLockSha256);

    assert.equal(fs.readFileSync(path.join(out, 'tip-head.txt'), 'utf8').trim(), tipPin);
    const tipHead = probeTipHead('/workspace/dda-tip-r25');
    if (tipHead.ok) assert.equal(tipHead.head, tipPin, 'readable tip HEAD remains pinned');
    else t.diagnostic(`ENVIRONMENT skip: tip git HEAD (${tipHead.code}): ${tipHead.message}; STEAL_TIP_PIN checked`);

    const beforeText = fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8');
    const afterText = fs.readFileSync(path.join(out, 'after-hashes.txt'), 'utf8');
    assert.equal(
      beforeText,
      fs.readFileSync('/tmp/codex-tip-soft-integrity-scan-closed-accept-r1/before-hashes.txt', 'utf8'),
      'before-hashes.txt is copied verbatim',
    );
    assert.equal(afterText, beforeText, 'after-hashes is byte-identical to before-hashes');
    const rows = beforeText.trim().split(/\r?\n/).map(line => {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
      assert.ok(match, `valid product hash row: ${line}`);
      return [match[2], match[1]];
    });
    const expectedProducts = rows.filter(([file]) => /^offloop\/[^/]+\.mjs$/.test(file)).map(([file]) => file).sort();
    const actualProducts = fs.readdirSync(offloop).filter(name => name.endsWith('.mjs'))
      .map(name => `offloop/${name}`).sort();
    assert.deepEqual(expectedProducts, actualProducts, 'baseline covers every offloop/*.mjs product');
    for (const [file, expected] of rows) {
      assert.equal(sha256(fs.readFileSync(path.join(root, file))), expected, `${file}: unchanged`);
    }

    const freeze = read('freeze-offloop-tip-soft-integrity-scan-closed-accept-r1.md');
    assert.equal(tipSoftFreezeIntegrityHonest(freeze), true, 'this knife remains FROZEN-honest');
    const i = freeze.indexOf('## 0. 锁定');
    const j = freeze.indexOf('## 1. 不做');
    assert.ok(i >= 0 && j > i, '§0 lock boundaries exist');
    assert.equal(sha256(freeze.slice(i, j)), freezeLockSha256, '§0 lock remains byte-identical');

    const summary = readJson(path.join(out, 'summary.json'));
    assert.equal(summary.knife, 'tip-soft-integrity-scan-closed-accept-r1');
    assert.equal(summary.wave, 'wave13');
    assert.equal(summary.pack, 'A');
    assert.equal(summary.knifeNumber, 4);
    assert.equal(summary.tipPin, tipPin);
    assert.equal(summary.STEAL_TIP_PIN, tipPin);
    assert.equal(summary.productWrites, 0);
    assert.equal(summary.runtimeWrites, 0);
    assert.equal(summary.freezeStatus, 'FROZEN / SCAN READY');
    assert.equal(summary.selfClosed, false);
    assert.equal(summary.productHashesUnchanged, true);
    assert.equal(summary.freezeLockSha256, freezeLockSha256);
    assert.equal(summary.emptyTipDualGreen, false);
    assert.equal(summary.tipDualGreen, false);
    assert.equal(summary.tipDualGreenRuns, 0);
    assert.equal(summary.noEmptyTipDualGreen, true);
    assert.deepEqual(summary.tests, { 'T-tisc-1': 'PASS', 'T-tisc-2': 'PASS' });

    const fifthIntegrity = read('offloop/out-tip-soft-adopt-fifth-family-live-r1/integrity.mjs');
    assert.match(fifthIntegrity, /dtelp\.liveWritePathProven/);
    assert.match(fifthIntegrity, /PRODUCT_DELTA/);
  });
}
