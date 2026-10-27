import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertSoftSourceTransition } from '../out-sticky-host-note-promote-r1/assert-soft-source-transition.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'offloop/out-path-anomaly-compose-drift-closeout-r1');
const composeSha = 'd00f0ef03eb4c30cef9097534db52ee5b3e59acd355d7a204ce83a6beac76e8f';
const historicalSha = '92261e81b37510b3bfb5bfe6c0c95b2e4a07a0a21658ef946da62a9b591b105d';
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const protectedFiles = [
  'compose.mjs', 'soft-worktree.mjs', 'dayloop-soft.mjs',
  'experience.mjs', 'propose.mjs', 'on-closed.mjs',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('T-pacd-1: each sibling has one EXTERNAL section with current compose SHA and preserves history', () => {
  const siblings = [
    'path-anomaly-experience-consume-r1',
    'compose-soft-footer-contract-r1',
    'host-note-soft-align-pr82-r1',
    'wave5-closeout-cleanup-r1',
    'path-anomaly-experience-complete-r1',
    'steal-path-anomaly-candidate-r1',
    'path-anomaly-compose-drift-closeout-r1',
  ];
  for (const sibling of siblings) {
    const name = `bench-log-offloop-${sibling}.md`;
    const body = fs.readFileSync(path.join(root, name), 'utf8');
    const headings = [...body.matchAll(/^## EXTERNAL \/ 并行哈希[\t ]*$/gm)];
    assert.equal(headings.length, 1, `${name}: exactly one EXTERNAL heading`);
    const section = body.slice(headings[0].index + headings[0][0].length).split(/^## /m)[0];
    assert.ok(section.split('\n').some((line) => line.includes('compose.mjs') && line.includes(composeSha)),
      `${name}: EXTERNAL must link compose to the full current disk SHA`);
  }

  const host = fs.readFileSync(path.join(root, 'bench-log-offloop-host-note-soft-align-pr82-r1.md'), 'utf8');
  assert.ok(host.includes(`| \`compose.mjs\` | \`${historicalSha}\` | \`${historicalSha}\` | MATCH |`),
    'the historical host-note MATCH row must remain intact');
  const scope = JSON.parse(fs.readFileSync(path.join(root,
    'offloop/out-path-anomaly-experience-consume-r1/scope-hashes.json'), 'utf8'));
  const compose = scope.hashes.find(({ file }) => file === 'offloop/compose.mjs');
  assert.equal(compose.provided, historicalSha);
  assert.equal(compose.sessionStart, historicalSha);
  assert.equal(compose.final, composeSha);
  assert.equal(compose.unchangedSinceSessionStart, false);
  assert.equal(compose.matchesProvided, false);
  assert.equal(sha256(fs.readFileSync(path.join(root, 'offloop/compose.mjs'))), composeSha);
});

test('T-pacd-2: historical NO_PRODUCT_DELTA, reviewed later sticky transition, freeze lock and tip PIN', (t) => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(out, 'session-start.json'), 'utf8'));
  const integrity = JSON.parse(fs.readFileSync(path.join(out, 'source-integrity.json'), 'utf8'));
  const beforeText = fs.readFileSync(snapshot.beforeHashesPath, 'utf8');
  assert.equal(beforeText, fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8'));
  const before = Object.fromEntries(beforeText.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/)));
  assert.deepEqual(before, snapshot.provided);
  assert.equal(before['compose.mjs'], composeSha);
  assert.equal(integrity.productDelta, 'NO_PRODUCT_DELTA');
  assert.deepEqual(integrity.files.map(({ file }) => file).sort(),
    protectedFiles.map((name) => `offloop/${name}`).sort());
  for (const row of integrity.files) {
    const expected = before[path.basename(row.file)];
    assert.equal(row.provided, expected, `${row.file}: historical provided hash`);
    assert.equal(row.sessionStart, expected, `${row.file}: historical before hash`);
    assert.equal(row.after, expected, `${row.file}: historical after hash`);
    assert.equal(row.unchanged, true);
    assert.equal(row.writesByThisKnife, 0);
  }
  for (const name of protectedFiles) {
    const file = `offloop/${name}`;
    assert.equal(snapshot.files[file].sha256, before[name], `${file}: captured before any edit`);
    const expected = name === 'soft-worktree.mjs' ? assertSoftSourceTransition(before[name]) : before[name];
    assert.equal(sha256(fs.readFileSync(path.join(root, file))), expected,
      `${file}: current bytes preserve the historical pin or exact reviewed sticky transition`);
  }
  const freeze = fs.readFileSync(path.join(root, 'freeze-offloop-path-anomaly-compose-drift-closeout-r1.md'), 'utf8');
  const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
  assert.equal(sha256(lock), snapshot.freezeLockSha256, '§0 lock remains byte-identical');
  assert.deepEqual(integrity.freezeLock, {
    before: snapshot.freezeLockSha256, after: snapshot.freezeLockSha256, unchanged: true,
  });
  assert.equal(before.tip, tipPin);
  assert.equal(snapshot.tipHead, tipPin);
  assert.deepEqual(integrity.tip, { before: tipPin, after: tipPin, unchanged: true });
  const tip = '/workspace/dda-tip-r25';
  if (fs.existsSync(tip)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-pacd-tip-'));
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
});
