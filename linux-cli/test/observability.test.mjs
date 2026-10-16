import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnFetchablePort } from '../../runtime/test/helpers/listen-loopback.mjs';
import { createTaskProgress, summarizeTaskEvents } from '../../runtime/src/task-harness.mjs';
import { rebuildFailedTaskResult } from '../src/exit-codes.mjs';
import { main } from '../src/main.mjs';

// --- Unit: rebuilt failed task line keeps harness.recovery (declined path) ---

test('rebuildFailedTaskResult keeps harness.recovery on declined final line', () => {
  const event = {
    ok: false,
    runId: 'run-declined-1',
    error: 'PLAN_STEP_FAILED:execute:FAIL',
    harness: {
      heartbeats: 1,
      toolResults: 0,
      recovery: {
        failureClass: 'APPROVAL_EXPIRED',
        nextAction: 'REQUEST_APPROVAL_AGAIN',
        advice: 're-request',
        replayWrites: false
      }
    }
  };
  const rebuilt = rebuildFailedTaskResult(event, { approvalDeclined: true });
  assert.equal(rebuilt.ok, false);
  assert.equal(rebuilt.runId, 'run-declined-1');
  assert.equal(rebuilt.approval, 'DECLINED');
  assert.equal(rebuilt.error.code, 'PLAN_STEP_FAILED:execute:FAIL');
  assert.equal(rebuilt.harness.recovery.failureClass, 'APPROVAL_EXPIRED');
  assert.equal(rebuilt.harness.heartbeats, 1);
});

test('rebuildFailedTaskResult omits harness when runtime did not send one', () => {
  const rebuilt = rebuildFailedTaskResult(
    { ok: false, runId: 'run-x', error: 'RUNTIME_ERROR' },
    { approvalDeclined: false }
  );
  assert.equal(rebuilt.approval, undefined);
  assert.equal(rebuilt.harness, undefined);
  assert.equal(rebuilt.error.code, 'RUNTIME_ERROR');
});

// --- Shape agents parse: harness.progress payload vs supervise status ---

test('harness.progress / supervise status expose failureClass at documented paths', () => {
  // harness.progress event: agents read payload.recovery.failureClass
  const progress = createTaskProgress();
  progress.observe({ kind: 'run.failed', payload: { code: 'TOOL_LOOP_LIMIT' } });
  const snapshot = progress.snapshot();
  assert.equal(snapshot.recovery.failureClass, 'TOOL_LOOP_LIMIT');
  const progressEvent = {
    type: 'runtime_event',
    kind: 'harness.progress',
    runId: 'run-shape-1',
    payload: snapshot
  };
  assert.equal(progressEvent.payload.recovery.failureClass, 'TOOL_LOOP_LIMIT');

  // supervise status returns summarizeTaskEvents(...) — top-level recovery.failureClass
  const status = summarizeTaskEvents([
    JSON.stringify({ kind: 'run.failed', payload: { code: 'APPROVAL_DENIED' } })
  ].join('\n'));
  assert.equal(status.recovery.failureClass, 'APPROVAL_EXPIRED');

  // Final / CLI rebuilt line: harness.recovery.failureClass
  const finalLine = rebuildFailedTaskResult({
    ok: false,
    runId: 'run-shape-1',
    error: 'TOOL_LOOP_LIMIT',
    harness: snapshot
  });
  assert.equal(finalLine.harness.recovery.failureClass, 'TOOL_LOOP_LIMIT');
});

// --- E2E: declined path exit 5 + approval DECLINED; final line keeps harness when present ---

const sse = (chunks) => [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), 'data: [DONE]'].join('\n\n') + '\n\n';

async function declinedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dda-obs-declined-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# fixture\n');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      const args = JSON.stringify({ command: process.execPath, args: ['-e', 'process.stdout.write("x")'] });
      response.end(sse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_shell', type: 'function', function: { name: 'shell.execute', arguments: args } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ]));
      return;
    }
    response.end(sse([
      { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listenOnFetchablePort(server);
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    LANG: 'C',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    DDA_TEST_MODEL_KEY: 'obs-fixture-key',
    DDA_MODEL_API_KEY_ENV: 'DDA_TEST_MODEL_KEY',
    DDA_MODEL_ENDPOINT: `http://127.0.0.1:${port}/chat/completions`,
    DDA_JEV_ENABLED: '0',
    DDA_LEASE_CAPABILITIES: 'shell.execute',
    DDA_LEASE_COMMANDS: 'node'
  };
  await mkdir(env.HOME, { recursive: true });
  return {
    env,
    args: [
      'task', '--workspace', workspace, '--prompt', 'run the shell check', '--format', 'jsonl',
      '--execution-mode', 'CONTROLLED', '--approval-mode', 'deny',
      '--data-dir', join(root, 'dda-data'), '--timeout-ms', '60000'
    ]
  };
}

test('CONTROLLED deny: exit 5 + approval DECLINED; rebuilt final keeps harness when runtime sent it', async (t) => {
  const f = await declinedFixture(t);
  const stdout = { text: '', write(chunk) { this.text += chunk; return true; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; return true; } };
  const code = await main(f.args, { stdout, stderr, env: f.env, isTTY: false, disableSignals: true });
  assert.equal(code, 5, stdout.text + stderr.text);
  const lines = stdout.text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const final = lines.at(-1);
  assert.equal(final.ok, false);
  assert.equal(final.approval, 'DECLINED');
  assert.ok(final.runId);
  // Runtime attaches harness on the ok:false final object; CLI rebuild must keep it.
  assert.ok(final.harness && typeof final.harness === 'object', JSON.stringify(final));
  // recovery is optional on PLAN_STEP_FAILED deny; when present it must survive rebuild.
  if (final.harness.recovery) {
    assert.equal(typeof final.harness.recovery.failureClass, 'string');
  }
});
