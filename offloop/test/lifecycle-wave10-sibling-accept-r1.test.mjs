import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { probeTipHead } from './test-git-eperm-env-harden-r1.test.mjs';
import {
  freezeLifecycleHonest as noProductDeltaFreezeLifecycleHonest,
  benchLifecycleHonest as noProductDeltaBenchLifecycleHonest,
} from './test-lifecycle-scan-closed-accept-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'lifecycle-wave10-sibling-accept-r1';
const out = path.join(root, `offloop/out-${knife}`);
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const lockHash = '8cfdd45dc4afd81840ac126c4e4b7daf6742444f4996206625a334a6b010e00c';
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = name => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Reuse T-tlsc unchanged. The docs-only w9c SCAN has a bare PASS title;
// its explicit docs/脚注 SCAN status and independent SCAN note are both required.
export function freezeLifecycleHonest(freeze) {
  if (noProductDeltaFreezeLifecycleHonest(freeze)) return true;
  const title = freeze.split('\n')[0].match(/\*\*([^*]+)\*\*\s*$/)?.[1] ?? '';
  const status = freeze.match(/^-\s+\*\*状态[：:]\s*([^*]+)\*\*/m)?.[1] ?? '';
  return title === 'CLOSED — PASS'
    && /^CLOSED — PASS[（(]SCAN\s*·[^）)\n]*·\s*docs\/脚注[）)][。.]*$/.test(status)
    && /独立 SCAN/.test(freeze);
}

export function benchLifecycleHonest(bench) {
  if (noProductDeltaBenchLifecycleHonest(bench)) return true;
  const statusLine = bench.match(/^- Status:.*$/m)?.[0] ?? '';
  return /^- Status:\s*\*\*CLOSED — PASS\*\*\s*[（(]独立 SCAN\s*·/.test(statusLine);
}

// Register once in a shared-process run, or only at this entry point with file isolation.
if (process.execArgv.includes('--test-isolation=none')
    || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  test('T-lwsa-1: four live wave10 sibling SCAN closures pass; Codex self-CLOSED and FAIL are rejected', () => {
    const sampleFreeze = (title, status, note = '') => `# Freeze: **${title}**\n\n- **状态：${status}**\n${note}\n`;
    const sampleBench = (status, note = '') => `# Bench\n\n- Status: **${status}**${note}\n`;
    const closedStates = [
      'CLOSED', 'CLOSED — FAIL', 'CLOSED — FAIL（NO_PRODUCT_DELTA）',
      'CLOSED — PASS', 'CLOSED — PASS（NO_PRODUCT_DELTA）', 'CLOSED — PASS · NO_PRODUCT_DELTA',
    ];
    for (const sample of [
      'aepp-experience-date-fixture-r1', 'test-git-eperm-env-harden-r1',
      'transport-timeout-experience-prior-r1', 'wave9-closeout-cleanup-r1',
    ]) {
      const freeze = read(`freeze-offloop-${sample}.md`);
      assert.match(freeze.split('\n')[0], /CLOSED — PASS/, `${sample}: live CLOSED sample`);
      assert.equal(freezeLifecycleHonest(freeze), true, `${sample}: independent SCAN accepted`);
      for (const state of closedStates) {
        assert.equal(freezeLifecycleHonest(sampleFreeze(state, state, `Codex ${sample}: selfClosed=true`)),
          false, `${sample}: ${state} without independent SCAN must fail`);
      }
    }
    const docsStatus = 'CLOSED — PASS（SCAN · wave10 · 刀 1 · docs/脚注）。';
    assert.equal(freezeLifecycleHonest(sampleFreeze('CLOSED — PASS', docsStatus, '独立 SCAN')), true);
    assert.equal(freezeLifecycleHonest(sampleFreeze('CLOSED — PASS', docsStatus)), false);
    assert.equal(freezeLifecycleHonest(sampleFreeze('CLOSED — PASS', docsStatus.replace('SCAN · ', ''), '独立 SCAN')), false);
    for (const state of ['CLOSED', 'CLOSED — FAIL', 'CLOSED — FAIL（NO_PRODUCT_DELTA）']) {
      assert.equal(freezeLifecycleHonest(sampleFreeze(state, docsStatus, '独立 SCAN')), false);
      assert.equal(freezeLifecycleHonest(sampleFreeze('CLOSED — PASS', state, '独立 SCAN')), false);
    }
    for (const state of ['FROZEN / 开干', 'FROZEN / SCAN READY']) {
      assert.equal(freezeLifecycleHonest(sampleFreeze(state, state)), true);
      assert.equal(freezeLifecycleHonest(sampleFreeze(state, docsStatus, '独立 SCAN')), false);
      assert.equal(freezeLifecycleHonest(sampleFreeze('CLOSED — PASS', state, '独立 SCAN')), false);
    }
    assert.equal(benchLifecycleHonest(read('bench-log-offloop-wave9-closeout-cleanup-r1.md')), true);
    assert.equal(benchLifecycleHonest(sampleBench('FROZEN / SCAN READY')), true);
    for (const state of closedStates) {
      assert.equal(benchLifecycleHonest(sampleBench(state)), false, `${state}: bench without SCAN rejected`);
    }
    assert.equal(benchLifecycleHonest(sampleBench('CLOSED — FAIL', '（独立 SCAN · docs/脚注）')), false);
    assert.equal(freezeLifecycleHonest(''), false);
    assert.equal(benchLifecycleHonest(''), false);
  });

  test('T-lwsa-2: PIN, every product hash, §0 lock and zero writes remain fixed; no Codex self-CLOSE', t => {
    assert.equal(STEAL_TIP_PIN, tipPin);
    const session = readJson('session-start.json');
    assert.equal(session.knife, knife);
    assert.equal(session.wave, 'wave11');
    assert.equal(session.tipPin, tipPin);
    assert.equal(session.STEAL_TIP_PIN, tipPin);
    assert.equal(session.tipHead, tipPin);
    assert.equal(session.productWrites, 0);
    assert.equal(session.runtimeWrites, 0);
    assert.equal(session.selfClosed, false);
    assert.equal(fs.readFileSync(path.join(out, 'tip-head.txt'), 'utf8').trim(), tipPin);
    const tipHead = probeTipHead('/workspace/dda-tip-r25');
    if (tipHead.ok) assert.equal(tipHead.head, tipPin, 'readable tip HEAD remains pinned');
    else t.diagnostic(`ENVIRONMENT skip: tip git HEAD (${tipHead.code}): ${tipHead.message}; STEAL_TIP_PIN/session pin checked`);

    const beforeText = fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8');
    const before = new Map();
    for (const line of beforeText.trim().split(/\r?\n/)) {
      const row = line.match(/^([a-f0-9]{64})\s+(offloop\/[^/]+\.mjs)$/);
      assert.ok(row, `invalid product hash row: ${line}`);
      assert.ok(!before.has(row[2]), `duplicate product hash: ${row[2]}`);
      before.set(row[2], row[1]);
    }
    const products = fs.readdirSync(path.join(root, 'offloop')).filter(name => name.endsWith('.mjs'))
      .map(name => `offloop/${name}`).sort();
    assert.ok(products.length > 0, 'product inventory is nonempty');
    assert.deepEqual([...before.keys()].sort(), products, 'baseline covers every offloop/*.mjs product');
    for (const [file, hash] of before) {
      assert.equal(sha256(fs.readFileSync(path.join(root, file))), hash, `${file}: unchanged from session start`);
    }
    assert.equal(fs.readFileSync(path.join(out, 'after-hashes.txt'), 'utf8'), beforeText, 'before/after byte-identical');

    const freeze = read(`freeze-offloop-${knife}.md`);
    assert.ok(freezeLifecycleHonest(freeze), 'this knife stays FROZEN or is independently SCAN-closed');
    const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
    assert.equal(typeof lock, 'string', '§0 lock must exist');
    assert.equal(session.freezeLockSha256, lockHash);
    assert.equal(sha256(lock), session.freezeLockSha256, '§0 lock stays byte-identical');
    const summary = readJson('summary.json');
    assert.equal(summary.knife, knife);
    assert.equal(summary.wave, 'wave11');
    assert.equal(summary.tipPin, tipPin);
    assert.equal(summary.productWrites, 0);
    assert.equal(summary.runtimeWrites, 0);
    assert.equal(summary.productHashesUnchanged, true);
    assert.equal(summary.freezeLockSha256, lockHash);
    assert.equal(summary.freezeStatus, 'FROZEN / SCAN READY', 'summary records Codex handoff');
    assert.equal(summary.selfClosed, false);
    assert.ok(benchLifecycleHonest(read(`bench-log-offloop-${knife}.md`)), 'bench preserves lifecycle honesty');
  });
}
