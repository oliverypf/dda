import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyStatefulEvent } from '../src/event-classification.mjs';
import { exitCodeForError, EXIT } from '../src/exit-codes.mjs';
import { ledgerPath, readOutcomeLedger, recordUnknownOutcome, OUTCOME_LEDGER_FILE } from '../src/outcome-ledger.mjs';
import { main } from '../src/main.mjs';

const capture = () => ({ text: '', write(chunk) { this.text += chunk; return true; } });

const isolatedEnv = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-nits-'));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    LANG: 'C',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache')
  };
  await mkdir(env.HOME, { recursive: true });
  return { root, env };
};

const run = async (args, env, extra = {}) => {
  const stdout = capture();
  const stderr = capture();
  const code = await main(args, { stdout, stderr, env, isTTY: false, disableSignals: true, ...extra });
  return { code, stdout: stdout.text, stderr: stderr.text };
};

test('classifyStatefulEvent flags pause signals and unknown run lifecycle kinds', () => {
  assert.equal(classifyStatefulEvent({ type: 'runtime_event', kind: 'run.started', payload: {} }).unsupported, false);
  assert.equal(classifyStatefulEvent({ type: 'runtime_event', kind: 'run.completed', payload: {} }).unsupported, false);
  assert.equal(classifyStatefulEvent({ type: 'runtime_event', kind: 'runtime.phase', payload: { phase: 'PLANNING' } }).unsupported, false);
  assert.equal(classifyStatefulEvent({ type: 'runtime_event', kind: 'tool.started', payload: {} }).unsupported, false);

  const pausedKind = classifyStatefulEvent({ type: 'runtime_event', kind: 'run.paused', payload: {} });
  assert.deepEqual(pausedKind, { unsupported: true, code: 'PAUSED_UNSUPPORTED' });

  const pausedState = classifyStatefulEvent({ type: 'runtime_event', kind: 'run.state_changed', payload: { state: 'PAUSED' } });
  assert.deepEqual(pausedState, { unsupported: true, code: 'PAUSED_UNSUPPORTED' });

  const unknownRun = classifyStatefulEvent({ type: 'runtime_event', kind: 'run.forked', payload: {} });
  assert.deepEqual(unknownRun, { unsupported: true, code: 'PROTOCOL_ERROR' });

  // A non-runtime object or non-run namespace is not a stateful signal.
  assert.equal(classifyStatefulEvent({ ok: true }).unsupported, false);
  assert.equal(classifyStatefulEvent({ type: 'runtime_event', kind: 'metrics.sampled', payload: {} }).unsupported, false);
});

test('PAUSED_UNSUPPORTED maps to the protocol-error exit code', () => {
  assert.equal(exitCodeForError('PAUSED_UNSUPPORTED'), EXIT.PROTOCOL_ERROR);
  assert.equal(exitCodeForError('PROTOCOL_ERROR'), EXIT.PROTOCOL_ERROR);
});

test('the outcome ledger round-trips and coerces unknown states', async () => {
  const { root } = await isolatedEnv();
  const store = ledgerPath(join(root, 'data'));
  assert.equal(store.endsWith(OUTCOME_LEDGER_FILE), true);
  assert.deepEqual(await readOutcomeLedger(store), []);

  await recordUnknownOutcome(store, { state: 'UNKNOWN', reason: 'CLI_TIMEOUT', runId: 'run-1', command: 'task', timeoutMs: 500 });
  await recordUnknownOutcome(store, { state: 'CANCELLED', reason: 'SIGINT_NO_TERMINAL', runId: 'run-2', command: 'task' });
  // An out-of-range state falls back to UNKNOWN rather than being dropped.
  await recordUnknownOutcome(store, { state: 'BOGUS', reason: 'x', runId: 'run-3' });

  const records = await readOutcomeLedger(store);
  assert.equal(records.length, 3);
  assert.equal(records[0].state, 'UNKNOWN');
  assert.equal(records[0].timeoutMs, 500);
  assert.equal(records[1].state, 'CANCELLED');
  assert.equal(records[2].state, 'UNKNOWN');
  assert.ok(records.every((record) => Number.isInteger(record.recordedAtMs)));
});

test('a CLI timeout records an UNKNOWN outcome that recovery surfaces', async (t) => {
  const { env, root } = await isolatedEnv();
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  // A model endpoint that accepts the connection but never answers, so the
  // runtime blocks and the CLI timeout fires.
  const sockets = [];
  const server = createServer((request) => { sockets.push(request.socket); });
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dataDir = join(root, 'timeout-data');
  const taskEnv = {
    ...env,
    OPENCODE_GO_API_KEY: 'timeout-key',
    HMCODEX_MODEL_API_KEY_ENV: 'OPENCODE_GO_API_KEY',
    HMCODEX_MODEL_ENDPOINT: `http://127.0.0.1:${port}/chat/completions`,
    HMCODEX_JEV_ENABLED: '0'
  };
  const timedOut = await run([
    'task', '--workspace', workspace, '--prompt', 'hang please', '--format', 'jsonl',
    '--data-dir', dataDir, '--timeout-ms', '1500'
  ], taskEnv);
  assert.equal(timedOut.code, EXIT.RUNTIME_ERROR, timedOut.stdout + timedOut.stderr);
  const lines = timedOut.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const unknown = lines.find((line) => line.ok === false && line.error?.code === 'TASK_RESULT_UNKNOWN');
  assert.ok(unknown, timedOut.stdout);
  assert.equal(unknown.state, 'UNKNOWN');

  const ledger = JSON.parse(await readFile(ledgerPath(dataDir), 'utf8'));
  assert.equal(ledger.records.length >= 1, true);
  assert.equal(ledger.records.at(-1).state, 'UNKNOWN');
  assert.equal(ledger.records.at(-1).reason, 'CLI_TIMEOUT');

  const recovered = await run(['recovery', '--format', 'jsonl', '--data-dir', dataDir], taskEnv);
  assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
  const report = JSON.parse(recovered.stdout.trim().split('\n').filter(Boolean).at(-1));
  assert.equal(report.ok, true);
  assert.equal(report.cliUnknownOutcomeCount >= 1, true);
  assert.equal(report.cliUnknownOutcomes.some((record) => record.state === 'UNKNOWN' && record.reason === 'CLI_TIMEOUT'), true);
});
