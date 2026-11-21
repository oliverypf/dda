// Run with Node 24: node --test entry/test/host/local-workbench.test.mjs
// Set DEVECO_STUDIO_HOME when DevEco Studio is installed in a different directory.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

test('a native service session creates an approved file and resumes from disk in a new process', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-harmony-e2e-'));
  const requests = [];
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; }
      const body = JSON.parse(raw);
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      const latest = body.messages.at(-1);
      const first = !body.messages.some(message => message.content === 'continue the same task');
      const isToolResult = latest.role === 'tool';
      const delta = isToolResult ? { content: first ? 'note written' : 'request denied' } : {
        tool_calls: [{ index: 0, id: 'call-note', type: 'function', function: { name: 'create_file',
          arguments: JSON.stringify({ path: first ? '/note.txt' : '/denied.txt', content: 'local data' }) } }]
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {},
        finish_reason: isToolResult ? 'stop' : 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
    } catch {
      res.destroy();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/v1';
  const worker = fileURLToPath(new URL('./workbench-process.mjs', import.meta.url));
  for (const phase of ['first', 'reopen']) {
    await promisify(execFile)(process.execPath, [worker, directory, endpoint, phase], { timeout: 20000 });
  }
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.authorization, undefined);
    assert.equal(request.body.model, 'test-model');
    assert.equal(request.body.stream, true);
    assert.match(request.body.messages[0].content, /use short replies/);
  }
  assert(requests[0].body.tools.some(tool => tool.function.name === 'create_file'));
  assert.deepEqual(requests[2].body.messages.map(message => message.content).slice(1),
    ['create the project note', 'note written', 'continue the same task']);
  assert.match(requests[3].body.messages.at(-1).content, /declined/i);
});
