import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';
import { emitGoalResponse } from '../../desktop/scripts/goal-model-fixture.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

const MARKER = 'JEV_ROUTE_MIGRATION_MARKER';

// Drive a minimal task while a fixture Jev endpoint records which bounded
// candidate decisions the host actually asks it to make.
const runScenario = async (t, { optIn, routeChoice = 'route-selected' }) => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-jev-plane-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'README.md'), `${MARKER}\n`);
  const candidateDecisions = [];
  let routeChoices;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/jev') {
      const answers = {};
      for (const [id, question] of Object.entries(body.questions)) {
        const choices = Object.keys(question.criteria ?? {});
        let choice = choices[0];
        if (id === 'candidate') {
          const kind = body.state?.action?.kind;
          candidateDecisions.push(kind);
          if (kind === 'SELECT_ROUTE') { routeChoices = choices; choice = choices.includes(routeChoice) ? routeChoice : choices[0]; }
        }
        if (id === 'actionGate') choice = 'ALLOW';
        if (id === 'verification') choice = 'PASS';
        if (id === 'failureType') choice = 'NONE';
        if (id === 'evidence') choice = 'SUFFICIENT';
        if (id === 'test') choice = 'NONE';
        if (id === 'stop') choice = 'STOP_SUCCESS';
        if (id === 'escalation') choice = 'LOCAL_CONTINUE';
        answers[id] = { choice, confidence: 0.99 };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers }));
      return;
    }
    const outputs = body.input.filter((item) => item.type === 'function_call_output');
    if (outputs.some((item) => String(item.output).includes(MARKER))) {
      emitGoalResponse(res, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `The README marker is ${MARKER}.` }] }]);
      return;
    }
    emitGoalResponse(res, [{ type: 'function_call', id: `call-${outputs.length + 1}`, call_id: `call-${outputs.length + 1}`, name: 'workspace.read', arguments: JSON.stringify({ path: 'README.md' }) }]);
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = await listenOnFetchablePort(server);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({
    provider: 'openai', protocol: 'responses', model: 'fixture', endpoint: `http://127.0.0.1:${port}/model`, apiKeyEnv: 'JEV_PLANE_KEY',
    decision: { enabled: true, enforce: true, endpoint: `http://127.0.0.1:${port}/jev`, apiKeyEnv: 'JEV_PLANE_KEY', timeoutMs: 5000 }
  }));
  const env = { JEV_PLANE_KEY: 'local-key', DDA_JEV_ENABLED: '1', DDA_JEV_ENFORCE: '1' };
  if (optIn) env.DDA_JEV_ROUTE_ENABLED = '1';
  const result = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'task', '--config', config, '--workspace', workspace,
    '--prompt', 'Read README.md and report its marker.', '--trajectory-store', join(root, 'trajectory.jsonl')], {
    cwd: new URL('..', import.meta.url), env, timeoutMs: 30000
  });
  return { result, candidateDecisions, routeChoices };
};

test('classification is absent and SELECT_ROUTE still consults Jev when opted in', async (t) => {
  const { result, candidateDecisions, routeChoices } = await runScenario(t, { optIn: true });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout.trim()).ok, true);
  assert.equal(candidateDecisions.includes('CLASSIFY_TASK'), false);
  assert.ok(candidateDecisions.includes('SELECT_ROUTE'), 'route selection reaches Jev instead of being dead code');
  assert.deepEqual(routeChoices?.slice().sort(), ['route-blocked', 'route-selected'].sort());
});

test('a Jev SELECT_ROUTE block fails closed before any role allocation', async (t) => {
  const { result, candidateDecisions } = await runScenario(t, { optIn: true, routeChoice: 'route-blocked' });
  assert.equal(result.code, 1, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.match(payload.error, /ROUTE_BLOCKED/);
  assert.ok(candidateDecisions.includes('SELECT_ROUTE'), 'the block is a Jev route decision, not a rule default');
});

test('without route opt-in the generic router stays authoritative', async (t) => {
  const { result, candidateDecisions } = await runScenario(t, { optIn: false });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout.trim()).ok, true);
  assert.equal(candidateDecisions.includes('CLASSIFY_TASK'), false);
  assert.equal(candidateDecisions.includes('SELECT_ROUTE'), false, 'route selection stays on the rule path when not opted in');
});
