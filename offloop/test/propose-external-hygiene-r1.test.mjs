import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { freezeLifecycleHonest, benchLifecycleHonest } from './test-lifecycle-scan-closed-accept-r1.test.mjs';
import { probeTipHead } from './test-git-eperm-env-harden-r1.test.mjs';

const drive = fileURLToPath(new URL('../../', import.meta.url));
const HISTORICAL_PROPOSE = 'ab3046cdad220211c8e940cd408a6aa787d5b6bc4b8652eef45af2827aac90c0';
const CURRENT_PROPOSE = '08390e92bc5de89c5b29286b24c942e93ec5256f6fc20e643f9bf09b0ea5c411';
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const benchLogs = [
  'bench-log-offloop-dayloop-tip-soft-contrast-live-r1.md',
  'bench-log-offloop-agent-miss-path-product-audit-r1.md',
  'bench-log-offloop-t-dlors-tap-reporter-harden-r1.md',
  'bench-log-offloop-dgr-mid-reject-experience-structure-r1.md',
  'bench-log-offloop-compose-soft-footer-contract-r1.md',
  'bench-log-offloop-dayloop-opt-in-real-live-smoke-r1.md',
  'bench-log-offloop-path-anomaly-experience-consume-r1.md',
  'bench-log-offloop-propose-external-hygiene-r1.md',
];
const protectedProducts = [
  'propose.mjs',
  'candidate-archive.mjs',
  'compose.mjs',
  'soft-worktree.mjs',
  'dayloop-soft.mjs',
  'experience.mjs',
  'on-closed.mjs',
];

function read(relativePath) {
  return fs.readFileSync(path.join(drive, relativePath), 'utf8');
}

function sha256(relativePath) {
  return createHash('sha256').update(fs.readFileSync(path.join(drive, relativePath))).digest('hex');
}

test('T-peh-1: EXTERNAL footnotes preserve historical propose evidence and identify the current archive-wire hash', () => {
  for (const file of benchLogs) {
    const text = read(file);
    const headings = [...text.matchAll(/^## EXTERNAL \/ 并行哈希\s*$/gm)];
    assert.equal(headings.length, 1, `${file}: exactly one EXTERNAL section`);
    const section = text.slice(headings[0].index + headings[0][0].length).split(/^#{1,2} /m)[0];
    assert.ok(section.includes(HISTORICAL_PROPOSE), `${file}: retain historical/provided propose hash`);
    assert.match(section, /历史|provided/, `${file}: label historical evidence`);
    assert.match(section, /现盘/, `${file}: label present-day evidence`);
    assert.match(section, /EXTERNAL_DRIFT/, `${file}: classify external drift`);
    assert.match(section, /propose-archive-wire-r1/, `${file}: identify the source of drift`);
    assert.ok(section.split('\n').some((line) => line.includes('propose.mjs') && line.includes(CURRENT_PROPOSE)),
      `${file}: propose row or footnote must contain the full current sha`);
  }
  assert.equal(sha256('offloop/propose.mjs'), CURRENT_PROPOSE, 'footnotes must match current product bytes');

  const scope = JSON.parse(read('offloop/out-path-anomaly-experience-consume-r1/scope-hashes.json'));
  const rows = scope.hashes.filter((row) => row.file === 'offloop/propose.mjs');
  assert.equal(rows.length, 1, 'scope evidence must contain exactly one propose row');
  const [propose] = rows;
  const originalProvided = 'f39b437a20aae7f759451b684997ae74a9cb79f41121a50ec2c1516231748412';
  assert.equal(propose.provided, originalProvided, 'preserve original provided hash');
  assert.equal(propose.sessionStart, originalProvided, 'preserve original session-start hash');
  assert.equal(propose.final, CURRENT_PROPOSE, 'scope final names the current disk hash');
  assert.equal(propose.unchangedSinceSessionStart, false);
  assert.equal(propose.matchesProvided, false);
});

test('T-peh-2: NO_PRODUCT_DELTA preserves session hashes, tip PIN and the FROZEN scan boundary', (t) => {
  const sessionSnapshot = '/tmp/codex-propose-external-hygiene-r1/before-hashes.txt';
  const preservedSnapshot = path.join(drive, 'offloop/out-propose-external-hygiene-r1/before-hashes.txt');
  const snapshotPath = fs.existsSync(sessionSnapshot) ? sessionSnapshot : preservedSnapshot;
  const snapshot = fs.readFileSync(snapshotPath, 'utf8');
  assert.equal(fs.readFileSync(preservedSnapshot, 'utf8'), snapshot, 'artifact preserves the supplied before-hashes verbatim');
  const before = new Map();
  for (const line of snapshot.trim().split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+([a-f0-9]{40}|[a-f0-9]{64})$/);
    assert.ok(match, `invalid before-hashes row: ${line}`);
    assert.ok(!before.has(match[1]), `duplicate before-hashes row: ${match[1]}`);
    before.set(match[1], match[2]);
  }
  assert.equal(before.get('propose.mjs'), CURRENT_PROPOSE, 'session starts after archive-wire');
  for (const file of protectedProducts) {
    assert.match(before.get(file) ?? '', /^[a-f0-9]{64}$/, `${file}: baseline sha is required`);
    assert.equal(sha256(`offloop/${file}`), before.get(file), `${file}: unchanged from session start`);
  }
  assert.equal(before.get('tip'), PIN);
  assert.equal(STEAL_TIP_PIN, PIN);
  const tip = '/workspace/dda-tip-r25';
  const tipHead = probeTipHead(tip);
  if (tipHead.ok) assert.equal(tipHead.head, PIN, 'tip checkout HEAD remains pinned');
  else t.diagnostic(`ENVIRONMENT skip: tip git HEAD (${tipHead.code}): ${tipHead.message}; STEAL_TIP_PIN/snapshot pin checked`);

  const freeze = read('freeze-offloop-propose-external-hygiene-r1.md');
  assert.ok(freezeLifecycleHonest(freeze),
    'freeze must be FROZEN (Codex honesty) or independent SCAN CLOSED — PASS with NO_PRODUCT_DELTA');
  const bench = read('bench-log-offloop-propose-external-hygiene-r1.md');
  assert.ok(benchLifecycleHonest(bench),
    'bench must be FROZEN / SCAN READY or independent SCAN CLOSED — PASS with NO_PRODUCT_DELTA');
  assert.match(bench, /\bNO_PRODUCT_DELTA\b/);
});
