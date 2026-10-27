import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { probeTipHead } from './test-git-eperm-env-harden-r1.test.mjs';
import {
  freezeLifecycleHonest as baseFreezeLifecycleHonest,
  benchLifecycleHonest as baseBenchLifecycleHonest,
} from './test-lifecycle-scan-closed-accept-r1.test.mjs';
import {
  freezeLifecycleHonest as wave10FreezeLifecycleHonest,
  benchLifecycleHonest as wave10BenchLifecycleHonest,
} from './lifecycle-wave10-sibling-accept-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'lifecycle-wave12-sibling-accept-r1';
const out = path.join(root, `offloop/out-${knife}`);
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const lockHash = 'c143a9040eedb67e0f99622df632f282df4ad3aa2ede2f1c3ca29f23850f5234';
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = name => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The wave12 sibling titles include PRODUCT_DELTA and adopt=true variants. The
// status line is authoritative; extracting the lifecycle badge from H1 also
// has to survive an earlier bold subject label and a trailing @ PIN.
function lifecycleBadge(freeze) {
  const heading = freeze.match(/^# .+$/m)?.[0] ?? '';
  const matches = [...heading.matchAll(/(?:FROZEN\s*\/\s*[^*@\n]+|CLOSED\s+—\s+PASS[^*@\n]*)/g)];
  return matches.at(-1)?.[0]?.trim().replace(/[。.]+$/, '') ?? '';
}

function freezeStatus(freeze) {
  const line = freeze.match(/^-\s+\*\*状态[：:].*$/m)?.[0] ?? '';
  return {
    line,
    value: line.match(/\*\*状态[：:]\s*([^*\n]+)\*\*/)?.[1]?.trim() ?? '',
  };
}

function independentScan(body, statusLine) {
  return /独立 SCAN/.test(body)
    || /[（(·]\s*SCAN(?:\s*·|[\s）)])/.test(statusLine);
}

function wave12ClosedBadge(badge) {
  return /^CLOSED\s+—\s+PASS/.test(badge)
    && (/(?:^|[（(·\s])PRODUCT_DELTA(?:$|[）)·\s])/.test(badge)
      || /adopt\s*=\s*true/i.test(badge)
      || /(?:^|[（(·\s])TRANSPORT(?:$|[）)·\s])/.test(badge));
}

// Reuse the established NO_PRODUCT_DELTA/FROZEN contract, then add only the
// independent-SCAN-owned wave12 title variants.
export function freezeLifecycleHonest(freeze) {
  if (baseFreezeLifecycleHonest(freeze) || wave10FreezeLifecycleHonest(freeze)) return true;
  const badge = lifecycleBadge(freeze);
  const { line: statusLine, value: status } = freezeStatus(freeze);
  const titleClosed = wave12ClosedBadge(badge);
  const statusClosed = /^CLOSED\s+—\s+PASS\b/.test(status);
  return titleClosed && statusClosed && independentScan(freeze, statusLine);
}

export function benchLifecycleHonest(bench) {
  if (baseBenchLifecycleHonest(bench) || wave10BenchLifecycleHonest(bench)) return true;
  const statusLine = bench.match(/^- Status(?:\s*[（(][^）)\n]+[）)])?\s*[：:].*$/m)?.[0] ?? '';
  const status = statusLine.match(/^- Status(?:\s*[（(][^）)\n]+[）)])?\s*[：:]\s*\*\*([^*\n]+)\*\*/)?.[1]?.trim() ?? '';
  const wave12Variant = /^CLOSED\s+—\s+PASS\b/.test(status)
    && (/(?:^|[（(·\s])PRODUCT_DELTA(?:$|[）)·\s])/.test(status)
      || /adopt\s*=\s*true/i.test(status)
      || /(?:^|[（(·\s])TRANSPORT(?:$|[）)·\s])/.test(status));
  return wave12Variant && independentScan(bench, statusLine);
}

// Register once in a shared-process run, or only at this entry point with file isolation.
if (process.execArgv.includes('--test-isolation=none')
    || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  test('T-lw12a-1: six live wave12 sibling SCAN closures pass; FROZEN honesty and negative controls remain strict', () => {
    const sampleFreeze = (title, status, note = '') =>
      `# Freeze: **${title}**\n\n- **状态：${status}**\n${note}\n`;
    const sampleBench = (status, note = '') => `# Bench\n\n- Status: **${status}**${note}\n`;
    const siblings = [
      ['lifecycle-wave11-sibling-accept-r1', 'NO_PRODUCT_DELTA'],
      ['tip-soft-prior-snapshot-refresh-r1', 'NO_PRODUCT_DELTA'],
      ['wave11-closeout-cleanup-r1', 'NO_PRODUCT_DELTA'],
      ['dtsal-write-scope-replay-harden-r1', 'NO_PRODUCT_DELTA'],
      ['dayloop-transport-experience-live-persist-r1', 'PRODUCT_DELTA'],
      ['tip-soft-adopt-fifth-family-live-r1', 'adopt=true'],
    ];
    for (const [sample, marker] of siblings) {
      const freeze = read(`freeze-offloop-${sample}.md`);
      assert.match(freeze.split('\n')[0], /CLOSED — PASS/, `${sample}: live CLOSED sample`);
      assert.equal(freezeLifecycleHonest(freeze), true,
        `${sample}: independent SCAN ${marker} closure is accepted`);
    }
    for (const sample of [
      'dayloop-transport-experience-live-persist-r1',
      'tip-soft-adopt-fifth-family-live-r1',
    ]) {
      assert.equal(benchLifecycleHonest(read(`bench-log-offloop-${sample}.md`)), true,
        `${sample}: live bench variant is accepted`);
    }

    for (const frozen of ['FROZEN / 开干', 'FROZEN / SCAN READY']) {
      assert.equal(freezeLifecycleHonest(sampleFreeze(frozen, frozen)), true,
        `${frozen}: honest handoff`);
      assert.equal(benchLifecycleHonest(sampleBench(frozen)), frozen === 'FROZEN / SCAN READY',
        'bench only has the SCAN READY handoff form');
    }

    for (const [title, status] of [
      ['CLOSED — PASS（NO_PRODUCT_DELTA）', 'CLOSED — PASS（SCAN · wave13）'],
      ['CLOSED — PASS（NO_PRODUCT_DELTA / STOP）', 'CLOSED — PASS（SCAN · wave13）'],
      ['CLOSED — PASS · NO_PRODUCT_DELTA', 'CLOSED — PASS（SCAN · wave13）'],
      ['CLOSED — PASS（PRODUCT_DELTA）', 'CLOSED — PASS（SCAN · wave13）'],
      ['CLOSED — PASS · PRODUCT_DELTA', 'CLOSED — PASS（SCAN · wave13）'],
      ['CLOSED — PASS（TRANSPORT）', 'CLOSED — PASS（SCAN · wave13）'],
      ['CLOSED — PASS（adopt=true · EXPERIENCE-only）', 'CLOSED — PASS（SCAN · wave13）'],
    ]) {
      assert.equal(freezeLifecycleHonest(sampleFreeze(title, status)), true,
        `${title}: status SCAN marker accepts independent closure`);
      assert.equal(freezeLifecycleHonest(sampleFreeze(title, 'CLOSED — PASS', '独立 SCAN')), true,
        `${title}: independent SCAN note accepts closure`);
      assert.equal(benchLifecycleHonest(sampleBench(title, '（独立 SCAN）')), true,
        `${title}: bench independent closure`);
    }

    for (const [title, status] of [
      ['CLOSED', 'CLOSED'],
      ['CLOSED — FAIL（NO_PRODUCT_DELTA）', 'CLOSED — FAIL（SCAN · wave13）'],
      ['CLOSED — PASS', 'CLOSED — PASS'],
      ['CLOSED — PASS（PRODUCT_DELTA）', 'CLOSED — FAIL（SCAN · wave13）'],
      ['CLOSED — PASS（adopt=true · EXPERIENCE-only）', 'CLOSED — FAIL'],
    ]) {
      assert.equal(freezeLifecycleHonest(sampleFreeze(title, status, '独立 SCAN')), false,
        `${title}/${status}: self-CLOSED or FAIL is rejected`);
      assert.equal(benchLifecycleHonest(sampleBench(status, '（独立 SCAN）')), false,
        `${status}: bench self-CLOSED or FAIL is rejected`);
    }
    assert.equal(freezeLifecycleHonest(
      sampleFreeze('CLOSED — PASS（NO_PRODUCT_DELTA / STOP）', 'CLOSED — PASS')), false,
      'STOP without independent SCAN is rejected');
    assert.equal(benchLifecycleHonest(
      sampleBench('CLOSED — PASS（NO_PRODUCT_DELTA / STOP）')), false,
      'bench STOP without independent SCAN is rejected');

    for (const closed of [
      'CLOSED', 'CLOSED — FAIL', 'CLOSED — PASS',
      'CLOSED — PASS（PRODUCT_DELTA）', 'CLOSED — PASS（adopt=true · EXPERIENCE-only）',
    ]) {
      assert.equal(freezeLifecycleHonest(sampleFreeze('FROZEN / 开干', closed, '独立 SCAN')), false,
        `${closed}: mixed FROZEN title/CLOSED status rejected`);
      assert.equal(freezeLifecycleHonest(sampleFreeze(closed, 'FROZEN / 开干', '独立 SCAN')), false,
        `${closed}: mixed CLOSED title/FROZEN status rejected`);
    }
    assert.equal(freezeLifecycleHonest(
      sampleFreeze('CLOSED — PASS（PRODUCT_DELTA）', 'CLOSED — PASS')), false,
      'PRODUCT_DELTA without independent SCAN is rejected');
    assert.equal(freezeLifecycleHonest(
      sampleFreeze('CLOSED — PASS（TRANSPORT）', 'CLOSED — PASS')), false,
      'TRANSPORT without independent SCAN is rejected');
    assert.equal(freezeLifecycleHonest(
      sampleFreeze('CLOSED — PASS（PRODUCT_DELTA）', 'CLOSED — PASS（PRODUCT_DELTA · NOT SCAN）')), false,
      'a NOT SCAN status is not independent evidence');

    const aligned = read('freeze-offloop-experience-compose-deepen-r1.md');
    assert.equal(baseFreezeLifecycleHonest(aligned), true,
      'base T-tlsc helper still accepts a known NO_PRODUCT_DELTA closure');
  });

  test('T-lw12a-2: PIN, tip HEAD, product hashes, §0 lock and FROZEN handoff remain fixed with zero writes', t => {
    assert.equal(STEAL_TIP_PIN, tipPin);
    const session = readJson('session-start.json');
    assert.equal(session.knife, knife);
    assert.equal(session.wave, 'wave13');
    assert.equal(session.tipPin, tipPin);
    assert.equal(session.STEAL_TIP_PIN, tipPin);
    assert.equal(session.tipHead, tipPin);
    assert.equal(session.productWrites, 0);
    assert.equal(session.runtimeWrites, 0);
    assert.equal(session.selfClosed, false);
    assert.equal(session.freezeStatus, 'FROZEN / 开干');
    assert.equal(session.freezeLockSha256, lockHash);
    assert.equal(fs.readFileSync(path.join(out, 'tip-head.txt'), 'utf8').trim(), tipPin);

    const tip = probeTipHead('/workspace/dda-tip-r25');
    if (tip.ok) assert.equal(tip.head, tipPin, 'readable tip HEAD remains pinned');
    else t.diagnostic(`ENVIRONMENT skip: tip git HEAD (${tip.code}): ${tip.message}; STEAL_TIP_PIN/session pin checked`);

    const beforeText = fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8');
    assert.equal(sha256(beforeText), session.beforeHashesSha256,
      'seeded product baseline is unchanged');
    assert.equal(fs.readFileSync(path.join(out, 'after-hashes.txt'), 'utf8'), beforeText,
      'before/after hashes are byte-identical');
    const rows = beforeText.trim().split(/\r?\n/).map(line => {
      const row = line.match(/^([a-f0-9]{64})\s+(\S+)$/);
      assert.ok(row, `valid hash row: ${line}`);
      return { hash: row[1], file: row[2] };
    });
    const offloopProducts = fs.readdirSync(path.join(root, 'offloop'))
      .filter(name => name.endsWith('.mjs')).map(name => `offloop/${name}`).sort();
    const baselineProducts = rows.filter(row => row.file.startsWith('offloop/')).map(row => row.file).sort();
    assert.deepEqual(baselineProducts, offloopProducts, 'baseline covers every offloop/*.mjs product');
    for (const row of rows) {
      assert.equal(sha256(fs.readFileSync(path.join(root, row.file))), row.hash,
        `${row.file}: unchanged from session start`);
    }

    const freeze = read(`freeze-offloop-${knife}.md`);
    assert.equal(freezeLifecycleHonest(freeze), true,
      'this knife remains FROZEN honesty or independent SCAN closure');
    const lockStart = freeze.indexOf('## 0. 锁定\n');
    const lockEnd = freeze.indexOf('## 1. 不做', lockStart);
    assert.ok(lockStart >= 0 && lockEnd > lockStart, '§0 lock boundaries exist');
    assert.equal(sha256(freeze.slice(lockStart, lockEnd)), lockHash,
      '§0 lock remains byte-identical');
    // Latch: Codex FROZEN handoff OR independent SCAN CLOSED — PASS · NO_PRODUCT_DELTA.
    // §0 lock remains pinned; summary/session keep the Codex FROZEN handoff snapshot.
    const { line: statusLine, value: status } = freezeStatus(freeze);
    const title = freeze.split('\n')[0];
    const frozenHandoff = /^FROZEN \/ 开干(?:[（(]|$)/.test(status)
      && !/CLOSED —/.test(title);
    const scanClosedPass = /^CLOSED — PASS\b/.test(status)
      && /CLOSED — PASS(?:（NO_PRODUCT_DELTA）| · NO_PRODUCT_DELTA)/.test(title)
      && independentScan(freeze, statusLine);
    assert.ok(frozenHandoff || scanClosedPass,
      'FROZEN handoff | SCAN CLOSED — PASS · NO_PRODUCT_DELTA (no bare self-CLOSED)');

    const summary = readJson('summary.json');
    assert.equal(summary.knife, knife);
    assert.equal(summary.wave, 'wave13');
    assert.equal(summary.knifeNumber, 1);
    assert.equal(summary.pack, 'A');
    assert.equal(summary.tipPin, tipPin);
    assert.equal(summary.productWrites, 0);
    assert.equal(summary.runtimeWrites, 0);
    assert.equal(summary.productHashesUnchanged, true);
    assert.equal(summary.freezeStatus, 'FROZEN / SCAN READY');
    assert.equal(summary.freezeFileStatus, 'FROZEN / 开干');
    assert.equal(summary.freezeLockSha256, lockHash);
    assert.equal(summary.selfClosed, false);
    assert.deepEqual(summary.tests, { 'T-lw12a-1': 'PASS', 'T-lw12a-2': 'PASS' });
    assert.deepEqual(summary.acceptedSiblings, [
      'lifecycle-wave11-sibling-accept-r1',
      'tip-soft-prior-snapshot-refresh-r1',
      'wave11-closeout-cleanup-r1',
      'dtsal-write-scope-replay-harden-r1',
      'dayloop-transport-experience-live-persist-r1',
      'tip-soft-adopt-fifth-family-live-r1',
    ]);
    assert.equal(benchLifecycleHonest(read(`bench-log-offloop-${knife}.md`)), true,
      'bench remains FROZEN / SCAN READY or independent SCAN CLOSED — PASS · NO_PRODUCT_DELTA');
  });
}
