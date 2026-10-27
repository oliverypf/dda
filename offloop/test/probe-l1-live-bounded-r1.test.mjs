import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { probeL1 } from '../probe.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const cli = fileURLToPath(new URL('../probe-l1.mjs', import.meta.url));
const tipShaBaseline = 'a9c0b357bb0340325a02b3b50378851e22ddb4d9';
const hypothesis = {
  id: 'H-l1live',
  slug: 'post-dpr-sticky-execute',
  title: 'Sticky PTE after DPR',
  probeKind: 'soft_or_latch_md',
  class: 'latch',
};

function liveOptions() {
  return {
    enabled: true,
    mode: 'live',
    model: 'fixture-model',
    jev: 'fixture-jev',
    subjects: ['t3/a', 't3/b'],
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: tipShaBaseline,
      exitOk: true,
      summaryOk: true,
      verificationPass: false,
    },
    softLayer: {
      jsonlPaths: [path.join(fixtures, 'l1-soft-clean.jsonl')],
      exitOk: true,
      summaryOk: true,
      verificationPass: true,
    },
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offloop-l1-live-bounded-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runCli(t, args, cwd) {
  const dir = tempDir(t);
  const stdoutPath = path.join(dir, 'stdout');
  const stderrPath = path.join(dir, 'stderr');
  const stdout = fs.openSync(stdoutPath, 'w');
  const stderr = fs.openSync(stderrPath, 'w');
  let result;
  try {
    // File descriptors also support sandboxes that disallow piped child stdio.
    result = spawnSync(process.execPath, args, { cwd, stdio: ['ignore', stdout, stderr] });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  assert.ifError(result.error);
  return {
    ...result,
    stdout: fs.readFileSync(stdoutPath, 'utf8'),
    stderr: fs.readFileSync(stderrPath, 'utf8'),
  };
}

function guardedOptions(dir) {
  const opts = liveOptions();
  for (const side of [opts.baseline, opts.softLayer]) {
    side.jsonlPaths = [path.join(dir, 'must-not-read.jsonl')];
    Object.defineProperty(side, 'events', {
      get() {
        assert.fail('preflight must finish before reading events');
      },
    });
  }
  opts.prepareSoftWorktree = true;
  opts.softWorktreeDir = path.join(dir, 'must-not-write');
  return opts;
}

function assertHeader(result, opts) {
  assert.ok(result.summary?.header, 'summary.header must be available');
  assert.deepEqual(result.summary.header, result.header);
  assert.equal(result.header.model, opts.model || null);
  assert.equal(result.header.jev, opts.jev || null);
  assert.equal(result.header.tipShaBaseline, opts.baseline?.tipSha || '2258685ce9793639ebc9698c8961dcedccf6e49b');
  assert.ok(Object.hasOwn(result.header, 'softTreeFileListHash'));
}

test('T-l1live-1: explicit live credentials and fixture paths produce reproducible bounded contrast', () => {
  for (const subjects of [['t3/a'], ['t3/a', 't3/b']]) {
    const opts = { ...liveOptions(), subjects };
    const result = probeL1(hypothesis, opts);
    assert.deepEqual(probeL1(hypothesis, opts), result);
    assert.equal(result.mode, 'live');
    assert.equal(result.skipped, false);
    assert.equal(result.adopt, true);
    assert.equal(result.falseWin, false);
    assert.equal(result.summary.baseline.poisonLoopCount, 1);
    assert.equal(result.summary.contrast.poisonLoopCount, 0);
    assert.equal(result.summary.contrast.softLayerOnly, true);
    assert.deepEqual(result.summary.subjects, subjects);
    assertHeader(result, opts);
    assert.equal(result.header.softTreeFileListHash, null);
  }
  const opts = liveOptions();
  delete opts.baseline.tipSha;
  assertHeader(probeL1(hypothesis, opts), opts);
});

test('T-l1live-1b: live soft worktree reports its hash and rejects runtime targets without writes', (t) => {
  const dir = tempDir(t);
  const opts = { ...liveOptions(), softWorktreeDir: path.join(dir, 'soft') };
  const result = probeL1(hypothesis, opts);
  assert.equal(result.adopt, true);
  assertHeader(result, opts);
  assert.match(result.header.softTreeFileListHash, /^[a-f0-9]{64}$/);
  assert.equal(result.header.softTreeFileListHash, result.softWorktree.fileListHash);
  assert.deepEqual(result.softWorktree.fileList.map((f) => f.relPath), ['latch-md/latch-draft.md']);
  assert.ok(fs.existsSync(path.join(opts.softWorktreeDir, 'latch-md/latch-draft.md')));

  const rejectedOpts = guardedOptions(dir);
  const rejected = probeL1({ ...hypothesis, targetPaths: ['runtime/topology.mjs'] }, rejectedOpts);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.adopt, false);
  assert.equal(rejected.reason, 'hard_gate_path');
  assertHeader(rejected, rejectedOpts);
  assert.equal(fs.existsSync(rejectedOpts.softWorktreeDir), false);
});

test('T-l1live-2: live false-win never adopts', () => {
  const opts = liveOptions();
  opts.softLayer.jsonlPaths = [path.join(fixtures, 'l1-soft-false-win.jsonl')];
  const result = probeL1(hypothesis, opts);
  assert.equal(result.mode, 'live');
  assert.equal(result.falseWin, true);
  assert.equal(result.adopt, false);
  assert.ok(result.summary.contrast.poisonLoopCount > 0);
  assert.equal(result.contrast.win.falseWin, true);
  assertHeader(result, opts);
});

test('T-l1live-2b: missing credentials, excess subjects, and mixed live families reject before work', (t) => {
  const dir = tempDir(t);
  const cases = [
    { values: { model: undefined, jev: undefined }, reason: 'live_requires_model_jev' },
    { values: { model: undefined }, reason: 'live_requires_model_jev' },
    { values: { jev: undefined }, reason: 'live_requires_model_jev' },
    { values: { model: '' }, reason: 'live_requires_model_jev' },
    { values: { jev: '   ' }, reason: 'live_requires_model_jev' },
    ...['live', 'fixture', 'sim'].map((mode) => ({
      values: { mode, subjects: ['t3/a', 't3/b', 't3/c'] },
      reason: 'bound_exceeded',
    })),
    { values: { subjects: ['t3/a', 't4/b'] }, reason: 'subject_family_mismatch' },
  ];
  for (const { values, reason } of cases) {
    const opts = { ...guardedOptions(dir), ...values };
    const originalSubjects = [...opts.subjects];
    const result = probeL1(hypothesis, opts);
    assert.equal(result.rejected, true, reason);
    assert.equal(result.adopt, false, reason);
    assert.equal(result.falseWin, false, reason);
    if (reason === 'subject_family_mismatch') {
      assert.ok(result.reason === reason || result.boundExceeded === true);
    } else {
      assert.equal(result.reason, reason);
    }
    if (reason === 'bound_exceeded') assert.equal(result.boundExceeded, true);
    assert.deepEqual(result.summary.subjects, originalSubjects);
    assert.deepEqual(opts.subjects, originalSubjects);
    assert.ok(result.summary.header);
    assert.equal(fs.existsSync(opts.softWorktreeDir), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('T-l1live-3: injectable transport failures preserve subjects and header without reads or writes', (t) => {
  const dir = tempDir(t);
  const failures = [
    ...[402, '402', true, new Error('402 payment required')].map((transportError) => ({ transportError })),
    ...['TRANSPORT', 'transport', 'TrAnSpOrT', 'timeout', 'TIMEOUT', 402, '402'].map((liveStatus) => ({ liveStatus })),
  ];
  for (const failure of failures) {
    for (const subjects of [[], ['t3/a'], ['t3/a', 't3/b']]) {
      const opts = { ...guardedOptions(dir), ...failure, subjects };
      const result = probeL1(hypothesis, opts);
      assert.equal(result.transport, 'TRANSPORT');
      assert.equal(result.adopt, false);
      assert.equal(result.falseWin, false);
      assertHeader(result, opts);
      assert.equal(result.header.softTreeFileListHash, null);
      assert.deepEqual(result.summary.subjects, subjects);
      assert.deepEqual(opts.subjects, subjects);
      assert.equal(fs.existsSync(opts.softWorktreeDir), false);
      assert.deepEqual(fs.readdirSync(dir), []);
    }
  }
});

test('T-l1live-default: live is explicit and the default remains skipped', (t) => {
  for (const opts of [{}, { mode: 'live', model: 'fixture-model', jev: 'fixture-jev' }]) {
    const result = probeL1(hypothesis, opts);
    assert.equal(result.skipped, true);
    assert.equal(result.enabled, false);
    assert.equal(result.adopt, null);
  }
  const opts = liveOptions();
  delete opts.mode;
  assert.equal(probeL1(hypothesis, opts).mode, 'fixture');
  assert.equal(probeL1(hypothesis, { enabled: true, model: 'fixture-model', jev: 'fixture-jev' }).mode, 'sim');
  const cliResult = runCli(t, [cli]);
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.equal(JSON.parse(cliResult.stdout).skipped, true);
});

test('T-l1live-cli-1: missing, bare, or blank live credential flags exit 2 before soft worktree writes', (t) => {
  const dir = tempDir(t);
  const invalidArgs = [
    [],
    ['--model', 'fixture-model'],
    ['--jev', 'fixture-jev'],
    ['--model'],
    ['--jev'],
    ['--model', '--jev', 'fixture-jev'],
    ['--jev', '--model', 'fixture-model'],
    ['--model', '', '--jev', 'fixture-jev'],
    ['--model', 'fixture-model', '--jev', '   '],
  ];
  for (const args of invalidArgs) {
    const result = runCli(t, [
      cli,
      '--live',
      '--prepare-soft',
      '--soft-worktree', path.join(dir, 'must-not-write'),
      '--baseline', path.join(dir, 'must-not-read.jsonl'),
      ...args,
    ], dir);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /live_requires_model_jev|--model.*--jev/i);
    assert.equal(result.stdout, '');
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('T-l1live-cli-2: valid live fixture CLI emits contrast and rejects excess or mixed subjects', (t) => {
  const args = [
    cli,
    '--live', '--model', 'fixture-model', '--jev', 'fixture-jev',
    '--baseline', path.join(fixtures, 'poison-loop-yes.jsonl'),
    '--soft', path.join(fixtures, 'l1-soft-clean.jsonl'),
  ];
  for (const subjects of [['t3/a', 't3/b'], ['t3/a', 't3/b', 't3/c'], ['t3/a', 't4/b']]) {
    const child = runCli(t, [...args, ...subjects.flatMap((s) => ['--subject', s])]);
    const result = JSON.parse(child.stdout);
    assertHeader(result, { model: 'fixture-model', jev: 'fixture-jev' });
    assert.deepEqual(result.summary.subjects, subjects);
    if (subjects.length === 2 && subjects.every((s) => s.startsWith('t3/'))) {
      assert.equal(child.status, 0, child.stderr);
      assert.equal(result.adopt, true);
      assert.equal(result.summary.contrast.softLayerOnly, true);
    } else {
      assert.equal(child.status, 2, child.stderr);
      assert.equal(result.rejected, true);
      assert.equal(result.adopt, false);
    }
  }
});
