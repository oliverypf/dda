import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ToolRegistry, toolRegistryPlugin } from '../src/tool-registry.mjs';
import { createTaskProgress } from '../src/task-harness.mjs';
import { exitCodeForError, messageForCode, rebuildFailedTaskResult } from '../../linux-cli/src/exit-codes.mjs';

const workspace = {
  granted: true, rootLabel: 'fixture', snapshotDigest: 'sha256:snapshot', entries: [], sections: []
};

const withEnv = async (t, vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return fn();
};

const runWithProvider = async (t, streamFactory, { onEvent } = {}) => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  let invokes = 0;
  registry.register({
    name: 'file.patch',
    description: 'patch',
    readOnly: false,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    handler: () => { invokes++; return { ok: true, action: 'patch_file', path: 'a.txt', beforeDigest: 'sha256:' + '0'.repeat(64), afterDigest: 'sha256:' + '1'.repeat(64), diff: '', bytesWritten: 1, contentDigest: 'sha256:' + '1'.repeat(64) }; }
  });
  const root = new Context();
  t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(cordisPlugin((ctx) => ctx.provide('modelProvider', {
    provider: 'fixture', protocol: 'fixture', model: 'transport-fixture',
    stream: streamFactory
  }), 'transport-fixture'));
  await root.plugin(taskRunnerPlugin);
  const events = [];
  const result = await root.taskRunner.run({
    prompt: 'do the work',
    workspace,
    mode: 'CONTROLLED',
    onEvent: (event) => { events.push(event); onEvent?.(event); }
  });
  return { result, events, invokes, messages: null };
};

test('T15 mid tool-call stream drop retries and never invokes the tool', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 2, DDA_MODEL_STREAM_RETRY_DELAY_MS: 0, DDA_MODEL_MAX_REQUESTS_PER_ROUND: 4 }, async () => {
    let attempts = 0;
    const { events, invokes } = await runWithProvider(t, async function* () {
      attempts++;
      if (attempts === 1) {
        yield { type: 'tool-call-delta', index: 0, id: 'c1', name: 'file.patch', argumentsDelta: '{"path":"a.txt"' };
        const err = new TypeError('terminated');
        err.transportPhase = 'STREAM';
        throw err;
      }
      yield { type: 'text-delta', text: 'finished without tools' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    assert.equal(invokes, 0);
    assert.equal(events.filter((e) => e.kind === 'tool.call_requested').length, 0);
    const retry = events.find((e) => e.kind === 'model.stream_retry');
    assert.ok(retry);
    assert.equal(retry.discardedToolCalls, 1);
    assert.equal(attempts, 2);
  });
});

test('T16 mid tool-call drop then successful re-emit invokes exactly once', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 2, DDA_MODEL_STREAM_RETRY_DELAY_MS: 0 }, async () => {
    let attempts = 0;
    const { events, invokes } = await runWithProvider(t, async function* () {
      attempts++;
      if (attempts === 1) {
        yield { type: 'tool-call', id: 'c1', name: 'file.patch', arguments: '{"path":"a.txt"}' };
        const err = new TypeError('terminated');
        err.transportPhase = 'STREAM';
        throw err;
      }
      if (attempts === 2) {
        yield { type: 'tool-call', id: 'c1', name: 'file.patch', arguments: '{"path":"a.txt"}' };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      // Later rounds after the tool result: finish the task.
      yield { type: 'text-delta', text: 'done' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    assert.equal(invokes, 1);
    assert.equal(events.filter((e) => e.kind === 'model.stream_retry').length, 1);
  });
});

test('T17 discarded text from failed attempt is not in final text', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 2, DDA_MODEL_STREAM_RETRY_DELAY_MS: 0 }, async () => {
    let attempts = 0;
    const { result, events } = await runWithProvider(t, async function* () {
      attempts++;
      if (attempts === 1) {
        yield { type: 'text-delta', text: 'PARTIAL_SHOULD_DISCARD' };
        const err = new TypeError('terminated');
        err.transportPhase = 'STREAM';
        throw err;
      }
      yield { type: 'text-delta', text: 'final answer' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    assert.equal(result.text, 'final answer');
    assert.equal(events.filter((e) => e.kind === 'model.stream_retry').length, 1);
    assert.equal(events.find((e) => e.kind === 'model.stream_retry').discardedTextChars, 'PARTIAL_SHOULD_DISCARD'.length);
  });
});

test('T18 STREAM exhaustion yields MODEL_TRANSPORT', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 2, DDA_MODEL_STREAM_RETRY_DELAY_MS: 0 }, async () => {
    let attempts = 0;
    await assert.rejects(() => runWithProvider(t, async function* () {
      attempts++;
      const err = new TypeError('terminated');
      err.transportPhase = 'STREAM';
      throw err;
    }), (error) => {
      assert.equal(error.message, 'MODEL_TRANSPORT');
      assert.equal(error.transportPhase, 'STREAM');
      assert.equal(error.transportAttempts, 3);
      return true;
    });
    assert.equal(attempts, 3);
  });
});

test('T19b finish_reason error without failure is treated as error', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 0, DDA_MODEL_STREAM_RETRY_DELAY_MS: 0 }, async () => {
    await assert.rejects(() => runWithProvider(t, async function* () {
      yield { type: 'finish', reason: { kind: 'error' } };
    }), /MODEL_TRANSPORT|MODEL_STREAM_ERROR|MODEL_REQUEST_REJECTED/);
  });
});

test('T19c context_length_exceeded does not retry', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 2, DDA_MODEL_STREAM_RETRY_DELAY_MS: 0 }, async () => {
    let attempts = 0;
    await assert.rejects(() => runWithProvider(t, async function* () {
      attempts++;
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'context_length_exceeded', message: 'too long' } } };
    }), (error) => {
      assert.equal(error.message, 'MODEL_REQUEST_REJECTED');
      return true;
    });
    assert.equal(attempts, 1);
  });
});

test('T20 CONNECT/HTTP errors are not retried at round level', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 2, DDA_MODEL_STREAM_RETRY_DELAY_MS: 0 }, async () => {
    let attempts = 0;
    await assert.rejects(() => runWithProvider(t, async function* () {
      attempts++;
      const err = new Error('MODEL_TRANSPORT');
      err.transportPhase = 'CONNECT';
      throw err;
    }), (error) => {
      assert.equal(error.message, 'MODEL_TRANSPORT');
      assert.equal(error.transportPhase, 'CONNECT');
      return true;
    });
    assert.equal(attempts, 1);
  });
});

test('T22 invalid stream retry env throws MODEL_RETRY_CONFIG_INVALID', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 99 }, async () => {
    await assert.rejects(() => runWithProvider(t, async function* () {
      yield { type: 'text-delta', text: 'x' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }), /MODEL_RETRY_CONFIG_INVALID/);
  });
});

// Helper / recovery shape (unit). Process exitCode coverage lives in
// linux-cli/test/harness-fix2-process-exit.test.mjs (real bin/dda.mjs spawn).
test('T24 helpers: exitCodeForError map + recovery failureClass for MODEL_TRANSPORT', () => {
  assert.equal(exitCodeForError('MODEL_TRANSPORT'), 1);
  assert.equal(exitCodeForError('MODEL_PROVIDER_REJECTED:401'), 3);
  assert.equal(exitCodeForError('MODEL_REQUEST_REJECTED:400'), 1);
  assert.equal(exitCodeForError('MODEL_RETRY_CONFIG_INVALID'), 3);
  assert.match(messageForCode('MODEL_TRANSPORT'), /模型连接/);
  const progress = createTaskProgress();
  progress.observe({ ok: false, error: 'MODEL_TRANSPORT' });
  assert.equal(progress.snapshot().recovery.failureClass, 'MODEL_TRANSPORT');
  const rebuilt = rebuildFailedTaskResult({ error: 'MODEL_TRANSPORT', harness: progress.snapshot() });
  assert.equal(rebuilt.error.code, 'MODEL_TRANSPORT');
  assert.equal(rebuilt.harness.recovery.failureClass, 'MODEL_TRANSPORT');
});

// task-runner emits discardedTextChars on stream_retry; index.mjs whitelist
// forwarding is asserted in linux-cli/test/harness-fix2-process-exit.test.mjs.
test('T26 task-runner emits discardedTextChars on model.stream_retry', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 1, DDA_MODEL_STREAM_RETRY_DELAY_MS: 0 }, async () => {
    let attempts = 0;
    const { events } = await runWithProvider(t, async function* () {
      attempts++;
      if (attempts === 1) {
        yield { type: 'text-delta', text: 'x' };
        const err = new TypeError('terminated');
        err.transportPhase = 'STREAM';
        throw err;
      }
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const retry = events.find((e) => e.kind === 'model.stream_retry');
    assert.equal(typeof retry.discardedTextChars, 'number');
    assert.equal(typeof retry.streamAttempt, 'number');
    assert.equal(typeof retry.requestsRemaining, 'number');
  });
});

test('NIT-2 transportBudget decrements only at fetch sites across stream retries', async (t) => {
  await withEnv(t, { DDA_MODEL_STREAM_RETRIES: 2, DDA_MODEL_STREAM_RETRY_DELAY_MS: 0, DDA_MODEL_MAX_REQUESTS_PER_ROUND: 4 }, async () => {
    const budgets = [];
    let attempts = 0;
    await runWithProvider(t, async function* (request) {
      attempts++;
      budgets.push(request.transportBudget?.remaining);
      // Simulate provider consuming one fetch unit the way fetchModelStream would.
      if (request.transportBudget) request.transportBudget.remaining -= 1;
      if (attempts < 3) {
        const err = new TypeError('terminated');
        err.transportPhase = 'STREAM';
        throw err;
      }
      yield { type: 'text-delta', text: 'ok' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    // Round-level does not double-decrement: remaining drops once per stream attempt only.
    assert.deepEqual(budgets, [4, 3, 2]);
  });
});
