import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { probeTipHead } from './test-git-eperm-env-harden-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'test-lifecycle-scan-closed-accept-r1';
const out = path.join(root, `offloop/out-${knife}`);
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scanPass = /^CLOSED — PASS(?:\s*[（(]NO_PRODUCT_DELTA(?:\s*\/\s*STOP)?[）)]|\s*·\s*NO_PRODUCT_DELTA)\s*$/;
const frozen = (value) => /^FROZEN\b/.test(value) && !/\bCLOSED\b/.test(value);
const independentScan = (body, statusLine) => /独立 SCAN/.test(body) || /[（(]SCAN\s*·/.test(statusLine);

// Codex hands off FROZEN; independent SCAN may close with PASS / NO_PRODUCT_DELTA.
export function freezeLifecycleHonest(freeze) {
  const title = freeze.split('\n')[0].match(/\*\*([^*]+)\*\*\s*$/)?.[1] ?? '';
  const statusLine = freeze.match(/^-\s+\*\*状态[：:].*$/m)?.[0] ?? '';
  const status = statusLine.match(/\*\*状态[：:]\s*([^*]+)\*\*/)?.[1] ?? '';
  const frozenHonesty = frozen(title) && frozen(status);
  const scanClosed = scanPass.test(title) && /^CLOSED — PASS\b/.test(status)
    && independentScan(freeze, statusLine);
  return frozenHonesty || scanClosed;
}

export function benchLifecycleHonest(bench) {
  const statusLine = bench.match(/^- Status:.*$/m)?.[0] ?? '';
  const status = statusLine.match(/^- Status:\s*\*\*([^*]+)\*\*/)?.[1] ?? '';
  const frozenHonesty = /^FROZEN\s*\/\s*SCAN READY$/.test(status);
  const scanClosed = scanPass.test(status) && independentScan(bench, statusLine);
  return frozenHonesty || scanClosed;
}

// Register once in a shared-process run, or only at this entry point with file isolation.
if (process.execArgv.includes('--test-isolation=none')
    || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  test('T-tlsc-1: live SCAN CLOSED freezes/bench pass; FROZEN honesty passes; self-CLOSED is rejected', () => {
    for (const sample of ['agent-miss-path-product-knife-r1', 'propose-external-hygiene-r1', 'experience-compose-deepen-r1']) {
      const freeze = read(`freeze-offloop-${sample}.md`);
      assert.match(freeze.split('\n')[0], /CLOSED — PASS/, `${sample}: live CLOSED sample`);
      assert.equal(freezeLifecycleHonest(freeze), true, `${sample}: independent SCAN accepted`);
    }
    const bench = read('bench-log-offloop-propose-external-hygiene-r1.md');
    assert.match(bench.match(/^- Status:.*$/m)?.[0] ?? '', /CLOSED — PASS/);
    assert.equal(benchLifecycleHonest(bench), true, 'live PEH bench accepted');

    const freezeSample = (title, status, note = '') => `# Freeze: **${title}**\n\n- **状态：${status}**\n${note}\n`;
    const benchSample = (status, note = '') => `# Bench\n\n- Status: **${status}**${note}\n`;
    assert.equal(freezeLifecycleHonest(freezeSample('FROZEN / 开干', 'FROZEN / 开干')), true);
    assert.equal(benchLifecycleHonest(benchSample('FROZEN / SCAN READY')), true);
    for (const closed of ['CLOSED — PASS（NO_PRODUCT_DELTA）', 'CLOSED — PASS (NO_PRODUCT_DELTA)', 'CLOSED — PASS · NO_PRODUCT_DELTA']) {
      // Both an independent SCAN note and a status SCAN marker are valid evidence.
      assert.equal(freezeLifecycleHonest(freezeSample(closed, 'CLOSED — PASS（SCAN · wave8）')), true);
      assert.equal(freezeLifecycleHonest(freezeSample(closed, 'CLOSED — PASS', '独立 SCAN')), true);
      assert.equal(benchLifecycleHonest(benchSample(closed, '（独立 SCAN）')), true);
      assert.equal(benchLifecycleHonest(benchSample(closed, '（SCAN · wave8）')), true);
      assert.equal(freezeLifecycleHonest(freezeSample(closed, 'CLOSED — PASS')), false, 'PASS alone is not SCAN');
      assert.equal(benchLifecycleHonest(benchSample(closed)), false, 'bench PASS alone is not SCAN');
    }
    for (const state of ['CLOSED', 'CLOSED — FAIL（NO_PRODUCT_DELTA）', 'CLOSED — PASS']) {
      assert.equal(freezeLifecycleHonest(freezeSample(state, state)), false, 'self-CLOSED rejected');
      assert.equal(benchLifecycleHonest(benchSample(state)), false, 'bench self-CLOSED rejected');
      assert.equal(freezeLifecycleHonest(freezeSample(state, state, '独立 SCAN')), false, 'SCAN still requires PASS / NO_PRODUCT_DELTA');
      assert.equal(benchLifecycleHonest(benchSample(state, '（独立 SCAN）')), false);
    }
    assert.equal(freezeLifecycleHonest(freezeSample('FROZEN / 开干', 'CLOSED', '**FROZEN / 开干**')), false);
    assert.equal(freezeLifecycleHonest(freezeSample('CLOSED — PASS（NO_PRODUCT_DELTA）', 'FROZEN / 开干', '独立 SCAN')), false);
    assert.equal(freezeLifecycleHonest(''), false);
    assert.equal(benchLifecycleHonest(''), false);
  });

  test('T-tlsc-2: PIN and all product hashes stay fixed; this knife stays FROZEN with its §0 lock and zero product writes', (t) => {
    assert.equal(STEAL_TIP_PIN, tipPin);
    const session = readJson(path.join(out, 'session-start.json'));
    assert.equal(session.knife, knife);
    assert.equal(session.STEAL_TIP_PIN, tipPin);
    assert.equal(session.tipHead, tipPin);
    assert.equal(session.productWrites, 0);
    assert.equal(fs.readFileSync(path.join(out, 'tip-head.txt'), 'utf8').trim(), tipPin);
    const tip = '/workspace/dda-tip-r25';
    const tipHead = probeTipHead(tip);
    if (tipHead.ok) assert.equal(tipHead.head, tipPin, 'tip HEAD remains pinned');
    else t.diagnostic(`ENVIRONMENT skip: tip git HEAD (${tipHead.code}): ${tipHead.message}; STEAL_TIP_PIN/session pin checked`);

    const beforeText = fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8');
    const before = new Map();
    for (const line of beforeText.trim().split(/\r?\n/)) {
      const row = line.match(/^([a-f0-9]{64})\s+(offloop\/[^/]+\.mjs)$/);
      assert.ok(row, `invalid product hash row: ${line}`);
      assert.ok(!before.has(row[2]), `duplicate product hash: ${row[2]}`);
      before.set(row[2], row[1]);
    }
    const products = fs.readdirSync(path.join(root, 'offloop')).filter((name) => name.endsWith('.mjs'))
      .map((name) => `offloop/${name}`).sort();
    assert.ok(products.length > 0, 'product inventory is nonempty');
    assert.deepEqual([...before.keys()].sort(), products, 'baseline covers every offloop/*.mjs product');
    for (const [file, hash] of before) {
      assert.equal(sha256(fs.readFileSync(path.join(root, file))), hash, `${file}: unchanged from session start`);
    }
    assert.equal(fs.readFileSync(path.join(out, 'after-hashes.txt'), 'utf8'), beforeText, 'before/after identical');

    const freeze = read(`freeze-offloop-${knife}.md`);
    // Codex must remain FROZEN; independent SCAN may flip to CLOSED — PASS（NO_PRODUCT_DELTA）.
    assert.ok(freezeLifecycleHonest(freeze),
      'this knife must stay FROZEN (Codex) or independent SCAN CLOSED — PASS with NO_PRODUCT_DELTA');
    const status = freeze.match(/^-\s+\*\*状态[：:]\s*([^*]+)\*\*/m)?.[1] ?? '';
    assert.ok(frozen(status) || (/^CLOSED — PASS\b/.test(status) && independentScan(freeze, status)),
      'this knife must remain FROZEN or SCAN-closed; bare self-CLOSED rejected');
    const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
    assert.equal(typeof lock, 'string', '§0 lock must exist');
    assert.equal(sha256(lock), session.freezeLockSha256, '§0 lock is byte-identical');
    const summary = readJson(path.join(out, 'summary.json'));
    assert.equal(summary.knife, knife);
    assert.equal(summary.tipPin, tipPin);
    assert.equal(summary.productWrites, 0);
    assert.ok(['FROZEN / SCAN READY', 'CLOSED — PASS（NO_PRODUCT_DELTA）'].includes(summary.freezeStatus)
      || /^CLOSED — PASS\b/.test(summary.freezeStatus),
      'summary freezeStatus records Codex handoff or SCAN close');
    assert.equal(summary.selfClosed, false);
    const bench = read(`bench-log-offloop-${knife}.md`);
    assert.ok(benchLifecycleHonest(bench),
      'bench must stay FROZEN / SCAN READY or independent SCAN CLOSED — PASS with NO_PRODUCT_DELTA');
  });
}
