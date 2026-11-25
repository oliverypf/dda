import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';
import { emitGoalResponse } from '../../desktop/scripts/goal-model-fixture.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';
const stagedRuntime = new URL('..', import.meta.url);

// An unexplained Jev FAIL veto is withheld: the step is stamped UNCERTAIN with
// a host.execution PASS check and promoted green, while a stated GOAL_CONFLICT
// still vetoes the step.
for (const variant of ['unexplained', 'goal-conflict']) {
  test(`jev FAIL ${variant === 'unexplained' ? 'without a reason completes with an advisory note' : 'with GOAL_CONFLICT still vetoes'}`, async t => {
    const workspace = await mkdtemp(join(tmpdir(), `hmcodex-verdict-policy-${variant}-`));
    const config = join(workspace, 'fixture-provider.json');
    const workspaceConfig = join(workspace, 'model-config.json');
    const trajectory = join(workspace, 'trajectory.jsonl');
    const store = join(workspace, 'harness.db');
    await writeFile(workspaceConfig, '{"provider":"existing-provider"}\n');
    const verdicts = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.url === '/jev') {
        const answers = {};
        for (const [name, question] of Object.entries(body.questions ?? {})) {
          const choices = Object.keys(question.criteria ?? {});
          let choice = choices[0];
          if (name === 'verification') {
            verdicts.push({ stepId: body.state?.action?.stepId, attempt: body.state?.action?.attempt });
            choice = 'FAIL';
          } else if (name === 'verificationReason') {
            if (variant === 'unexplained') continue;
            choice = 'GOAL_CONFLICT';
          } else if (name === 'candidate' && choices.includes('model-planner')) {
            choice = 'model-planner';
          } else if (name === 'actionGate') choice = 'ALLOW';
          else if (name === 'failureType') choice = 'NONE';
          else if (name === 'evidence') choice = 'SUFFICIENT';
          else if (name === 'test') choice = 'NONE';
          else if (name === 'stop') choice = 'NEED_MORE_EVIDENCE';
          else if (name === 'escalation') choice = 'LOCAL_CONTINUE';
          answers[name] = { choice, confidence: 0.99 };
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers }));
        return;
      }
      const sendText = text => emitGoalResponse(response, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]);
      if (/Planner role/iu.test(String(body.instructions ?? ''))) {
        sendText(JSON.stringify({ planId: `plan-${variant}`, steps: [
          { stepId: 'answer', summary: '回答用户', actionKind: 'EXECUTE' }
        ], requirements: { build: false, test: false, artifact: false, install: false, deliverables: [] } }));
        return;
      }
      sendText('ok');
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const port = await listenOnFetchablePort(server);
    await writeFile(config, JSON.stringify({ provider: 'openai', protocol: 'responses', model: 'fixture',
      endpoint: `http://127.0.0.1:${port}/model`, apiKeyEnv: 'VERDICT_POLICY_FIX_KEY',
      decision: { enabled: true, enforce: true, endpoint: `http://127.0.0.1:${port}/jev`, apiKeyEnv: 'VERDICT_POLICY_FIX_KEY' } }));
    const env = { VERDICT_POLICY_FIX_KEY: 'local-only-key', DDA_DATA_DIR: workspace, DDA_HARNESS_EVENT_STORE: store,
      DDA_CONTEXT_PROVIDER: 'journal', DDA_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', DDA_JEV_ENABLED: '1', DDA_JEV_ENFORCE: '1' };
    const args = ['src/index.mjs', 'task', '--config', config, '--workspace', workspace, '--trajectory-store', trajectory,
      '--thread-store', join(workspace, 'threads.json'), '--agent-mode', 'single',
      '--execution-mode', 'CONTROLLED', '--events', 'stdout', '--max-recovery-attempts', '2', '--prompt', '回复：ok'];
    const run = await runEvidenceProcess(process.execPath, args, { cwd: stagedRuntime, env, timeoutMs: 90000 });
    const lastJson = output => JSON.parse(output.trim().split(/\r?\n/u).at(-1));
    assert.equal(run.timedOut, false, run.stderr);
    const result = lastJson(run.stdout);
    assert.ok(verdicts.length >= 1, 'the jev verification question was asked');
    if (variant === 'unexplained') {
      assert.equal(result.ok, true, run.stdout + run.stderr);
      assert.match(String(result.text ?? ''), /未经核对的内容/u);
      assert.match(String(result.text ?? ''), /语义校验未能确认本步骤/u);
      const planCreated = run.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line))
        .find(event => event.kind === 'plan.created');
      assert.deepEqual(planCreated?.payload.requirements, {
        build: false, test: false, artifact: false, install: false, deliverables: []
      });
    } else {
      assert.equal(result.ok, false, run.stdout + run.stderr);
      const liveFailure = run.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line)).find(event => event.kind === 'run.failed');
      assert.ok(liveFailure?.payload.failureCodes.includes('JEV_BEHAVIOR_REJECTED'), JSON.stringify(liveFailure?.payload));
    }
  });
}
