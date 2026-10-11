import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { HarnessFacade, optionsToArgs } from '../src/harness-facade.mjs';
import { EXIT_CODES } from '../../harness-model/src/index.mjs';

// A fake child process that emits the given stdout/stderr then closes. Lets us
// drive the facade without spawning the real runtime.
const fakeSpawnFactory = (recorder) => (nodeBinary, argv, options) => {
  recorder.calls.push({ nodeBinary, argv, options });
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { end() {} };
  child.kill = (signal) => { recorder.killed = signal; };
  // Emit close only after stdout has fully drained, mirroring a real child so
  // the facade sees all stdout before it parses the result.
  child.stdout.on('end', () => {
    child.emit('close', recorder.childExitCode ?? 0, null);
  });
  queueMicrotask(() => {
    for (const line of recorder.stdoutLines ?? []) {
      child.stdout.push(`${line}\n`);
    }
    if (recorder.stderr) child.stderr.push(recorder.stderr);
    child.stderr.push(null);
    child.stdout.push(null);
  });
  return child;
};

test('optionsToArgs builds kebab-case flags and skips falsey values', () => {
  assert.deepEqual(
    optionsToArgs({ prompt: 'hi', executionMode: 'READ_ONLY', resume: true, verbose: false, missing: undefined }),
    ['--prompt', 'hi', '--execution-mode', 'READ_ONLY', '--resume']
  );
});

test('invoke parses events and the final result, mapping to a stable exit code', async () => {
  const recorder = {
    calls: [],
    stdoutLines: [
      JSON.stringify({ type: 'runtime_event', schemaVersion: '1.0', runId: 'run-1', sequence: 1, kind: 'run.started', payload: {}, emittedAtMs: 0 }),
      JSON.stringify({ type: 'runtime_event', schemaVersion: '1.0', runId: 'run-1', sequence: 2, kind: 'runtime.phase', payload: { phase: 'PLANNING' }, emittedAtMs: 1 }),
      JSON.stringify({ ok: true, runId: 'run-1', state: 'SUCCEEDED' })
    ],
    childExitCode: 0
  };
  const facade = new HarnessFacade({ spawn: fakeSpawnFactory(recorder) });
  const outcome = await facade.invoke('task', { args: ['--prompt', 'x'], events: true });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.exitCode, EXIT_CODES.SUCCESS);
  assert.equal(outcome.events.length, 2);
  assert.equal(outcome.events[1].payload.phase, 'PLANNING');
  assert.equal(outcome.result.state, 'SUCCEEDED');
  // --events stdout appended when events requested.
  assert.ok(recorder.calls[0].argv.includes('--events'));
});

test('invoke is fail-closed: a non-ok result never reports ok/SUCCESS', async () => {
  const recorder = {
    calls: [],
    stdoutLines: [JSON.stringify({ ok: false, error: { code: 'APPROVAL_REQUIRED' } })],
    childExitCode: 1
  };
  const facade = new HarnessFacade({ spawn: fakeSpawnFactory(recorder) });
  const outcome = await facade.invoke('task', { args: [] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, EXIT_CODES.APPROVAL_DENIED);
});

test('invoke treats a missing result as PROTOCOL_ERROR, not success', async () => {
  const recorder = { calls: [], stdoutLines: [], childExitCode: 0 };
  const facade = new HarnessFacade({ spawn: fakeSpawnFactory(recorder) });
  const outcome = await facade.invoke('task', {});
  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, EXIT_CODES.PROTOCOL_ERROR);
});

test('a timeout kills the child and reports RUNTIME_ERROR (state unknown)', async () => {
  const recorder = { calls: [], killed: null };
  const slowSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.stdin = { end() {} };
    child.kill = (signal) => {
      recorder.killed = signal;
      // Emulate the OS reaping the killed child.
      queueMicrotask(() => {
        child.stdout.push(null);
        child.stderr.push(null);
        child.emit('close', null, 'SIGKILL');
      });
    };
    return child;
  };
  const facade = new HarnessFacade({ spawn: slowSpawn, defaultTimeoutMs: 20 });
  const outcome = await facade.invoke('task', {});
  assert.equal(outcome.timedOut, true);
  assert.equal(recorder.killed, 'SIGKILL');
  assert.equal(outcome.ok, false);
  assert.equal(outcome.exitCode, EXIT_CODES.RUNTIME_ERROR);
});

test('a spawn error maps to DEPENDENCY_ERROR', async () => {
  const erroringSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  };
  const facade = new HarnessFacade({ spawn: erroringSpawn });
  const outcome = await facade.invoke('health', {});
  assert.equal(outcome.exitCode, EXIT_CODES.DEPENDENCY_ERROR);
  assert.match(outcome.stderr, /ENOENT/);
});

test('task() requires a non-empty prompt and defaults to READ_ONLY without auto-approval', async () => {
  const recorder = { calls: [], stdoutLines: [JSON.stringify({ ok: true })], childExitCode: 0 };
  const facade = new HarnessFacade({ spawn: fakeSpawnFactory(recorder) });

  await assert.rejects(async () => facade.task({ prompt: '   ' }), TypeError);

  await facade.task({ prompt: 'inspect repo' });
  const argv = recorder.calls[0].argv;
  assert.ok(argv.includes('--execution-mode'));
  assert.equal(argv[argv.indexOf('--execution-mode') + 1], 'READ_ONLY');
  // The facade must never inject an approval decision of its own.
  assert.ok(!argv.includes('--approval-mode'));
});
