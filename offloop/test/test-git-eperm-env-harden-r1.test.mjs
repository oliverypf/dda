import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { freezeLifecycleHonest } from './test-lifecycle-scan-closed-accept-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'test-git-eperm-env-harden-r1';
const out = path.join(root, `offloop/out-${knife}`);
const tipPin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const freezeLockSha256 = '6aa65a20415e3b223e496de661637bb77bce175889190a372ad31bfcaffe0c5c';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));
const environmentCodes = new Set(['EPERM', 'ENOENT', 'ENOTDIR', 'EACCES', 'ETIMEDOUT']);
const environmentMessage = /not a git repository|spawnSync git EPERM|No such file|not a directory|permission denied|invalid gitfile format/i;

// Test-local only. Keep assertions outside this catch: readable wrong PINs/diffs must fail.
function probeTipGit(tipDir, args, runGit) {
  try {
    const output = runGit('git', ['-C', tipDir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      timeout: 30_000,
    });
    return { ok: true, output: output.trim() };
  } catch (error) {
    const code = [error.code, error.errno].find((value) => environmentCodes.has(value));
    const message = [error.message, error.stderr?.toString()].filter(Boolean).join('\n').trim();
    if (!code && !environmentMessage.test(message)) throw error;
    return { ok: false, environment: true, code: code ?? 'GIT_UNAVAILABLE', message };
  }
}

export function probeTipHead(tipDir, runGit = execFileSync) {
  const result = probeTipGit(tipDir, ['rev-parse', 'HEAD'], runGit);
  return result.ok ? { ok: true, head: result.output } : result;
}

export function probeTipStatus(tipDir, files, runGit = execFileSync) {
  const result = probeTipGit(tipDir, ['status', '--porcelain', '--', ...files], runGit);
  return result.ok ? { ok: true, porcelain: result.output } : result;
}

// Shared helpers must not register duplicate tests when imported by another test file.
if (process.execArgv.includes('--test-isolation=none')
    || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  test('T-tgeh-1: unavailable tip git is ENVIRONMENT; readable wrong PIN and dirty status still fail', (t) => {
    const fixture = fs.mkdtempSync(path.join(out, 'empty-shell-'));
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
    const runtimeFiles = ['runtime/src/plan-step-coordinator.mjs', 'runtime/src/task-recovery-controller.mjs'];
    const records = [];
    const failures = [
      ...['EPERM', 'ENOENT', 'ENOTDIR', 'EACCES', 'ETIMEDOUT'].map((code) => ({ code, message: `spawnSync git ${code}` })),
      { errno: 'EPERM', message: 'sandbox denied git' },
      { message: 'spawnSync git EPERM' },
      { message: 'Command failed', stderr: Buffer.from('fatal: not a git repository') },
      { message: 'No such file or directory' },
      { message: 'fatal: invalid gitfile format: .git' },
      { message: 'fatal: cannot read .git: Permission denied' },
    ];
    for (const failure of failures) {
      for (const operation of ['head', 'status']) {
        const runGit = (command, args, options) => {
          assert.equal(command, 'git');
          assert.deepEqual(args, ['-C', fixture, ...(operation === 'head'
            ? ['rev-parse', 'HEAD'] : ['status', '--porcelain', '--', ...runtimeFiles])]);
          assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
          assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
          assert.equal(options.encoding, 'utf8');
          assert.ok(options.timeout > 0 && options.timeout <= 30_000);
          throw Object.assign(new Error(failure.message), failure);
        };
        const result = operation === 'head'
          ? probeTipHead(fixture, runGit) : probeTipStatus(fixture, runtimeFiles, runGit);
        assert.equal(result.ok, false);
        assert.equal(result.environment, true, 'git availability is not product FAIL');
        assert.ok(result.code);
        assert.ok(result.message);
        records.push({ fixture: 'injected', operation, environmentSkip: true, ...result });
      }
    }

    // Real filesystem fixtures exercise empty .git directories and broken worktree pointers.
    const dotGit = path.join(fixture, '.git');
    for (const kind of ['empty-shell', 'missing-gitdir-target', 'empty-gitfile']) {
      if (kind === 'empty-shell') fs.mkdirSync(dotGit);
      else fs.writeFileSync(dotGit, kind === 'missing-gitdir-target' ? 'gitdir: missing-target\n' : '');
      const head = probeTipHead(fixture);
      const status = probeTipStatus(fixture, runtimeFiles);
      for (const [operation, result] of Object.entries({ head, status })) {
        assert.equal(result.ok, false, `${kind}: ${operation}`);
        assert.equal(result.environment, true, `${kind}: visible ENVIRONMENT degrade`);
        records.push({ fixture: kind, operation, environmentSkip: true, ...result });
      }
      fs.rmSync(dotGit, { recursive: true });
    }

    assert.deepEqual(probeTipHead(fixture, () => `${tipPin}\n`), { ok: true, head: tipPin });
    assert.deepEqual(probeTipStatus(fixture, runtimeFiles, () => ''), { ok: true, porcelain: '' });
    const wrongPin = probeTipHead(fixture, () => `${'0'.repeat(40)}\n`);
    assert.equal(wrongPin.ok, true, 'a readable mismatch is not an environment skip');
    assert.throws(() => assert.equal(wrongPin.head, tipPin, 'product FAIL: wrong PIN'), { code: 'ERR_ASSERTION' });
    const dirty = probeTipStatus(fixture, runtimeFiles, () => ` M ${runtimeFiles[0]}\n`);
    assert.equal(dirty.ok, true);
    assert.throws(() => assert.equal(dirty.porcelain, '', 'product FAIL: runtime diff'), { code: 'ERR_ASSERTION' });
    for (const error of [Object.assign(new Error('unexpected I/O failure'), { code: 'EIO' }), new Error('fatal: bad object HEAD')]) {
      assert.throws(() => probeTipHead(fixture, () => { throw error; }), (actual) => actual === error);
      assert.throws(() => probeTipStatus(fixture, runtimeFiles, () => { throw error; }), (actual) => actual === error);
    }
    fs.writeFileSync(path.join(out, 'environment-skip-demo.json'), `${JSON.stringify({
      knife, environmentSkip: true, records,
      wrongPinStillFails: true, dirtyStatusStillFails: true, unexpectedErrorsRethrown: true,
    }, null, 2)}\n`);
    t.diagnostic('ENVIRONMENT skip demo: EPERM/missing git/timeout/empty-shell; PIN, runtime diffs and unexpected errors still fail');
  });

  test('T-tgeh-2: live or durable tip PIN, all product hashes, lifecycle honesty and §0 lock stay fixed', (t) => {
    assert.equal(STEAL_TIP_PIN, tipPin);
    const session = readJson('session-start.json');
    assert.equal(session.knife, knife);
    assert.equal(session.STEAL_TIP_PIN, tipPin);
    assert.equal(session.tipHead, tipPin);
    assert.equal(session.productWrites, 0);
    assert.equal(session.runtimeWrites, 0);
    assert.equal(session.selfClosed, false);
    assert.equal(session.freezeLockSha256, freezeLockSha256);
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
    const products = fs.readdirSync(path.join(root, 'offloop')).filter((name) => name.endsWith('.mjs'))
      .map((name) => `offloop/${name}`).sort();
    assert.ok(products.length > 0, 'product inventory is nonempty');
    assert.deepEqual([...before.keys()].sort(), products, 'every product is covered by before-hashes');
    for (const [file, hash] of before) {
      assert.equal(sha256(fs.readFileSync(path.join(root, file))), hash, `${file}: unchanged from session start`);
    }
    assert.equal(fs.readFileSync(path.join(out, 'after-hashes.txt'), 'utf8'), beforeText);

    const freeze = fs.readFileSync(path.join(root, `freeze-offloop-${knife}.md`), 'utf8');
    assert.ok(freezeLifecycleHonest(freeze),
      'freeze must stay FROZEN (Codex handoff) or independent SCAN CLOSED — PASS');
    const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
    assert.equal(typeof lock, 'string', '§0 lock exists');
    assert.equal(sha256(lock), freezeLockSha256, '§0 lock remains byte-identical');
    const summary = readJson('summary.json');
    assert.equal(summary.knife, knife);
    assert.equal(summary.tipPin, tipPin);
    assert.equal(summary.productWrites, 0);
    assert.equal(summary.runtimeWrites, 0);
    assert.equal(summary.freezeStatus, 'FROZEN / SCAN READY');
    assert.equal(summary.selfClosed, false);
  });
}
