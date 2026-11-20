import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { emitGoalResponse } from '../../desktop/scripts/goal-model-fixture.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

test('new desktop turns open a checkout only for project tools and recover just the named thread', { timeout: 180000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dda-deferred-startup-'));
  const claimed = join(dir, 'claimed');
  await mkdir(claimed);
  await writeFile(join(claimed, 'note.txt'), 'CLAIMED_CHECKOUT_CONTENT');
  const prompts = [];
  let readFileTool = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/jev') {
      const defaults = { verification: 'PASS', verificationReason: 'UNSPECIFIED', evidence: 'SUFFICIENT', failureType: 'NONE',
        test: 'NONE', stop: 'STOP_SUCCESS', escalation: 'LOCAL_CONTINUE', actionGate: 'ALLOW' };
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
        const choices = Object.keys(question.criteria);
        return [id, { choice: choices.includes(defaults[id]) ? defaults[id] : choices[0], confidence: 0.99 }];
      }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers }));
      return;
    }
    prompts.push(JSON.stringify(body.input));
    const hasOutput = body.input.some(item => item.type === 'function_call_output');
    const output = readFileTool && !hasOutput
      ? { type: 'function_call', id: 'read-note', call_id: 'read-note', name: 'workspace.read', arguments: '{"path":"note.txt"}' }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: readFileTool ? 'CLAIMED_CHECKOUT_CONTENT' : 'Good morning.' }] };
    emitGoalResponse(res, output);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = await listenOnFetchablePort(server);
  const config = join(dir, 'model.json');
  await writeFile(config, JSON.stringify({ provider: 'openai', protocol: 'responses', model: 'fixture',
    endpoint: 'http://127.0.0.1:' + port + '/model', apiKeyEnv: 'DDA_FIXTURE_KEY' }));
  const run = async (prompt, threadId) => {
    const child = spawn(process.execPath, ['src/index.mjs', 'task', '--defer-workspace', '--prompt', prompt,
      '--config', config, '--workspace', '', '--events', 'stdout', '--session-id', 'fixture',
      ...(threadId ? ['--thread-id', threadId] : [])], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, DDA_DATA_DIR: dir, LOCALAPPDATA: dir, APPDATA: dir,
        DDA_FIXTURE_KEY: 'local-fixture', DDA_JEV_ENABLED: readFileTool ? '1' : '0', DDA_JEV_ENFORCE: '0',
        DDA_JEV_API_KEY_ENV: 'DDA_FIXTURE_KEY', DDA_JEV_ENDPOINT: 'http://127.0.0.1:' + port + '/jev', DDA_RESIDENT_KERNEL: '0' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const events = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    for await (const line of createInterface({ input: child.stdout })) {
      const event = JSON.parse(line);
      events.push(event);
      if (event.kind === 'workspace.claim_requested') {
        child.stdin.write(JSON.stringify({ type: 'workspace.claim_result', requestId: event.payload.requestId, path: claimed }) + '\n');
      }
    }
    const result = events.findLast(event => typeof event.ok === 'boolean');
    assert.equal(result?.ok, true, result?.error ?? stderr);
    return { events, result };
  };
  const first = await run('Say Good morning.');
  assert.ok(!first.events.some(e => ['workspace.snapshot', 'workspace.claim_requested'].includes(e.kind)));
  assert.ok(!first.events.some(e => ['THREAD_STORE_LOAD', 'TRAJECTORY_READ', 'INITIAL_GIT_AUDIT'].includes(e.payload?.phase)));
  readFileTool = true;
  const second = await run('Read note.txt and quote its contents.');
  assert.equal(second.events.filter(e => e.kind === 'workspace.claim_requested').length, 1);
  assert.equal(second.events.filter(e => e.kind === 'workspace.snapshot').length, 1);
  assert.equal(second.result.thread.cwd, claimed);
  assert.ok(prompts.some(body => body.includes('CLAIMED_CHECKOUT_CONTENT')));
  assert.ok(!prompts.some(body => body.includes(first.result.runId)));
  prompts.length = 0;
  const followup = await run('Read note.txt again.', second.result.threadId);
  assert.equal(followup.result.threadId, second.result.threadId);
  assert.ok(followup.events.some(e => e.payload?.phase === 'TRAJECTORY_READ'));
  assert.ok(prompts.some(body => body.includes(second.result.runId)));
  assert.ok(!prompts.some(body => body.includes(first.result.runId)));
});
