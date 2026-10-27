import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'offloop/out-observational-candidateAllowed-gate-r1');
const live = path.join(root, 'offloop/out-dayloop-tip-soft-adopt-live-r1');
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const expectedEvidence = {
  'adopt-evidence.json': 'c04cb13cfcd9c9042ff9386c00be431a52d86da81e485b79665d9735a2d0f09f',
  'request-evidence.json': '557d634d62213078600d082cfd7872e6c9d580e1645233a7f0628a107662f244',
  'summary.json': '5f7d91d06000fab3eafe61fe6796db3a496d4c0697a1e6db10e4bbeb1d06f0e3',
  'adopt-record.json': '480e2d3e9edfb9a17ac43918065a52abda151f65f0bd39002399721f866f948e',
  'transport-record.json': '075e5dfbd1f8bc09652295efc3c150d2f9a41595cf628c89b064bff5932e815d',
  'tip-soft-adopt-live.mjs': 'd3081aa49548b136a9dbd654d6ab018bf7660e2d0e820a34e586093e57427742',
};

const protectedFiles = [
  'compose.mjs',
  'experience.mjs',
  'dayloop-soft.mjs',
  'probe-l1.mjs',
  'propose.mjs',
  'path-signals.mjs',
  'on-closed.mjs',
];

test('T-ocag-1: audit artifacts reproduce candidateAllowed=false and wroteCandidate=false on adopt live path', () => {
  for (const name of Object.keys(expectedEvidence)) {
    assert.ok(fs.existsSync(path.join(live, name)), `${name} live evidence must exist`);
    assert.equal(sha256(fs.readFileSync(path.join(live, name))), expectedEvidence[name], `${name} evidence hash`);
  }

  const request = readJson(path.join(live, 'request-evidence.json'));
  const system = request.payload.messages[0].content;
  assert.match(system, /candidateAllowed \(false\)/);
  assert.match(system, /Projection alone cannot establish runtime improvement or justify a candidate/);

  const harness = fs.readFileSync(path.join(live, 'tip-soft-adopt-live.mjs'), 'utf8');
  assert.match(harness, /audit\.candidateAllowed !== false/);
  assert.match(harness, /candidateAllowed: false/);

  const evidence = readJson(path.join(live, 'adopt-evidence.json'));
  const summary = readJson(path.join(live, 'summary.json'));
  const adoptRecord = readJson(path.join(live, 'adopt-record.json'));
  const transport = readJson(path.join(live, 'transport-record.json'));

  assert.equal(evidence.responseAudit.candidateAllowed, false);
  assert.equal(evidence.responseAudit.projectionPreservesGateEvents, true);
  assert.equal(summary.responseAudit.candidateAllowed, false);
  assert.equal(transport.responseAudit.candidateAllowed, false);
  assert.equal(summary.adopt, true);
  assert.equal(summary.candidateAdopt, false);
  assert.equal(summary.candidateCount, 0);
  assert.equal(summary.wroteCandidate ?? adoptRecord.results?.[0]?.wroteCandidate, false);
  assert.equal(adoptRecord.candidateAdopt, false);
  assert.equal(adoptRecord.candidateCount, 0);
  assert.equal(adoptRecord.adopt, true);
  assert.ok(adoptRecord.results?.length >= 1);
  for (const row of adoptRecord.results) {
    assert.equal(row.wroteCandidate, false);
    assert.equal(row.candidatePath, null);
    assert.ok(row.experiencePath);
    assert.equal(row.reason, 'experience_only');
  }
  assert.match(adoptRecord.interpretation || '', /EXPERIENCE-only/i);

  const gate = readJson(path.join(out, 'gate-audit.json'));
  assert.equal(gate.hardGate.intentional, true);
  assert.equal(gate.hardGate.testable, true);
  assert.equal(gate.hardGate.systemPromptContainsCandidateAllowedFalse, true);
  assert.equal(gate.hardGate.validatorRejectsNonFalse, true);
  assert.equal(gate.adoptVsCandidate.wroteCandidate, false);
  assert.equal(gate.decision, 'NO_PRODUCT_DELTA / STOP');
  assert.deepEqual(gate.gapsFound, []);
  assert.deepEqual(gate.evidenceSha256, expectedEvidence);

  const npd = readJson(path.join(out, 'no-product-delta.json'));
  assert.equal(npd.productDelta, 'NO_PRODUCT_DELTA');
  assert.equal(npd.stop, true);
  assert.equal(npd.candidateAllowed, false);
  assert.equal(npd.wroteCandidate, false);
  assert.equal(npd.hardGateIntentional, true);
  assert.equal(npd.autoPromoteCandidate, false);
  assert.equal(npd.productWrites, 0);
  assert.equal(npd.selfClosed, false);
  assert.equal(npd.freezeRemainsFROZEN, true);
  assert.equal(npd.tipPin, tipPin);
  assert.deepEqual(npd.evidenceSha256, expectedEvidence);
  assert.equal(npd.gapsFound.length, 0);

  const freeze = read('freeze-offloop-observational-candidateAllowed-gate-r1.md');
  const title = freeze.split('\n')[0];
  const statusLine = freeze.split('\n').find((line) => line.includes('**状态：')) || '';
  const frozenHonesty = /\*\*FROZEN \/ 开干\*\*/.test(freeze) && !/CLOSED/.test(title);
  const scanClosed = /CLOSED — PASS/.test(title)
    && /\*\*状态：CLOSED — PASS/.test(statusLine)
    && /独立 SCAN/.test(freeze);
  assert.ok(frozenHonesty || scanClosed, 'freeze must stay FROZEN (Codex) or SCAN CLOSED');
  assert.ok(!/^-\s*\*\*状态：CLOSED/m.test(freeze) || scanClosed, 'Codex must not self-CLOSED');
  const session = readJson(path.join(out, 'session-start.json'));
  const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
  assert.equal(sha256(Buffer.from(lock, 'utf8')), session.freezeLockSha256);
});

test('T-ocag-2: true-candidate / steal allowlist / soft evidence contracts hold; STEAL_TIP_PIN stable; 0× auto-promote', (t) => {
  assert.equal(STEAL_TIP_PIN, tipPin);

  const npd = readJson(path.join(out, 'no-product-delta.json'));
  assert.equal(npd.STEAL_TIP_PIN, tipPin);
  assert.equal(npd.STEAL_TIP_PIN_unchanged, true);
  assert.equal(npd.autoPromoteCandidate, false);
  assert.equal(npd.protectedHashes.unchanged, true);

  const before = Object.fromEntries(
    fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8').trim().split(/\n/)
      .map((line) => {
        const [file, hash] = line.trim().split(/\s+/);
        return [file, hash];
      }),
  );
  for (const file of protectedFiles) {
    const now = sha256(fs.readFileSync(path.join(root, 'offloop', file)));
    assert.equal(now, before[file], `${file} must match before-hashes`);
    assert.equal(now, npd.protectedHashes.before[file]);
    assert.equal(now, npd.protectedHashes.after[file]);
  }
  assert.equal(before.tip, tipPin);
  assert.equal(fs.readFileSync(path.join(out, 'tip-head.txt'), 'utf8').trim(), tipPin);

  // true-candidate / steal / soft-evidence contract surfaces remain present (no silent delete)
  const trueCand = read('offloop/test/true-candidate-r1.test.mjs');
  assert.match(trueCand, /STEAL_TIP_PIN/);
  assert.match(trueCand, /experience_only/);
  assert.match(trueCand, /wroteCandidate/);

  const steal = read('offloop/test/steal-path-anomaly-candidate-r1.test.mjs');
  assert.match(steal, /assertExperienceOnly|experience_only/);
  assert.match(steal, /wroteCandidate|CANDIDATE/i);

  const soft = read('offloop/test/compose-soft-evidence.test.mjs');
  assert.match(soft, /wroteCandidate/);
  assert.match(soft, /false/);

  const compose = read('offloop/compose.mjs');
  assert.match(compose, /experience_only/);
  assert.match(compose, /isExperienceOnlyHypothesis|rejectExperience/);

  const dayloop = read('offloop/dayloop-soft.mjs');
  assert.match(dayloop, /experience_only/);
  assert.match(dayloop, /shipped_duplicate/);

  // freeze forbids auto-promoting observational adopt into CANDIDATE writes
  const freeze = read('freeze-offloop-observational-candidateAllowed-gate-r1.md');
  assert.match(freeze, /禁.*自动升 CANDIDATE|禁止.*自动写\/升 CANDIDATE|勿自动升/);
  assert.match(freeze, /NO_PRODUCT_DELTA/);

  const integrity = readJson(path.join(out, 'source-integrity.json'));
  assert.equal(integrity.productDelta, 'NO_PRODUCT_DELTA');
  assert.equal(integrity.productWrites, 0);
  assert.equal(integrity.STEAL_TIP_PIN, tipPin);
  assert.deepEqual(integrity.tip, { before: tipPin, after: tipPin, unchanged: true });

  const tip = '/workspace/dda-tip-r25';
  if (fs.existsSync(tip)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-ocag-tip-'));
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

  const summary = readJson(path.join(out, 'summary.json'));
  assert.equal(summary.verdict, 'NO_PRODUCT_DELTA / STOP');
  assert.equal(summary.autoPromoteCandidate, false);
  assert.equal(summary.candidateAllowed, false);
  assert.equal(summary.productEdits, 0);
  assert.equal(summary.freezeRemainsFROZEN, true);
});
