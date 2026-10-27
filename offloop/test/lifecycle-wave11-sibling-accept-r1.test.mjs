import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { probeTipHead } from './test-git-eperm-env-harden-r1.test.mjs';
import { freezeLifecycleHonest, benchLifecycleHonest } from './test-lifecycle-scan-closed-accept-r1.test.mjs';
import { freezeLifecycleHonest as wave10FreezeLifecycleHonest } from './lifecycle-wave10-sibling-accept-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'lifecycle-wave11-sibling-accept-r1';
const out = path.join(root, `offloop/out-${knife}`);
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const lockHash = '6ce7d42efe88e3bfb7336950c94567a814a48094be1a73ad1a15494f612e8aff';
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = name => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Register once in a shared-process run, or only at this entry point with file isolation.
if (process.execArgv.includes('--test-isolation=none')
    || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  test('T-lw11a-1: live etpl SCAN closure and STOP titles pass; self-CLOSED, FAIL and mixed states are rejected', () => {
    const sampleFreeze = (title, status, note = '') => `# Freeze: **${title}**\n\n- **状态：${status}**\n${note}\n`;
    const sampleBench = (status, note = '') => `# Bench\n\n- Status: **${status}**${note}\n`;
    const live = read('freeze-offloop-experience-transport-prior-live-wire-r1.md');
    assert.match(live.split('\n')[0], /CLOSED — PASS（NO_PRODUCT_DELTA）/);
    assert.match(live, /^- \*\*状态：CLOSED — PASS（NO_PRODUCT_DELTA \/ STOP）/m);
    assert.match(live, /独立 SCAN/);
    assert.equal(freezeLifecycleHonest(live), true, 'live etpl independent SCAN closure is accepted');

    const closedStates = [
      'CLOSED', 'CLOSED — FAIL', 'CLOSED — FAIL（NO_PRODUCT_DELTA / STOP）',
      'CLOSED — PASS', 'CLOSED — PASS（NO_PRODUCT_DELTA）',
      'CLOSED — PASS · NO_PRODUCT_DELTA', 'CLOSED — PASS（NO_PRODUCT_DELTA / STOP）',
    ];
    for (const state of closedStates) {
      assert.equal(freezeLifecycleHonest(sampleFreeze(state, state, 'Codex: selfClosed=true')), false,
        `${state}: self-CLOSED without independent SCAN is rejected`);
      assert.equal(benchLifecycleHonest(sampleBench(state)), false, `${state}: bench needs independent SCAN`);
    }
    for (const title of ['CLOSED — PASS（NO_PRODUCT_DELTA / STOP）', 'CLOSED — PASS (NO_PRODUCT_DELTA / STOP)']) {
      assert.equal(freezeLifecycleHonest(sampleFreeze(title, title)), false, 'STOP alone is not SCAN');
      assert.equal(freezeLifecycleHonest(sampleFreeze(title, title, '独立 SCAN')), true, 'independent note accepts STOP');
      assert.equal(freezeLifecycleHonest(sampleFreeze(title, 'CLOSED — PASS（SCAN · wave12 · NO_PRODUCT_DELTA / STOP）')),
        true, 'status SCAN marker accepts STOP');
      assert.equal(benchLifecycleHonest(sampleBench(title, '（独立 SCAN）')), true);
      for (const status of ['CLOSED', 'CLOSED — FAIL', 'CLOSED — FAIL（NO_PRODUCT_DELTA / STOP）']) {
        assert.equal(freezeLifecycleHonest(sampleFreeze(title, status, '独立 SCAN')), false,
          `${status}: independent SCAN still requires PASS`);
      }
    }
    for (const state of ['CLOSED', 'CLOSED — FAIL', 'CLOSED — PASS']) {
      assert.equal(freezeLifecycleHonest(sampleFreeze(state, state, '独立 SCAN')), false,
        `${state}: independent SCAN still requires the NO_PRODUCT_DELTA title`);
    }
    for (const frozen of ['FROZEN / 开干', 'FROZEN / SCAN READY']) {
      assert.equal(freezeLifecycleHonest(sampleFreeze(frozen, frozen)), true, `${frozen}: honest handoff`);
      for (const closed of closedStates) {
        assert.equal(freezeLifecycleHonest(sampleFreeze(frozen, closed, '独立 SCAN')), false, 'mixed FROZEN/CLOSED rejected');
        assert.equal(freezeLifecycleHonest(sampleFreeze(closed, frozen, '独立 SCAN')), false, 'mixed CLOSED/FROZEN rejected');
      }
    }
    assert.equal(benchLifecycleHonest(sampleBench('FROZEN / SCAN READY')), true);
    assert.equal(freezeLifecycleHonest(''), false);

    const aligned = read('freeze-offloop-experience-compose-deepen-r1.md');
    assert.equal(freezeLifecycleHonest(aligned), true, 'T-tlsc accepts the live ECD SCAN closure');
    assert.equal(wave10FreezeLifecycleHonest(aligned), true, 'T-lwsa accepts the same live ECD SCAN closure');
    // T-ecd-1 has an inline predicate, not an exported helper. Its unchanged test
    // also runs in regression; these are the live markers used by that predicate.
    assert.match(aligned.split('\n')[0], /CLOSED — PASS（NO_PRODUCT_DELTA）/);
    assert.match(aligned.split('\n').find(line => line.includes('**状态：')) ?? '', /\*\*状态：CLOSED — PASS/);
    assert.match(aligned, /独立 SCAN/);
  });

  test('T-lw11a-2: PIN, every product hash, §0 lock and zero writes hold; Codex hands off FROZEN without self-CLOSE', t => {
    assert.equal(STEAL_TIP_PIN, tipPin);
    const session = readJson('session-start.json');
    assert.equal(session.knife, knife);
    assert.equal(session.wave, 'wave12');
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
    assert.equal(sha256(beforeText), session.beforeHashesSha256, 'seeded product baseline is unchanged');
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
    assert.ok(freezeLifecycleHonest(freeze), 'this knife preserves FROZEN honesty or independent SCAN closure');
    const lockStart = freeze.indexOf('## 0. 锁定\n');
    const lockEnd = freeze.indexOf('## 1. 不做', lockStart);
    assert.ok(lockStart >= 0 && lockEnd > lockStart, '§0 lock must exist');
    assert.equal(session.freezeLockSha256, lockHash);
    assert.equal(sha256(freeze.slice(lockStart, lockEnd)), session.freezeLockSha256, '§0 lock stays byte-identical');
    const summary = readJson('summary.json');
    assert.equal(summary.knife, knife);
    assert.equal(summary.wave, 'wave12');
    assert.equal(summary.tipPin, tipPin);
    assert.equal(summary.productWrites, 0);
    assert.equal(summary.runtimeWrites, 0);
    assert.equal(summary.productHashesUnchanged, true);
    assert.equal(summary.freezeLockSha256, lockHash);
    assert.equal(summary.freezeStatus, 'FROZEN / SCAN READY', 'summary records the Codex handoff');
    assert.equal(summary.freezeFileStatus, 'FROZEN / 开干', 'freeze status recorded at handoff');
    assert.equal(summary.selfClosed, false);
    assert.ok(benchLifecycleHonest(read(`bench-log-offloop-${knife}.md`)), 'bench preserves lifecycle honesty');
  });
}
