import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { loadArkTS } from './sdk-host.mjs';

const { LocalRoleOrchestrator, validateJevEndpoint } = loadArkTS('services/LocalRoleOrchestrator');

async function fixture(t, respond) {
  const server = createServer(respond);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/custom/systemone';
  return new LocalRoleOrchestrator({ endpoint, model: 'test-jev', apiKey: 'fixture-jev-only' });
}

test('Jev receives finite System One choices, its own key and a bounded routing goal', async t => {
  let observed;
  const orchestrator = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) { body += chunk; }
    observed = { body: JSON.parse(body), method: req.method, key: req.headers.authorization, url: req.url };
    res.end(JSON.stringify({ result: { answers: { candidate: {
      choice: 'executor-only', confidence: 0.5, scores: { 'executor-only': 0.4, 'full-roles': 0.6 }
    } } } }));
  });
  const goal = '修复项目'.repeat(500);
  assert.equal(await orchestrator.selectRoles('turn-1', goal), 'executor-only');
  assert.equal(observed.method, 'POST');
  assert.equal(observed.url, '/custom/systemone');
  assert.equal(observed.key, 'Bearer fixture-jev-only');
  assert.equal(observed.body.model, 'test-jev');
  assert.deepEqual(Object.keys(observed.body).sort(), ['model', 'questions', 'state']);
  const { state, questions: { candidate } } = observed.body;
  assert.equal(state.goal, goal.slice(0, 1200));
  assert.equal(state.currentStep, 'SELECT_ROLE_SET');
  assert.equal(candidate.type, 'choice');
  assert.deepEqual(Object.keys(candidate).sort(), ['criteria', 'instructions', 'type']);
  assert.deepEqual(Object.keys(candidate.criteria).sort(), ['executor-only', 'full-roles']);
  assert.deepEqual(candidate.instructions.context.candidates.map(c => c.candidateId).sort(), ['executor-only', 'full-roles']);
});

test('explicit Jev routes accept Windows answer aliases and reject invented or missing decisions', async t => {
  let payload;
  const orchestrator = await fixture(t, (_, res) => res.end(payload));
  for (const response of [
    { answers: { candidate: 'full-roles' } }, { decisions: { candidate: { label: 'full-roles' } } },
    { result: { candidate: { decision: 'full-roles' } } }, { candidate: { value: 'full-roles' } }
  ]) {
    payload = JSON.stringify(response);
    assert.equal(await orchestrator.selectRoles('turn', 'goal'), 'full-roles');
  }
  for (const response of [null, {}, { answers: { candidate: 'shell' } },
    { answers: { candidate: { scores: { 'full-roles': 1 } } } }]) {
    payload = JSON.stringify(response);
    await assert.rejects(orchestrator.selectRoles('turn', 'goal'), /未明确选中/);
  }
  payload = '<html></html>';
  await assert.rejects(orchestrator.selectRoles('turn', 'goal'), /JSON/);
  payload = 'x'.repeat(65537);
  await assert.rejects(orchestrator.selectRoles('turn', 'goal'), /64 KiB/);
});

test('Jev errors and cancellation end routing without granting a fallback role', async t => {
  let arrive;
  const started = new Promise(resolve => { arrive = resolve; });
  let waiting = true;
  const orchestrator = await fixture(t, (_, res) => {
    if (waiting) { arrive(); return; }
    res.writeHead(401);
    res.end('server content must not be relayed');
  });
  const pending = orchestrator.selectRoles('turn-1', 'goal');
  await started;
  await assert.rejects(orchestrator.selectRoles('turn-2', 'goal'), /正在选择/);
  orchestrator.cancel();
  await assert.rejects(pending, /已取消/);
  waiting = false;
  await assert.rejects(orchestrator.selectRoles('turn-1', 'goal'), { message: 'Jev 服务返回 HTTP 401。' });
  const unconfigured = new LocalRoleOrchestrator({ endpoint: 'https://example.org/v1/systemone', model: 'jev-latest', apiKey: '' });
  await assert.rejects(unconfigured.selectRoles('turn-1', 'goal'), /独立的 Jev 凭据/);
  for (const invalid of ['http://example.org/v1', 'https://u:p@example.org/', 'https://example.org/?key=secret']) {
    assert.throws(() => validateJevEndpoint(invalid));
  }
});

test('planner and verifier receive isolated text and explicit verification can reject execution', async () => {
  const orchestrator = new LocalRoleOrchestrator({ endpoint: 'https://example.org/systemone', model: 'j', apiKey: 'secret' });
  const goal = 'change the project note';
  const plan = await orchestrator.plan(goal, async (system, input) => {
    assert.match(system, /planner/);
    assert.equal(input, goal);
    return ' write and read back ';
  });
  assert.equal(plan, 'write and read back');
  const review = await orchestrator.review(goal, plan, 'file changed', 'read never ran', async (system, input) => {
    assert.match(system, /independent verifier/);
    assert.deepEqual(JSON.parse(input), { goal, plan, executorOutput: 'file changed', hostEvidence: 'read never ran' });
    return '{"accepted":false,"summary":" Missing readback " }';
  });
  assert.deepEqual(review, { accepted: false, summary: 'Missing readback' });
  await assert.rejects(orchestrator.plan(goal, async () => ''), /计划/);
  for (const invalid of ['done', '{"accepted":"true","summary":"ok"}', '{"accepted":true,"summary":""}']) {
    await assert.rejects(orchestrator.review(goal, plan, '', '', async () => invalid), /审查结论/);
  }
});
