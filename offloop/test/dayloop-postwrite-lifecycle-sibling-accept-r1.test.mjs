import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'dayloop-postwrite-lifecycle-sibling-accept-r1';
const out = path.join(root, 'offloop', `out-${knife}`);
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const requestSha = '82a7a2dab9de482955b86fef7dae9fba2cc9e3e6a10d13681266296c21ca08af';
const freezeLockSha256 = 'de66332f0c37c161374ba72dd6349246872c8738ab1a93220c24b9a72d7f6d69';
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = file => JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const baseline = Object.freeze({
  'offloop/experience.mjs': '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb',
  'offloop/compose.mjs': 'e284a70868d3954cfe6ce2461683b9e3edbd3d5305c5754cd2eedcafe7aa4e4b',
  'offloop/dayloop-soft.mjs': '39dbf330b3143335163e6209c0a5d8d32538cfb72ededc40ab979b689e48fef3',
  'offloop/soft-worktree.mjs': '45d3119e9a2f4ceae239f16ff61b863d67c20880786b561979ae9c9cb2c21316',
  'offloop/propose.mjs': '08390e92bc5de89c5b29286b24c942e93ec5256f6fc20e643f9bf09b0ea5c411',
});

function parseHashes(text) {
  return Object.fromEntries(text.trim().split(/\r?\n/).map(line => {
    const row = line.match(/^([a-f0-9]{64})\s+(\S+)$/);
    assert.ok(row, `invalid hash row: ${line}`);
    return [row[2], row[1]];
  }));
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function lifecycleFields(probe) {
  const post = probe.postWriteProposal || probe;
  return {
    written: post.written || [],
    retrieved: post.retrieved || [],
    consumed: post.consumed || [],
    consumedCount: post.consumedCount,
    consumedOnlyWarnings: post.consumedOnlyWarnings,
    wroteCandidate: post.wroteCandidate,
    candidatePath: post.candidatePath ?? null,
    tip: probe.summaryTipSha || probe.tip || null,
  };
}

function priorIsWarning(prior) {
  return prior?.adopted === false && prior?.reason === 'experience_only';
}

function tipHeadProbe(tipDir) {
  try {
    return { ok: true, head: execFileSync('git', ['-C', tipDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim() };
  } catch (error) {
    const message = [error.message, error.stderr?.toString()].filter(Boolean).join('\n');
    if (['EPERM', 'ENOENT', 'ENOTDIR', 'EACCES', 'ETIMEDOUT'].includes(error.code)
        || /not a git repository|permission denied|no such file|invalid gitfile format/i.test(message)) {
      return { ok: false, environment: true, code: error.code || 'GIT_UNAVAILABLE', message };
    }
    throw error;
  }
}

// Register once in a shared-process run, or only at this entry point with file isolation.
if (process.execArgv.includes('--test-isolation=none')
    || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  test('T-w14-pwlc-1: fresh postWrite lifecycle semantics are covered and remain STOP-only', () => {
    const fresh = readJson('fresh-lifecycle-probe.json');
    const reference = JSON.parse(read('offloop/out-transport-experience-propose-prior-consume-r1/post-write-proof.json'));
    const actual = lifecycleFields(fresh);
    const expected = lifecycleFields(reference);
    const missing = [];

    if (fresh.postWriteProposal?.ran !== true) missing.push('postWriteProposal.ran===true');
    if (actual.written.length < 1) missing.push('written.length>=1');
    if (actual.retrieved.length < 1) missing.push('retrieved.length>=1');
    if (!(actual.consumedCount >= 1)) missing.push('consumedCount>=1');
    if (actual.consumedOnlyWarnings !== true) missing.push('consumedOnlyWarnings===true');
    if (actual.wroteCandidate !== false) missing.push('wroteCandidate===false');
    if (actual.candidatePath !== null) missing.push('candidatePath===null');
    if (actual.tip !== tipPin) missing.push('fresh tip/PIN');
    if (fresh.requestSha256 !== requestSha) missing.push('requestSha256');
    if (!actual.consumed.every(entry => priorIsWarning(entry.prior))) {
      missing.push('every consumed prior adopted=false/reason=experience_only');
    }
    if (!actual.retrieved.every(entry => entry.adopted === false && entry.reason === 'experience_only')) {
      missing.push('every retrieved prior adopted=false/reason=experience_only');
    }
    if (expected.written.length < 1) missing.push('reference written.length>=1');
    if (expected.retrieved.length < 1) missing.push('reference retrieved.length>=1');
    if (!(expected.consumedCount >= 1)) missing.push('reference consumedCount>=1');
    if (expected.consumedOnlyWarnings !== true) missing.push('reference consumedOnlyWarnings===true');
    if (expected.wroteCandidate !== false) missing.push('reference wroteCandidate===false');
    if (expected.candidatePath !== null) missing.push('reference candidatePath===null');
    if (expected.tip !== tipPin) missing.push('reference tip/PIN');
    if (!expected.consumed.every(entry => priorIsWarning(entry.prior))) {
      missing.push('reference consumed prior warning semantics');
    }

    const compare = readJson('post-write-proof-compare.json');
    assert.equal(compare.semanticMatch, true, `lifecycle semantic gap: ${missing.join(', ') || 'compare artifact mismatch'}`);
    assert.deepEqual(missing, [], `lifecycle semantic gap: ${missing.join(', ')}`);
    assert.equal(fresh.lifecycleAlreadyCovered, true, 'covered lifecycle must document STOP disposition');
    assert.equal(fresh.verdict, 'STOP', 'covered lifecycle is STOP / NO_PRODUCT_DELTA');
    assert.equal(fresh.tipPin, tipPin);
    assert.equal(fresh.summaryWroteCandidate, false);
    assert.equal(fresh.summaryCandidatePath, null);
    assert.equal(actual.consumed.length, actual.consumedCount);
    assert.equal(actual.consumedOnlyWarnings, true);
    assert.equal(actual.wroteCandidate, false);
    assert.equal(actual.candidatePath, null);
    assert.deepEqual(walk(fresh.runRoot).filter(file => /^freeze-candidate-.*\.md$/.test(path.basename(file))), []);
  });

  test('T-w14-pwlc-2: PIN, zero product delta, five-piece baselines, and FROZEN honesty hold', (t) => {
    assert.equal(STEAL_TIP_PIN, tipPin);
    const session = readJson('session-start.json');
    assert.equal(session.knife, knife);
    assert.equal(session.wave, 'wave14');
    assert.equal(session.knifeNumber, 3);
    assert.equal(session.pack, 'B');
    assert.equal(session.tipPin, tipPin);
    assert.equal(session.STEAL_TIP_PIN, tipPin);
    assert.equal(session.tipHead, tipPin);
    assert.equal(session.productWrites, 0);
    assert.equal(session.runtimeWrites, 0);
    assert.equal(session.selfClosed, false);
    assert.equal(session.freezeStatus, 'FROZEN / 开干');
    assert.equal(session.freezeLockSha256, freezeLockSha256);
    assert.equal(fs.readFileSync(path.join(out, 'tip-head.txt'), 'utf8').trim(), tipPin);

    const tip = tipHeadProbe('/workspace/dda-tip-r25');
    if (tip.ok) assert.equal(tip.head, tipPin, 'readable tip HEAD remains pinned');
    else t.diagnostic(`ENVIRONMENT skip: tip git HEAD (${tip.code}): ${tip.message}`);

    const beforeText = fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8');
    const afterText = fs.readFileSync(path.join(out, 'after-hashes.txt'), 'utf8');
    assert.equal(afterText, beforeText, 'after-hashes must be byte-identical to before-hashes');
    const before = parseHashes(beforeText);
    for (const [file, expected] of Object.entries(baseline)) {
      assert.equal(before[file], expected, `${file}: seeded five-piece baseline`);
    }
    for (const [file, expected] of Object.entries(before)) {
      assert.equal(sha256(fs.readFileSync(path.join(root, file))), expected, `${file}: product unchanged`);
    }

    const freeze = read(`freeze-offloop-${knife}.md`);
    const title = freeze.split('\n')[0] || '';
    const statusLine = freeze.split('\n').find(line => line.startsWith('- **状态：')) || '';
    const frozenHandoff = /FROZEN \/ (?:开干|SCAN READY)/.test(title)
      && /FROZEN \/ (?:开干|SCAN READY)/.test(statusLine);
    const closedPass = /CLOSED — PASS（(?:STOP \/ NO_PRODUCT_DELTA|NO_PRODUCT_DELTA)）/.test(title)
      && /CLOSED — PASS（(?:STOP \/ NO_PRODUCT_DELTA|NO_PRODUCT_DELTA)）/.test(statusLine);
    const scanStart = freeze.indexOf('## 3. 扫收');
    const scanSection = scanStart >= 0 ? freeze.slice(scanStart) : '';
    const independentCodexEvidence = /Codex 检验|独立 SCAN|Codex verify/.test(scanSection);
    assert.ok(frozenHandoff || (closedPass && independentCodexEvidence),
      'freeze must remain an honest FROZEN handoff or carry an independently evidenced Codex PASS closure');
    const lockStart = freeze.indexOf('## 0. 锁定\n');
    const lockEnd = freeze.indexOf('## 1. 不做', lockStart);
    assert.ok(lockStart >= 0 && lockEnd > lockStart, '§0 lock boundaries exist');
    assert.equal(sha256(freeze.slice(lockStart, lockEnd)), freezeLockSha256, '§0 lock remains byte-identical');

    const summary = readJson('summary.json');
    assert.equal(summary.knife, knife);
    assert.equal(summary.wave, 'wave14');
    assert.equal(summary.knifeNumber, 3);
    assert.equal(summary.pack, 'B');
    assert.equal(summary.tipPin, tipPin);
    assert.equal(summary.productWrites, 0);
    assert.equal(summary.runtimeWrites, 0);
    assert.equal(summary.mainOpenRouterCalls, 0);
    assert.equal(summary.liveBurns, 0);
    assert.deepEqual(summary.tests, { 'T-w14-pwlc-1': 'PASS', 'T-w14-pwlc-2': 'PASS' });
    assert.equal(summary.freezeStatus, 'FROZEN / SCAN READY');
    assert.equal(summary.freezeFileStatus, 'FROZEN / 开干');
    assert.equal(summary.selfClosed, false);
    assert.equal(summary.productHashesUnchanged, true);
    assert.equal(summary.freezeLockSha256, freezeLockSha256);
    assert.equal(summary.verdict, 'STOP');
    assert.equal(summary.lifecycleAlreadyCovered, true);
    assert.deepEqual(summary.doNotStartKnives, [
      'harness2-agent-miss-route-ledger-r1',
      'probe-compose-experience-prior-contract-r1',
    ]);
    assert.ok(fs.existsSync(path.join(out, 'focused.tap')));
  });
}
