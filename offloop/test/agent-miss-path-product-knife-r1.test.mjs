import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { freezeLifecycleHonest } from './test-lifecycle-scan-closed-accept-r1.test.mjs';
import { probeTipHead, probeTipStatus } from './test-git-eperm-env-harden-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'offloop/out-agent-miss-path-product-knife-r1');
const audit = path.join(root, 'out-agent-miss-path-product-audit-r1');
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const protectedFiles = [
  'runtime/src/plan-step-coordinator.mjs',
  'runtime/src/task-recovery-controller.mjs',
  'offloop/path-signals.mjs',
  'bench/score-topology-run.mjs',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const resolveProtected = (rel) => (
  rel.startsWith('runtime/')
    ? path.join('/workspace/dda-tip-r25', rel)
    : path.join(root, rel)
);

test('T-ampk-1: preflight reread matches audit counts; STOP artifacts present; protected hashes stable', () => {
  const preflightPath = path.join(out, 'preflight-audit-reread.json');
  assert.ok(fs.existsSync(preflightPath), 'preflight-audit-reread.json must exist');
  const preflight = readJson(preflightPath);
  const auditCounts = readJson(path.join(audit, 'counts.json'));
  assert.equal(preflight.counts.EXPECTED, auditCounts.EXPECTED);
  assert.equal(preflight.counts.SUSPECT_PRODUCT, auditCounts.SUSPECT_PRODUCT);
  assert.equal(preflight.counts.NEEDS_KNIFE, auditCounts.NEEDS_KNIFE);
  assert.equal(preflight.counts.SUSPECT_PRODUCT, 0);
  assert.equal(preflight.counts.NEEDS_KNIFE, 0);
  assert.equal(preflight.auditVerdict, 'NO_PRODUCT_KNIFE');
  assert.equal(preflight.decision, 'NO_PRODUCT_DELTA / STOP');
  assert.equal(preflight.tipPin, tipPin);
  assert.deepEqual(preflight.newPathErrorEvidence, []);
  assert.equal(preflight.exceptionA_suspectProduct, false);
  assert.equal(preflight.exceptionB_newMisroute, false);

  const noDeltaPath = path.join(out, 'no-product-delta.json');
  assert.ok(fs.existsSync(noDeltaPath), 'no-product-delta.json must exist on STOP path');
  const noDelta = readJson(noDeltaPath);
  assert.equal(noDelta.verdict, 'NO_PRODUCT_DELTA');
  assert.equal(noDelta.stop, true);
  assert.equal(noDelta.productWrites.runtime, 0);
  assert.equal(noDelta.productWrites.scorer, 0);
  assert.equal(noDelta.productWrites.pathSignals, 0);
  assert.equal(noDelta.selfClosed, false);
  assert.equal(noDelta.freezeRemainsFROZEN, true);

  const before = Object.fromEntries(
    fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8').trim().split(/\n/)
      .map((line) => {
        const [h, ...rest] = line.trim().split(/\s+/);
        return [rest.join(' '), h];
      }),
  );
  assert.deepEqual(Object.keys(before).sort(), [...protectedFiles].sort());
  for (const rel of protectedFiles) {
    const now = sha256(fs.readFileSync(resolveProtected(rel)));
    assert.equal(now, before[rel], `${rel}: must match session-start before hash`);
    assert.equal(now, noDelta.protectedHashes.before[rel]);
    assert.equal(now, noDelta.protectedHashes.after[rel]);
  }
  assert.equal(noDelta.protectedHashes.unchanged, true);
});

test('T-ampk-2: STOP path leaves STEAL_TIP_PIN, tip HEAD, and runtime/scorer/path-signals untouched', (t) => {
  assert.equal(STEAL_TIP_PIN, tipPin);
  const integrity = readJson(path.join(out, 'source-integrity.json'));
  assert.equal(integrity.productDelta, 'NO_PRODUCT_DELTA');
  assert.equal(integrity.runtimeWrites, 0);
  assert.equal(integrity.scorerWrites, 0);
  assert.equal(integrity.pathSignalsWrites, 0);
  assert.equal(integrity.STEAL_TIP_PIN, tipPin);
  assert.deepEqual(integrity.tip, { before: tipPin, after: tipPin, unchanged: true });

  const session = readJson(path.join(out, 'session-start.json'));
  assert.equal(session.tipHead, tipPin);
  assert.equal(session.decision, 'NO_PRODUCT_DELTA / STOP');
  assert.equal(fs.readFileSync(path.join(out, 'tip-head.txt'), 'utf8').trim(), tipPin);

  const freeze = fs.readFileSync(path.join(root, 'freeze-offloop-agent-miss-path-product-knife-r1.md'), 'utf8');
  assert.ok(freezeLifecycleHonest(freeze),
    'freeze must be FROZEN (Codex honesty) or independent SCAN CLOSED — PASS with NO_PRODUCT_DELTA');
  const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
  assert.equal(sha256(Buffer.from(lock, 'utf8')), session.freezeLockSha256);

  for (const row of integrity.files) {
    assert.ok(protectedFiles.includes(row.file), `unexpected integrity file ${row.file}`);
    assert.equal(row.unchanged, true);
    assert.equal(row.writesByThisKnife, 0);
    assert.equal(sha256(fs.readFileSync(resolveProtected(row.file))), row.before);
  }

  const tip = '/workspace/dda-tip-r25';
  const tipHead = probeTipHead(tip);
  if (tipHead.ok) assert.equal(tipHead.head, tipPin);
  else t.diagnostic(`ENVIRONMENT skip: tip git HEAD (${tipHead.code}): ${tipHead.message}; STEAL_TIP_PIN/session pin checked`);
  // Runtime product files must have no tracked diffs whenever git is available.
  const status = probeTipStatus(tip, [
    'runtime/src/plan-step-coordinator.mjs',
    'runtime/src/task-recovery-controller.mjs',
  ]);
  if (status.ok) assert.equal(status.porcelain, '', 'runtime product files must be clean vs tip HEAD');
  else t.diagnostic(`ENVIRONMENT skip: tip git status (${status.code}): ${status.message}; protected file hashes checked`);

  const summary = readJson(path.join(out, 'summary.json'));
  assert.equal(summary.verdict, 'NO_PRODUCT_DELTA / STOP');
  assert.equal(summary.runtime_writes, 0);
  assert.equal(summary.scorer_writes, 0);
  assert.equal(summary.path_signals_writes, 0);
});
