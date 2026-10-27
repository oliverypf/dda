import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runDayloopSoft } from '../dayloop-soft.mjs';
import { runClosedHook } from '../on-closed.mjs';

const DRIVE = fileURLToPath(new URL('../../', import.meta.url));
const PIN = 'a9c0b357bb0340325a02b3b50378851e22ddb4d9';

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-dayloop-l1-bounded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runSoft(t, opts = {}) {
  const root = tempDir(t);
  return runDayloopSoft({
    fixture: 'soft-clean',
    tipSha: PIN,
    outDir: path.join(root, 'out'),
    softWorktreeDir: path.join(root, 'soft'),
    write: true,
    ...opts,
  });
}

function assertNoCandidate(summary, reason) {
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(summary.frozenWrites, 0);
  assert.ok(summary.results.length > 0, 'the L1 gate must be exercised');
  for (const result of summary.results) {
    assert.equal(result.adopt, false, result.hypothesis);
    assert.equal(result.wroteCandidate, false, result.hypothesis);
    assert.equal(result.l1.adopt, false, result.hypothesis);
    assert.equal(result.l1.reason, reason, result.hypothesis);
  }
  assert.equal(
    fs.readdirSync(summary.outDir).filter((name) => name.startsWith('freeze-candidate')).length,
    0,
  );
}

test('T-dl1-1: soft-clean defaults to bounded fixture L1 and records tip-pinned shipped EXPERIENCE', (t) => {
  const summary = runSoft(t);
  assert.equal(summary.ok, true);
  assert.equal(summary.l1Mode, 'fixture');
  assert.equal(summary.l1Bounded, true);
  assert.equal(summary.l1LiveRequested, false);
  assert.equal(summary.tipSha, PIN);
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(summary.frozenWrites, 0);

  assert.equal(summary.results.length, 3);
  assert.deepEqual(Object.fromEntries(summary.results.map((result) => [result.hypothesis, result.reason])), {
    'steal-post-amt-terminal-replan': 'shipped_duplicate',
    'post-dpr-sticky-execute': 'shipped_duplicate',
    'experience-poison-loop-lesson': 'experience_only',
  });
  for (const result of summary.results) {
    assert.equal(result.wroteCandidate, false);
    assert.equal(result.l1.skipped, false);
    assert.equal(result.l1.adopt, true);
    assert.equal(result.l1.tipShaBaseline, PIN);
    assert.match(result.l1.softTreeFileListHash, /^[a-f0-9]{64}$/);
    const body = fs.readFileSync(result.experiencePath, 'utf8');
    assert.match(body, /^# EXPERIENCE/m);
    assert.ok(body.includes(`**adopted_candidate**: no (${result.reason})`));
    assert.ok(body.includes(PIN));
    assert.ok(body.includes(result.l1.softTreeFileListHash));
  }
  assert.equal(fs.readdirSync(summary.outDir).filter((name) => name.startsWith('freeze-candidate')).length, 0);
});

test('T-dl1-2: live mode and alias reject missing or blank credentials with zero CANDIDATE', (t) => {
  for (const opts of [
    { l1Mode: 'live' },
    { l1Mode: 'live', model: 'fixture-model' },
    { l1Mode: 'live', jev: 'fixture-jev' },
    { l1Live: true, model: '  ', jev: 'fixture-jev' },
    { l1Live: true, model: 'fixture-model', jev: '  ' },
  ]) {
    const summary = runSoft(t, opts);
    assert.equal(summary.l1Mode, 'live');
    assert.equal(summary.l1Bounded, true);
    assert.equal(summary.l1LiveRequested, true);
    assertNoCandidate(summary, 'live_requires_model_jev');
    assert.ok(summary.results.every((result) => result.l1.rejected));
    assert.equal(fs.existsSync(summary.softWorktreeDir), false);
  }
});

test('T-dl1-3: path-anomaly and noop never invoke dayloop even with explicit live credentials', (t) => {
  for (const [runId, action] of [[99, 'path-anomaly'], [68, 'noop']]) {
    const root = tempDir(t);
    let dayloopCalls = 0;
    const missArgvs = [];
    const result = runClosedHook({
      runId,
      benchLogPath: path.join(DRIVE, `bench-log-run${runId}.md`),
      drive: root,
      outDir: path.join(root, 'out'),
      dayloopSoft: true,
      l1Live: true,
      model: 'fixture-model',
      jev: 'fixture-jev',
      dayloopRunner: () => {
        dayloopCalls += 1;
        return { wroteCandidate: false, frozenWrites: 0, results: [] };
      },
      invoker: (argv) => {
        missArgvs.push(argv);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.decision.action, action);
    assert.equal(result.dayloopInvoked, false);
    assert.equal(dayloopCalls, 0);
    assert.equal(missArgvs.length, action === 'path-anomaly' ? 1 : 0);
    if (action === 'path-anomaly') {
      assert.ok(missArgvs[0].includes('--path-anomaly'));
      assert.ok(missArgvs[0].includes('--allow-experience-only'));
      assert.ok(!missArgvs[0].includes('--l1-live'));
      assert.ok(!missArgvs[0].includes('--model'));
      assert.ok(!missArgvs[0].includes('--jev'));
    }
    assert.deepEqual(result.candidatePaths, []);
  }
});

test('T-dl1-4: explicit excess subjects reach the L1 bound rejection without truncation', (t) => {
  for (const l1Mode of ['fixture', 'sim', 'live']) {
    const l1Subjects = Object.freeze(['t3/a', 't3/b', 't3/c']);
    const summary = runSoft(t, {
      l1Mode,
      l1Subjects,
      model: 'fixture-model',
      jev: 'fixture-jev',
    });
    assert.equal(summary.l1Mode, l1Mode);
    assert.equal(summary.l1Bounded, true);
    assert.equal(summary.l1LiveRequested, l1Mode === 'live');
    assertNoCandidate(summary, 'bound_exceeded');
    assert.ok(summary.results.every((result) => result.l1.rejected));
    assert.equal(fs.existsSync(summary.softWorktreeDir), false);
    assert.deepEqual(l1Subjects, ['t3/a', 't3/b', 't3/c']);
  }
});

test('T-dl1-5: injected transportError and liveStatus stop bounded L1 with zero CANDIDATE', (t) => {
  for (const failure of [{ transportError: 402 }, { liveStatus: 'TRANSPORT' }]) {
    const l1Subjects = Object.freeze(['t3/a', 't3/b']);
    const summary = runSoft(t, {
      l1Live: true,
      model: 'fixture-model',
      jev: 'fixture-jev',
      l1Subjects,
      ...failure,
    });
    assert.equal(summary.l1Mode, 'live');
    assert.equal(summary.l1Bounded, true);
    assert.equal(summary.l1LiveRequested, true);
    assertNoCandidate(summary, 'transport');
    assert.equal(fs.existsSync(summary.softWorktreeDir), false);
    assert.deepEqual(l1Subjects, ['t3/a', 't3/b']);
  }
});

test('T-dl1-6: CLOSED MISS forwards explicit L1 mode, alias, model and jev to dayloop', (t) => {
  for (const l1Mode of ['sim', 'live']) {
    const root = tempDir(t);
    const requested = {
      l1Mode,
      l1Live: l1Mode === 'live',
      model: 'fixture-model',
      jev: 'fixture-jev',
    };
    const calls = [];
    const result = runClosedHook({
      runId: 60,
      benchLogPath: path.join(DRIVE, 'bench-log-run60.md'),
      drive: root,
      outDir: path.join(root, 'out'),
      dayloopSoft: true,
      tipSha: PIN,
      ...requested,
      dayloopRunner: (opts) => {
        calls.push(opts);
        return { wroteCandidate: false, frozenWrites: 0, results: [] };
      },
      invoker: () => assert.fail('MISS + dayloopSoft must use the dayloop runner'),
    });
    assert.equal(result.decision.action, 'miss');
    assert.equal(result.dayloopInvoked, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tipSha, PIN);
    for (const [key, value] of Object.entries(requested)) {
      assert.equal(calls[0][key], value, key);
    }
  }
});

test('T-dl1-7: dayloop CLI selects sim/live explicitly and rejects missing or bare live credentials', (t) => {
  const cli = fileURLToPath(new URL('../dayloop-soft.mjs', import.meta.url));
  const cases = [
    { args: ['--l1-sim'], mode: 'sim', accepted: true },
    {
      args: ['--l1-live', '--model', 'fixture-model', '--jev', 'fixture-jev'],
      mode: 'live',
      accepted: true,
    },
    { args: ['--l1-live'], mode: 'live', accepted: false },
    { args: ['--l1-live', '--model', '--jev', 'fixture-jev'], mode: 'live', accepted: false },
    { args: ['--l1-live', '--model', 'fixture-model', '--jev', '  '], mode: 'live', accepted: false },
  ];
  for (const { args, mode, accepted } of cases) {
    const root = tempDir(t);
    const stdoutPath = path.join(root, 'stdout');
    const stderrPath = path.join(root, 'stderr');
    const stdout = fs.openSync(stdoutPath, 'w');
    const stderr = fs.openSync(stderrPath, 'w');
    let child;
    try {
      // Every contrast uses existing local fixtures; no live transport is invoked.
      child = spawnSync(process.execPath, [
        cli,
        '--fixture', 'soft-clean',
        '--tip-sha', PIN,
        '--out-dir', path.join(root, 'out'),
        '--soft-worktree', path.join(root, 'soft'),
        ...args,
      ], { cwd: root, stdio: ['ignore', stdout, stderr] });
    } finally {
      fs.closeSync(stdout);
      fs.closeSync(stderr);
    }
    assert.ifError(child.error);
    const summary = JSON.parse(fs.readFileSync(stdoutPath, 'utf8'));
    assert.equal(summary.l1Mode, mode);
    assert.equal(summary.l1Bounded, true);
    assert.equal(summary.l1LiveRequested, mode === 'live');
    if (accepted) {
      assert.equal(child.status, 0, fs.readFileSync(stderrPath, 'utf8'));
      assert.equal(summary.wroteCandidate, false);
      assert.equal(summary.candidatePath, null);
      assert.equal(summary.frozenWrites, 0);
      assert.equal(summary.results.length, 3);
      assert.deepEqual(Object.fromEntries(summary.results.map((result) => [result.hypothesis, result.reason])), {
        'steal-post-amt-terminal-replan': 'shipped_duplicate',
        'post-dpr-sticky-execute': 'shipped_duplicate',
        'experience-poison-loop-lesson': 'experience_only',
      });
      assert.ok(summary.results.every((result) => !result.wroteCandidate && result.l1.adopt));
    } else {
      assert.notEqual(child.status, 0);
      assertNoCandidate(summary, 'live_requires_model_jev');
      assert.equal(fs.existsSync(summary.softWorktreeDir), false);
    }
  }
});
