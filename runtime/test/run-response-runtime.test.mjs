import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readThreadHistory } from '../src/thread-history-reader.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

for (const fail of [false, true]) {
  test(`desktop SQLite history restores ${fail ? 'interrupted' : 'successful'} model response`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'response-runtime-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const text = '模型的原始回复\n\n第二段：保留格式。';
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
        if (fail) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'invalid-call', type: 'function', function: { name: 'workspace.read', arguments: 'invalid json' } }] }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: fail ? 'tool_calls' : 'stop' }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    t.after(() => new Promise((done) => server.close(done)));
    await listenOnFetchablePort(server);
    const config = join(directory, 'model.json');
    await writeFile(config, JSON.stringify({ schemaVersion: '1.0', provider: 'openai-chat',
      protocol: 'chat-completions', model: 'fixture', baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'FIXTURE_KEY' }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HMCODEX_')));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
        'task', '--config', config, '--prompt', 'inspect', '--workspace', directory], {
        env: { ...env, FIXTURE_KEY: 'fixture', HMCODEX_DATA_DIR: directory, HMCODEX_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL' },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code === 0, !fail, result.stderr + result.stdout);
    const options = { harnessPath: join(directory, 'hmCodex', 'hmcodex.db'), threadPath: join(directory, 'hmCodex', 'threads.json') };
    const list = await readThreadHistory({ ...options, listOnly: true });
    assert.equal(list.threads.length, 1);
    const history = await readThreadHistory({ ...options, threadId: list.threads[0].id });
    const response = history.events.find((e) => e.payload.persistedKind === (fail ? 'TaskRunFailed' : 'TaskRunCompleted'));
    assert.ok(response, result.stdout);
    assert.ok(response.payload.responseText?.includes(text), JSON.stringify(response));
    if (!fail) assert.equal(response.payload.responseText, JSON.parse(result.stdout.trim()).text);
  });
}
