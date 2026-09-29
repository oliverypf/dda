import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

test('stdout approval round-trip persists and consumes a one-shot lease', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-approval-events-'));
  const trajectory = join(workspace, 'trajectory.jsonl');
  const executionState = join(workspace, 'execution-state.json');
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requestCount += 1;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requestCount === 1) {
      const args = JSON.stringify({ command: process.execPath, args: ['-e', 'process.stdout.write("approved")'] });
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'approval-call', type: 'function', function: { name: 'shell.execute', arguments: args } }] }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}`,
        'data: [DONE]'
      ].join('\n\n') + '\n\n');
      return;
    }
    assert.match(payload.messages.at(-1)?.content ?? '', /approved/);
    response.end([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '已执行并得到批准结果' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
      'data: [DONE]'
    ].join('\n\n') + '\n\n');
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const keyName = `HMCODEX_APPROVAL_KEY_${randomUUID().replaceAll('-', '')}`;
  const child = spawn(process.execPath, [
    'src/index.mjs', 'task',
    '--provider', 'openai-chat', '--protocol', 'chat-completions',
    '--endpoint', `http://127.0.0.1:${address.port}/chat/completions`,
    '--api-key-env', keyName,
    '--execution-mode', 'CONTROLLED',
    '--lease-capabilities', 'shell.execute', '--lease-commands', 'node',
    '--prompt', '执行一次获批命令', '--workspace', workspace,
    '--trajectory-store', trajectory, '--execution-state-store', executionState,
    '--events', 'stdout'
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, [keyName]: 'test-key' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const events = [];
  let stdout = '';
  let stderr = '';
  let buffered = '';
  let responded = false;
  let invalidResponseSent = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    buffered += chunk.toString('utf8');
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value.type !== 'runtime_event') continue;
      events.push(value);
      if (value.kind === 'approval.requested' && !responded) {
        if (!invalidResponseSent) {
          invalidResponseSent = true;
          child.stdin.write(JSON.stringify({ type: 'approval_response', requestId: value.payload.requestId, approved: true, displayedDigest: 'sha256:' + '0'.repeat(64) }) + '\n');
          setTimeout(() => { responded = true; child.stdin.write(JSON.stringify({ type: 'approval_response', requestId: value.payload.requestId, approved: true, displayedDigest: value.payload.requestDigest }) + '\n'); }, 20);
        } else {
          responded = true;
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    // A full CONTROLLED child run legitimately takes ~25s on a healthy machine,
    // so a 30s budget left almost no room for parallel-suite load and failed for
    // environmental reasons rather than product behavior. The child is still
    // killed on timeout, so a real hang keeps failing here.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`approval test timed out\n${stdout}\n${stderr}`));
    }, 120_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });
  assert.equal(result.code, 0, `${stderr}\n${stdout}`);
  assert.equal(responded, true);
  assert.ok(events.length > 0);
  assert.equal(new Set(events.map((event) => event.runId)).size, 1);
  const sequences = events.map((event) => event.sequence);
  assert.deepEqual(sequences, sequences.slice().sort((left, right) => left - right));
  assert.equal(new Set(sequences).size, sequences.length);
  const approvalRequested = events.find((event) => event.kind === 'approval.requested');
  assert.ok(approvalRequested);
  assert.match(approvalRequested.payload.risk, /^(LOW|MEDIUM|HIGH)$/);
  assert.equal(approvalRequested.payload.policyVersion, 'runtime-safety-1');
  assert.match(approvalRequested.payload.scope.snapshotDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof approvalRequested.payload.approvalExpiresAt, 'number');
  assert.equal(typeof approvalRequested.payload.intentId, 'string');
  assert.equal(typeof approvalRequested.payload.approvalId, 'string');
  assert.ok(events.some((event) => event.kind === 'lease.issued'));
  assert.ok(events.some((event) => event.kind === 'lease.consumed'));
  assert.ok(events.some((event) => event.kind === 'run.state_changed' && event.payload.to === 'WAITING_APPROVAL'));
  assert.ok(events.some((event) => event.kind === 'run.state_changed' && event.payload.from === 'WAITING_APPROVAL' && event.payload.to === 'EXECUTING'));
  assert.ok(events.some((event) => event.kind === 'verification.completed' && event.payload.status === 'PASS'));
  const payload = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(payload.ok, true);
  const persisted = JSON.parse(await readFile(executionState, 'utf8'));
  assert.ok(persisted.records.some((record) => record.recordType === 'approval' && record.state === 'APPROVED' && typeof record.expiresAt === 'number'));
  assert.ok(persisted.records.some((record) => record.recordType === 'lease' && record.state === 'CONSUMED'));
});
