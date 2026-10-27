import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const OFFLOOP = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = path.join(OFFLOOP, 'test/fixtures');
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const CREDS = ['--model', 'M', '--jev', 'J'];
const CONTROLS = [
  { args: [], mode: 'fixture' },
  { args: CREDS, mode: 'fixture' },
  { args: ['--l1-mode', 'fixture', ...CREDS], mode: 'fixture' },
  { args: ['--l1-mode', 'sim'], mode: 'sim' },
  { args: ['--l1-sim'], mode: 'sim' },
  { args: ['--l1-live', ...CREDS], mode: 'live' },
  { args: ['--l1-sim', '--l1-live', ...CREDS], mode: 'live' },
  { args: ['--l1-live', '--l1-sim', ...CREDS], mode: 'live' },
];
const MISSING_CREDS = [
  [],
  ['--model', 'M'],
  ['--jev', 'J'],
  ['--model', '--jev', 'J'],
  ['--model', '  ', '--jev', 'J'],
  ['--model', 'M', '--jev', '  '],
];

function seed(t, kind = 'dayloop', verdict = 'MISS', notes = 'poison-loop') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-dayloop-cli-l1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'out');
  const softDir = path.join(root, 'soft');
  const guardPath = path.join(root, 'guard.cjs');
  const countsPath = path.join(root, 'network.jsonl');
  fs.writeFileSync(guardPath, `
const fs = require('node:fs');
const net = require('node:net');
const counts = { fetch: 0, socket: 0 };
globalThis.fetch = () => { counts.fetch++; throw new Error('forbidden network fetch'); };
net.Socket.prototype.connect = function () { counts.socket++; throw new Error('forbidden network socket'); };
process.on('exit', () => fs.appendFileSync(process.env.DCL1_NETWORK_COUNTS, JSON.stringify(counts) + '\\n'));
`);
  const fixture = {
    root, outDir, softDir, guardPath, countsPath,
    cli: path.join(OFFLOOP, 'dayloop-soft.mjs'),
    args: ['--fixture', 'soft-clean', '--tip-sha', PIN, '--out-dir', outDir, '--soft-worktree', softDir],
    kind,
  };
  if (kind === 'dayloop') return fixture;

  // on-closed derives DRIVE from its module location. Copy its unmodified source
  // into a temporary drive; all hook logs, JSONL and output stay inside this root.
  const modules = path.join(root, 'offloop');
  fs.mkdirSync(modules);
  fixture.cli = path.join(modules, 'on-closed.mjs');
  fs.copyFileSync(path.join(OFFLOOP, 'on-closed.mjs'), fixture.cli);
  fs.symlinkSync(path.join(OFFLOOP, 'ingest.mjs'), path.join(modules, 'ingest.mjs'));
  fixture.optionsPath = path.join(root, 'dayloop-options.json');
  fixture.missArgvPath = path.join(root, 'miss-argv.json');
  // The spy records the actual CLI-to-API options, then executes the real API.
  fs.writeFileSync(path.join(modules, 'dayloop-soft.mjs'), `
import fs from 'node:fs';
import { runDayloopSoft as real } from ${JSON.stringify(pathToFileURL(path.join(OFFLOOP, 'dayloop-soft.mjs')).href)};
export function runDayloopSoft(opts) {
  fs.writeFileSync(${JSON.stringify(fixture.optionsPath)}, JSON.stringify(opts));
  return real(opts);
}
`);
  fs.writeFileSync(path.join(modules, 'run-from-miss.mjs'), `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(fixture.missArgvPath)}, JSON.stringify(process.argv.slice(2)));
`);
  const benchLog = path.join(root, 'bench-log-run178.md');
  fs.writeFileSync(benchLog, `# Bench log — run178 CLI fixture

- **Tip**: \`${PIN}\`
- **Status**: CLOSED ${verdict}
- GATE: **${verdict}**

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run178a | t3-dcl1-a | **${verdict}** | ${notes} |
| t3/run178b | t3-dcl1-b | **${verdict}** | companion |
`);
  const benchDir = path.join(root, 'bench/t3');
  fs.mkdirSync(benchDir, { recursive: true });
  for (const cell of ['a', 'b']) {
    fs.copyFileSync(path.join(FIXTURES, 'e2e-soft-baseline.jsonl'), path.join(benchDir, `run178${cell}.jsonl`));
    fs.copyFileSync(path.join(FIXTURES, 'l1-soft-clean.jsonl'), path.join(benchDir, `run178${cell}-soft.jsonl`));
  }
  fixture.args = [
    '--bench-log', benchLog, '--run', '178', '--dayloop-soft', '--dayloop-fixture', 'soft-clean',
    '--tip-sha', PIN, '--out-dir', outDir, '--soft-worktree', softDir,
  ];
  return fixture;
}

function runCli(fixture, args) {
  const stdoutPath = path.join(fixture.root, 'stdout');
  const stderrPath = path.join(fixture.root, 'stderr');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  let child;
  try {
    child = spawnSync(process.execPath, [fixture.cli, ...fixture.args, ...args], {
      cwd: fixture.root,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${fixture.guardPath}`,
        DCL1_NETWORK_COUNTS: fixture.countsPath,
        OFFLOOP_DAYLOOP_SOFT: '',
        DDA_OFFLOOP_DAYLOOP_SOFT: '',
      },
      stdio: ['ignore', stdoutFd, stderrFd],
      timeout: 20_000,
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  const counts = fs.readFileSync(fixture.countsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(counts.length > 0, 'network guards must execute in each CLI child');
  for (const count of counts) assert.deepEqual(count, { fetch: 0, socket: 0 }, 'zero fetch/socket calls');
  return {
    status: child.status,
    stdout: fs.readFileSync(stdoutPath, 'utf8'),
    stderr: fs.readFileSync(stderrPath, 'utf8'),
  };
}

function runSummary(fixture, args) {
  const child = runCli(fixture, args);
  const output = JSON.parse(child.stdout);
  const summary = fixture.kind === 'dayloop' ? output : output.dayloopSummary;
  assert.equal(summary.phase, 'dayloop-soft');
  assert.equal(summary.l1Bounded, true);
  assert.equal(summary.tipSha, PIN);
  assert.ok(summary.results.length > 0, 'exercise actual bounded L1 gates');
  if (fixture.kind === 'on-closed') {
    assert.equal(output.action, 'miss');
    assert.equal(output.dayloopInvoked, true);
    assert.equal(summary.baselineSource, 'run');
    assert.equal(summary.baselineFallback, false);
    assert.equal(summary.softSource, 'run-pair');
    assert.equal(summary.softFallback, false);
  }
  return { ...child, output, summary };
}

function assertMode(summary, mode) {
  assert.equal(summary.l1Mode, mode);
  assert.equal(summary.l1LiveRequested, mode === 'live');
}

function assertStopped(fixture, summary, reason) {
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(summary.frozenWrites, 0);
  assert.equal(fs.existsSync(fixture.softDir), false, 'reject before soft worktree creation');
  assert.deepEqual(fs.readdirSync(fixture.outDir).filter((name) => name.startsWith('freeze-candidate')), []);
  for (const row of summary.results) {
    assert.equal(row.adopt, false);
    assert.equal(row.wroteCandidate, false);
    assert.equal(row.candidatePath, null);
    assert.equal(row.l1.adopt, false);
    assert.equal(row.l1.rejected, true);
    assert.equal(row.l1.reason, reason);
    assert.equal(row.l1.softWriteCount ?? 0, 0);
  }
}

test('T-dcl1-1: dayloop CLI forwards explicit live mode, subjects and credentials with zero network calls', (t) => {
  const fixture = seed(t);
  const result = runSummary(fixture, ['--l1-mode', 'live', '--l1-subjects', 't3/a,t3/b', ...CREDS]);
  assert.equal(result.status, 0, result.stderr);
  assertMode(result.summary, 'live');
  assert.deepEqual(result.summary.l1Subjects, ['t3/a', 't3/b']);
  assert.ok(result.summary.results.every((row) => row.l1.adopt && !row.l1.rejected));
  assert.equal(result.summary.frozenWrites, 0);

  // Exact a,b spelling reaches the existing family gate, proving the requested
  // subjects are forwarded rather than replaced with inferred t3 subjects.
  const mixed = seed(t);
  const rejected = runSummary(mixed, ['--l1-mode', 'live', '--l1-subjects', 'a,b', ...CREDS]);
  assertMode(rejected.summary, 'live');
  assert.deepEqual(rejected.summary.l1Subjects, ['a', 'b']);
  assertStopped(mixed, rejected.summary, 'subject_family_mismatch');
  t.diagnostic('fixture-backed live green: t3/a,t3/b; exact a,b preserves existing family rejection; fetch=0 socket=0');
});

test('T-dcl1-2: dayloop CLI preserves bounds, credential rejection, defaults and legacy aliases', (t) => {
  for (const mode of ['fixture', 'sim', 'live']) {
    const fixture = seed(t);
    const result = runSummary(fixture, ['--l1-mode', mode, '--l1-subjects', 't3/a, t3/b,t3/c', ...CREDS]);
    assert.notEqual(result.status, 0);
    assertMode(result.summary, mode);
    assert.deepEqual(result.summary.l1Subjects, ['t3/a', 't3/b', 't3/c'], 'never truncate explicit subjects');
    assertStopped(fixture, result.summary, 'bound_exceeded');
  }
  for (const credentials of MISSING_CREDS) {
    const fixture = seed(t);
    const result = runSummary(fixture, ['--l1-mode', 'live', '--l1-subjects', 't3/a,t3/b', ...credentials]);
    assert.notEqual(result.status, 0);
    assertMode(result.summary, 'live');
    assertStopped(fixture, result.summary, 'live_requires_model_jev');
  }
  for (const { args, mode } of CONTROLS) {
    const result = runSummary(seed(t), [...args, '--l1-subjects', 't3/a,t3/b']);
    assert.equal(result.status, 0, result.stderr);
    assertMode(result.summary, mode);
    assert.deepEqual(result.summary.l1Subjects, ['t3/a', 't3/b']);
    assert.ok(result.summary.results.every((row) => row.l1.adopt && !row.l1.rejected));
  }
  t.diagnostic('3 over-bound + 6 credential rejections: CANDIDATE=0, soft worktrees=0; 8 default/mode/alias controls; fetch=0 socket=0');
});

test('T-dcl1-3: on-closed CLI forwards mode, subjects and aliases into the real dayloop API', (t) => {
  for (const { args, mode } of [
    { args: ['--l1-mode', 'live', ...CREDS], mode: 'live' },
    ...CONTROLS,
  ]) {
    const fixture = seed(t, 'on-closed');
    const result = runSummary(fixture, [...args, '--l1-subjects', 't3/a, t3/b']);
    assert.equal(result.status, 0, result.stderr);
    assertMode(result.summary, mode);
    assert.deepEqual(result.summary.l1Subjects, ['t3/a', 't3/b']);
    assert.ok(result.summary.results.every((row) => row.l1.adopt && !row.l1.rejected));
    const options = JSON.parse(fs.readFileSync(fixture.optionsPath, 'utf8'));
    assert.deepEqual(options.l1Subjects, ['t3/a', 't3/b']);
    if (args.includes('--l1-mode')) {
      assert.equal(options.l1Mode, mode);
      assert.equal(options.l1Live, mode === 'live');
    }
    if (args.includes('--model')) {
      assert.equal(options.model, 'M');
      assert.equal(options.jev, 'J');
    }
    assert.equal(fs.existsSync(fixture.missArgvPath), false);
    assert.ok(result.output.logPath.startsWith(fixture.root + path.sep));
  }
  t.diagnostic('9 real CLOSED MISS CLI runs, option spy confirms forwarding; fixture-backed run-pair; fetch=0 socket=0');
});

test('T-dcl1-4: on-closed CLI rejects excess subjects and missing credentials; PASS never invokes dayloop', (t) => {
  for (const mode of ['fixture', 'sim', 'live']) {
    const fixture = seed(t, 'on-closed');
    const result = runSummary(fixture, ['--l1-mode', mode, '--l1-subjects', 't3/a,t3/b,t3/c', ...CREDS]);
    assertMode(result.summary, mode);
    const options = JSON.parse(fs.readFileSync(fixture.optionsPath, 'utf8'));
    assert.deepEqual(options.l1Subjects, ['t3/a', 't3/b', 't3/c']);
    assert.deepEqual(result.summary.l1Subjects, options.l1Subjects);
    assert.deepEqual(result.output.candidatePaths, []);
    assertStopped(fixture, result.summary, 'bound_exceeded');
  }
  for (const credentials of MISSING_CREDS) {
    const fixture = seed(t, 'on-closed');
    const result = runSummary(fixture, ['--l1-mode', 'live', ...credentials]);
    assertMode(result.summary, 'live');
    assert.deepEqual(result.output.candidatePaths, []);
    assertStopped(fixture, result.summary, 'live_requires_model_jev');
  }
  for (const [action, notes] of [['path-anomaly', 'agent_miss'], ['noop', 'clean']]) {
    const fixture = seed(t, 'on-closed', 'PASS', notes);
    const child = runCli(fixture, ['--l1-mode', 'live', '--l1-subjects', 't3/a,t3/b,t3/c', ...CREDS]);
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.action, action);
    assert.equal(result.dayloopInvoked, false);
    assert.deepEqual(result.candidatePaths, []);
    assert.equal(fs.existsSync(fixture.optionsPath), false);
    assert.equal(fs.existsSync(fixture.softDir), false);
    if (action === 'path-anomaly') {
      const argv = JSON.parse(fs.readFileSync(fixture.missArgvPath, 'utf8'));
      assert.ok(argv.includes('--path-anomaly'));
      assert.ok(argv.includes('--allow-experience-only'));
      for (const arg of ['--l1-mode', '--l1-subjects', '--l1-live', '--model', '--jev']) assert.ok(!argv.includes(arg));
    } else {
      assert.equal(result.invoked, false);
      assert.equal(fs.existsSync(fixture.missArgvPath), false);
    }
  }
  t.diagnostic('3 bound + 6 credential rejections: CANDIDATE=0; path-anomaly/noop dayloop=0; fetch=0 socket=0');
});

test('T-dcl1-5: both CLIs reject explicit-mode/alias conflicts in either order and malformed flag values', (t) => {
  for (const kind of ['dayloop', 'on-closed']) {
    const cases = [];
    for (const mode of ['fixture', 'sim', 'live']) {
      for (const alias of ['--l1-sim', '--l1-live']) {
        cases.push({ args: ['--l1-mode', mode, alias], message: /conflict|dual.flags/i });
        cases.push({ args: [alias, '--l1-mode', mode], message: /conflict|dual.flags/i });
      }
    }
    for (const args of [
      ['--l1-mode', '--l1-live'],
      ['--l1-mode', 'invalid', '--l1-sim'],
    ]) cases.push({ args, message: /conflict|dual.flags/i });
    for (const args of [
      ['--l1-mode', 'invalid'], ['--l1-mode', 'LIVE'], ['--l1-mode', ''],
      ['--l1-mode'],
      ['--l1-subjects'], ['--l1-subjects', '--l1-live'], ['--l1-subjects', '  '],
    ]) cases.push({ args, message: new RegExp(args[0]) });
    for (const { args, message } of cases) {
      const fixture = seed(t, kind);
      const child = runCli(fixture, args);
      assert.notEqual(child.status, 0, `${kind} must reject ${args.join(' ')}`);
      assert.match(child.stderr, message);
      assert.equal(fs.existsSync(fixture.outDir), false, 'parse rejection precedes work');
      assert.equal(fs.existsSync(fixture.softDir), false);
      if (kind === 'on-closed') assert.equal(fs.existsSync(fixture.optionsPath), false);
    }
  }
  t.diagnostic('28 conflict cases (all modes, both aliases, both orders, malformed dual flags) + 14 invalid/missing-value cases; no work started; fetch=0 socket=0');
});

test('T-dcl1-6: both CLI help texts document bounded subjects, explicit modes, credentials and conflicts', (t) => {
  for (const kind of ['dayloop', 'on-closed']) {
    const fixture = seed(t, kind);
    const child = runCli(fixture, ['--help']);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /--l1-mode fixture\|sim\|live/);
    assert.match(child.stdout, /--l1-subjects s1,s2/);
    assert.match(child.stdout, /--l1-sim/);
    assert.match(child.stdout, /--l1-live/);
    assert.match(child.stdout, /nonblank.*--model.*--jev|--model.*--jev.*nonblank/);
    assert.match(child.stdout, /subjects\s*≤\s*2|at most two subjects/);
    assert.match(child.stdout, /conflict.*reject|reject.*conflict/i);
    assert.equal(fs.existsSync(fixture.outDir), false);
  }
  t.diagnostic('both help contracts synchronized; fetch=0 socket=0');
});
