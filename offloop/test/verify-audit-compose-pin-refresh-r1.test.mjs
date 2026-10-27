import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertSoftSourceTransition } from '../out-sticky-host-note-promote-r1/assert-soft-source-transition.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const audit = `${root}out-audit-run172-t2-312-r1/`;
const evidence = `${root}offloop/out-verify-audit-compose-pin-refresh-r1/`;
const composePath = `${root}offloop/compose.mjs`;
const softPath = `${root}offloop/soft-worktree.mjs`;
const oldSoftPin = '29ee59de479085d6599ef1162ec4a7e626a29151b9e3823fc355e5f213e3e610';
const oldComposePin = '92261e81b37510b3bfb5bfe6c0c95b2e4a07a0a21658ef946da62a9b591b105d';
const composePin = 'd00f0ef03eb4c30cef9097534db52ee5b3e59acd355d7a204ce83a6beac76e8f';
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

test('T-vacp-1: historical refresh stays intact and reviewed current overlay replay exits 0', t => {
  const manifest = readJson(`${audit}source-manifest.json`);
  const before = readJson(`${evidence}source-manifest-before.json`);
  const compose = manifest.files.find(entry => entry.path === composePath);
  assert.equal(compose.sha256, composePin);
  assert.equal(sha256(composePath), composePin);
  assert.equal(compose.bytes, 15482);

  const refreshPaths = new Set([
    composePath,
    `${root}offloop/dayloop-soft.mjs`,
    `${root}freeze-offloop-audit-run172-t2-312-r1.md`,
  ]);
  const expected = structuredClone(before);
  for (const entry of expected.files) {
    if (refreshPaths.has(entry.path)) {
      const data = readFileSync(entry.path);
      entry.sha256 = createHash('sha256').update(data).digest('hex');
      entry.bytes = data.length;
    }
  }
  assert.equal(expected.files.filter(entry => refreshPaths.has(entry.path)).length, 3);
  assert.deepEqual(manifest, expected, 'only the three proven hash/byte drifts may change');
  const softEntries = manifest.files.filter(entry => entry.path === softPath);
  assert.equal(softEntries.length, 1);
  const [historicalSoft] = softEntries;
  assert.equal(historicalSoft.sha256, oldSoftPin);
  assert.equal(historicalSoft.bytes, 14176);
  const currentSoftPin = assertSoftSourceTransition(historicalSoft.sha256);
  const currentSoftBytes = readFileSync(softPath).length;
  for (const entry of manifest.files) {
    const soft = entry.path === softPath;
    assert.equal(sha256(entry.path), soft ? currentSoftPin : entry.sha256, entry.path);
    assert.equal(readFileSync(entry.path).length, soft ? currentSoftBytes : entry.bytes, entry.path);
  }
  assert.equal(manifest.pin, tipPin);
  assert.equal(manifest.tipStatusBefore, '?? runtime/node_modules\n');

  const copiedNames = ['verify-audit.sh', 'verify-audit.mjs', 'timeline.json', 'score-row.json', 'conclusion.md'];
  const preservedNames = [...copiedNames, 'source-manifest.json', 'audit-table.md',
    'tip-head-after.txt', 'tip-status-after.txt', 'recomputed-score.json', 'validation.json'];
  const originalBytes = new Map(preservedNames.map(name => [name, readFileSync(`${audit}${name}`)]));
  const temporaryRoot = mkdtempSync(`${tmpdir()}/sticky-vacp-current-replay-`);
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const replayAudit = `${temporaryRoot}/out-audit-run172-t2-312-r1/`;
  mkdirSync(replayAudit);
  symlinkSync(`${root}bench`, `${temporaryRoot}/bench`, 'dir');
  for (const name of copiedNames) {
    copyFileSync(`${audit}${name}`, `${replayAudit}${name}`);
    assert.equal(sha256(`${replayAudit}${name}`), sha256(`${audit}${name}`), `exact replay copy: ${name}`);
  }

  const overlay = structuredClone(manifest);
  const overlaySoft = overlay.files.find(entry => entry.path === softPath);
  overlaySoft.sha256 = currentSoftPin;
  overlaySoft.bytes = currentSoftBytes;
  const changedEntries = overlay.files.flatMap((entry, index) => {
    const original = manifest.files[index];
    const fields = [...new Set([...Object.keys(original), ...Object.keys(entry)])]
      .filter(key => entry[key] !== original[key]).sort();
    return fields.length ? [{ path: entry.path, fields }] : [];
  });
  assert.deepEqual(changedEntries, [{ path: softPath, fields: ['bytes', 'sha256'] }]);
  const restoredOverlay = structuredClone(overlay);
  restoredOverlay.files[overlay.files.indexOf(overlaySoft)] = historicalSoft;
  assert.deepEqual(restoredOverlay, manifest, 'capture metadata and all other historical entries stay intact');
  writeFileSync(`${replayAudit}source-manifest.json`, `${JSON.stringify(overlay, null, 2)}\n`);
  assert.deepEqual(readJson(`${replayAudit}source-manifest.json`), overlay);
  t.diagnostic('Current replay input: temporary manifest overlays only the reviewed sticky soft-worktree SHA/bytes; historical capture is unchanged.');

  const stdoutPath = `${temporaryRoot}/stdout.log`;
  const stderrPath = `${temporaryRoot}/stderr.log`;
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  let replay;
  try {
    replay = spawnSync('bash', [`${replayAudit}verify-audit.sh`], {
      cwd: temporaryRoot, encoding: 'utf8', stdio: ['ignore', stdoutFd, stderrFd],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 30_000,
    });
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
  const replayLog = `${readFileSync(stdoutPath, 'utf8')}\n${readFileSync(stderrPath, 'utf8')}`;
  assert.equal(replay.error, undefined, `replay spawn error: ${replay.error?.message}\n${replayLog}`);
  assert.equal(replay.status, 0, replayLog);
  for (const [name, bytes] of originalBytes) {
    assert.deepEqual(readFileSync(`${audit}${name}`), bytes, `historical audit file unchanged: ${name}`);
  }
  const validation = readJson(`${replayAudit}validation.json`);
  assert.equal(validation.conclusion, 'NO_PRODUCT_KNIFE');
  assert.deepEqual(validation.acceptance, { 'T-t2312-1': 'PASS', 'T-t2312-2': 'PASS' });
  assert.equal(validation.scorerReplayAllFieldsEqual, true);
  assert.equal(validation.productChanges, 0);
  assert.equal(validation.tipHeadBefore, tipPin);
  assert.equal(validation.tipHeadAfter, tipPin);
  assert.equal(validation.tipStatusAfter, manifest.tipStatusBefore);
  assert.deepEqual(validation.sourceAndProtectedHashes, overlay.files.map(entry => ({
    path: entry.path, sha256: entry.sha256, unchanged: true,
  })));
});

test('T-vacp-2: historical session provenance stays intact with only the reviewed later soft transition', () => {
  const before = new Map(readFileSync(`${evidence}before-hashes.txt`, 'utf8')
    .trim().split('\n').map(line => {
      const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
      assert.ok(match, 'session-before hash line must parse');
      return [match[2], match[1]];
    }));
  assert.equal(before.get(composePath), composePin);
  assert.equal(sha256(composePath), composePin);
  assert.equal(sha256(`${evidence}source-manifest-before.json`),
    before.get(`${audit}source-manifest.json`));
  for (const name of ['compose', 'soft-worktree', 'dayloop-soft', 'propose', 'path-signals', 'experience']) {
    const path = `${root}offloop/${name}.mjs`;
    assert.ok(before.has(path), `missing session-before hash: ${path}`);
    const expectedHash = path === softPath
      ? assertSoftSourceTransition(before.get(path)) : before.get(path);
    assert.equal(sha256(path), expectedHash, `unreviewed product bytes changed: ${path}`);
  }
  for (const entry of readJson(`${evidence}additional-before-hashes.json`)) {
    assert.equal(sha256(entry.path), entry.sha256, `protected bytes changed: ${entry.path}`);
    assert.equal(readFileSync(entry.path).length, entry.bytes, entry.path);
  }
  const notes = readFileSync(`${audit}audit-table.md`, 'utf8');
  for (const text of [oldComposePin, composePin, 'compose-soft-footer-contract-r1',
    'EXTERNAL', '本刀未改 compose.mjs 字节']) {
    assert.ok(notes.includes(text), `missing refresh provenance: ${text}`);
  }
  const conclusion = readFileSync(`${audit}conclusion.md`, 'utf8');
  assert.equal((conclusion.match(/Conclusion enum: \*\*NO_PRODUCT_KNIFE\*\*/g) || []).length, 1);
});
