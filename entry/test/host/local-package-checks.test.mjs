import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadArkTS } from './sdk-host.mjs';

const { LocalWorkspace } = loadArkTS('services/LocalWorkspace');
const { readPackageChecks, describePackageChecks } = loadArkTS('services/LocalPackageChecks');
const { parseProjectCommand, runProjectCommand } = loadArkTS('services/LocalCommandExecutor');

async function fixture(t, scripts) {
  const filesDir = await mkdtemp(join(tmpdir(), 'dda-package-check-'));
  t.after(() => rm(filesDir, { recursive: true, force: true }));
  const workspace = new LocalWorkspace({ filesDir });
  await workspace.initialize();
  await workspace.createFile('/package.json', JSON.stringify({ scripts }));
  return workspace;
}

test('npm test runs each supported lifecycle check in order and stops at a failing file', async t => {
  const workspace = await fixture(t, {
    pretest: 'check-json "settings file.json"',
    test: 'node --check src/main.cjs && node --check src/module.mjs',
    posttest: 'git hash-object src/main.cjs'
  });
  await workspace.createFile('/settings file.json', '{}');
  await workspace.createFile('/src/main.cjs', 'throw new Error("syntax checks must not run this")');
  await workspace.createFile('/src/module.mjs', 'export const version = 1;');
  const plan = await readPackageChecks(workspace, parseProjectCommand);
  assert.deepEqual(plan.steps.map(s => s.stage), ['pretest','test','test','posttest']);
  assert.match(describePackageChecks(plan), /pretest.*settings file\.json/);
  const run = () => runProjectCommand(workspace, 'npm', ['test'], plan);
  const success = await run();
  assert.equal(success.exitCode, 0, success.stderr);
  assert.match(success.stdout, /> posttest.*git hash-object/);
  await workspace.replaceFile('/src/main.cjs', await workspace.read('/src/main.cjs'), 'const a = ;');
  const failure = await run();
  assert.equal(failure.exitCode, 1);
  assert.match(failure.stderr, /main\.cjs:1:/);
  assert.doesNotMatch(failure.stdout, /posttest/);
});

test('manifest approval covers the complete lifecycle and binds the exact manifest', async t => {
  const workspace = await fixture(t, { test: 'check-json ok.json' });
  await workspace.createFile('/ok.json', '{}');
  const plan = await readPackageChecks(workspace, parseProjectCommand);
  await workspace.replaceFile('/package.json', plan.manifest, JSON.stringify({ scripts: { test: 'check-json different.json' } }));
  assert.match((await runProjectCommand(workspace, 'npm', ['test'], plan)).stderr, /审批后/);
  for (const scripts of [
    { pretest: 'npm install', test: 'check-json ok.json' },
    { test: 'node --check file.js', posttest: 'node server.js' },
    { test: 'check-json ok.json || git hash-object ok.json' },
    { test: 'check-json ok.json &&' },
    { test: 'npm test' },
    { test: 'node --check "$HOME/file.js"' }
  ]) {
    const old = await workspace.read('/package.json');
    await workspace.replaceFile('/package.json', old, JSON.stringify({ scripts }));
    const failure = await runProjectCommand(workspace, 'npm', ['test']);
    assert.equal(failure.exitCode, 2);
    assert.equal(failure.stdout, '');
  }
});

test('model approval names the resolved package tests and a changed manifest cannot yield a completed task', async t => {
  const workspace = await fixture(t, { test: 'check-json ok.json' });
  await workspace.createFile('/ok.json', '{}');
  const { LocalModelTransport } = loadArkTS('services/LocalModelTransport');
  const transport = new LocalModelTransport(workspace);
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) { raw += chunk; }
    const messages = JSON.parse(raw).messages;
    const latest = messages.at(-1);
    const result = latest.role === 'tool';
    calls.push(latest);
    const delta = result ? { content: 'all tests passed' } : { tool_calls: [
      { index: 0, id: 'check', type: 'function', function: { name: 'run_command',
        arguments: JSON.stringify({ command: 'npm', args: ['test'] }) } }
    ] };
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    res.write('data: ' + JSON.stringify({ choices:[{index:0,delta,finish_reason:null}] }) + '\n\n');
    res.end('data: ' + JSON.stringify({choices:[{index:0,delta:{},finish_reason:result?'stop':'tool_calls'}]}) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  transport.configure({ baseUrl: 'http://127.0.0.1:' + server.address().port, model:'fixture', apiKey:'' });
  transport.prepareTurn([], '');
  const events = [];
  let change;
  await transport.connect(event => {
    events.push(event);
    if (event.kind === 'approvalRequired') {
      assert.match(event.command, /test +check-json ok\.json/);
      change = (async () => {
        const pkg = await workspace.read('/package.json');
        await workspace.replaceFile('/package.json', pkg, JSON.stringify({scripts:{test:'git hash-object ok.json'}}));
        transport.resolveApproval(event.requestId, true);
      })();
    }
  });
  await assert.rejects(transport.sendTurn('pkg-fixture', 'run the package tests'), /本机检查尚未通过/);
  await change;
  assert.equal(calls.length, 2);
  assert.match(calls[1].content, /package\.json 已变化/);
  const state = await transport.checkpoint('pkg-fixture');
  assert.equal(state.phase, 'execute');
  assert.equal(state.receipts[0].exitCode, 1);
  assert(!events.some(event => event.kind === 'turnCompleted' || event.text === 'all tests passed'));
  await transport.disconnect();
});
