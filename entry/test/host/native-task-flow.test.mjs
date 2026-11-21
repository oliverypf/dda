import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const worker = fileURLToPath(new URL('./native-task-process.mjs', import.meta.url));
const run = promisify(execFile);
const correction = 'Cite the JSON check in the final answer.';

function completion(res, delta, reason = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
  res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + '\n\ndata: [DONE]\n\n');
}

async function server(t, errors, handler) {
  const instance = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; }
      handler(req, JSON.parse(raw), res);
    } catch (err) {
      errors.push(err);
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise(resolve => instance.close(resolve));
  });
  return 'http://127.0.0.1:' + instance.address().port;
}

async function task(t, invalidJson = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dda-native-task-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const errors = [];
  const jevHost = await server(t, errors, (req, body, res) => {
    assert.equal(req.url, '/systemone');
    assert.equal(req.headers.authorization, 'Bearer fixture-router-key');
    assert.equal(body.model, 'router-model');
    assert.equal(body.state.action.kind, 'SELECT_ROLE_SET');
    assert.deepEqual(Object.keys(body.questions.candidate.criteria).sort(), ['executor-only', 'full-roles']);
    assert.equal(body.tools, undefined);
    events.push('route');
    res.end(JSON.stringify({ answers: { candidate: { choice: 'full-roles' } } }));
  });
  const provider = await server(t, errors, (req, body, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fixture-project-key');
    assert.equal(body.model, 'project-model');
    assert(!JSON.stringify(body).includes('fixture-router-key'));
    const system = body.messages.find(m => m.role === 'system')?.content ?? '';
    if (system.includes('You are the planner')) {
      assert.equal(body.tools?.length ?? 0, 0);
      assert.match(body.messages.at(-1).content, /project\.json/);
      events.push('plan');
      completion(res, { content: 'Create project.json, then validate JSON.' });
    } else if (system.includes('You are the independent verifier')) {
      assert.equal(body.tools?.length ?? 0, 0);
      const input = JSON.parse(body.messages.at(-1).content);
      assert.match(input.hostEvidence, /create_file/);
      assert.match(input.hostEvidence, invalidJson ? /command_check_json \/project\.json failed exit=1/ :
        /command_check_json \/project\.json ok exit=0/);
      assert.match(input.hostEvidence, /project\.json/);
      assert.match(input.plan, /validate JSON/);
      if (invalidJson) {
        events.push('false-accept');
        completion(res, { content: JSON.stringify({ accepted: true, summary: 'The command passed.' }) });
        return;
      }
      const corrected = events.includes('reject');
      if (corrected) { assert.match(input.executorOutput, /syntax passed/); }
      events.push(corrected ? 'accept' : 'reject');
      completion(res, { content: JSON.stringify({ accepted: corrected, summary: corrected ? 'Evidence matches.' : correction }) });
    } else {
      assert(body.tools.some(t => t.function.name === 'run_command'));
      assert(body.tools.some(t => t.function.name === 'create_file'));
      if (invalidJson && events.includes('false-accept')) {
        events.push('unrepaired');
        completion(res, { content: 'I claim the same failing check passed.' });
      } else if (events.includes('reject')) {
        assert(JSON.stringify(body.messages).includes(correction));
        if (!events.includes('request-duplicate')) {
          events.push('request-duplicate');
          completion(res, { tool_calls: [{ index: 0, id: 'new-call-same-change', type: 'function',
            function: { name: 'create_file', arguments: JSON.stringify({ path: '/project.json', content: '{"active":true}' }) }
          }] }, 'tool_calls');
          return;
        }
        assert.match(body.messages.at(-1).content, /already committed/);
        events.push('correct');
        completion(res, { content: 'Created project.json and its syntax passed.' });
      } else if (!events.includes('request-tools') || (!events.includes('resume-tools') && !events.includes('draft') &&
        body.messages.some(m => m.role === 'user' && m.content.includes('Resuming this task.')))) {
        events.push(events.includes('request-tools') ? 'resume-tools' : 'request-tools');
        const toolCalls = [
          ['write-note', 'create_file', { path: '/project.json', content: invalidJson ? '{' : '{"active":true}' }],
          ['check-note', 'run_command', { command: 'check-json', args: ['/project.json'] }]
        ].map(([id, name, input], index) => ({ index, id, type: 'function',
          function: { name, arguments: JSON.stringify(input) } }));
        completion(res, { tool_calls: toolCalls }, 'tool_calls');
      } else {
        const outputs = body.messages.filter(m => m.role === 'tool');
        assert.equal(outputs.length, 2);
        assert.match(outputs.at(-1).content, invalidJson ? /JSON 语法无效/ : /JSON 有效/);
        events.push('draft');
        completion(res, { content: 'Created project.json.' });
      }
    }
  });
  async function phase(mode, expectedStop) {
    const args = [worker, directory, provider + '/v1', jevHost + '/systemone', mode];
    let stdout;
    try {
      ({ stdout } = await run(process.execPath, args, { timeout: 25000 }));
      assert.equal(expectedStop, undefined, 'expected the fixture process to stop');
    } catch (error) {
      if (errors.length) { throw errors[0]; }
      if (!expectedStop || !(error.stdout ?? '').includes(JSON.stringify({ stoppedAt: expectedStop }))) { throw error; }
      stdout = error.stdout;
    }
    return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).approval).filter(Boolean);
  }
  return { directory, events, errors, phase };
}

test('approved project work survives a process stop before verification and Jev roles finish the same task', async t => {
  const flow = await task(t);
  const approvals = await flow.phase('stop-before-review', 'review');
  assert.equal(approvals.length, 2);
  assert(approvals[0].includes('/project.json'));
  assert(approvals[1].includes('check-json'));
  assert.deepEqual(flow.events, ['route', 'plan', 'request-tools', 'draft']);
  assert.deepEqual(await flow.phase('resume'), []);
  assert.deepEqual(flow.events, ['route', 'plan', 'request-tools', 'draft', 'reject', 'request-duplicate', 'correct', 'accept']);
  const journalName = (await readdir(flow.directory)).find(name => name.startsWith('checkpoint.'));
  const journal = await readFile(join(flow.directory, journalName), 'utf8');
  assert(!journal.includes('fixture-router-key') && !journal.includes('fixture-project-key'));
  assert.deepEqual(flow.errors, []);
});

test('a process stop between a file effect and its host receipt fences replay on resume', async t => {
  const flow = await task(t);
  const approvals = await flow.phase('stop-after-effect', 'post-effect');
  assert.equal(approvals.length, 1);
  assert(approvals[0].includes('/project.json'));
  assert.deepEqual(await flow.phase('resume-pending'), []);
  assert.deepEqual(flow.events, ['route', 'plan', 'request-tools']);
  assert.deepEqual(flow.errors, []);
});

test('verifying a previously interrupted write records its hash match and resumes the remaining command', async t => {
  const flow = await task(t);
  const first = await flow.phase('stop-after-effect', 'post-effect');
  assert.equal(first.length, 1);
  assert(first[0].includes('/project.json'));
  const remaining = await flow.phase('verify-and-resume');
  assert.equal(remaining.length, 1);
  assert(remaining[0].includes('check-json'));
  assert.deepEqual(flow.events, ['route', 'plan', 'request-tools', 'resume-tools', 'draft',
    'reject', 'request-duplicate', 'correct', 'accept']);
  assert.deepEqual(flow.errors, []);
});

test('a verifier approving a failed project check cannot complete the task', async t => {
  const flow = await task(t, true);
  const approvals = await flow.phase('invalid-check');
  assert.equal(approvals.length, 2);
  assert.equal(flow.events.filter(event => event === 'route').length, 1);
  assert(flow.events.includes('false-accept'));
  assert.deepEqual(flow.errors, []);
});
