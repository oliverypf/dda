import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../src/plugins/registry.mjs';
import { PluginGovernance } from '../src/plugin-governance.mjs';
import { DynamicPluginLoader } from '../src/plugin-loader.mjs';
import { EvolutionRegistry } from '../src/plugins/evolution-registry.mjs';
import { EvolutionEvaluator } from '../src/evolution-evaluator.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

const run = (args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

const fixtureManifest = (id) => ({
  schemaVersion: '1.0',
  id,
  name: id,
  version: '1.0.0',
  contributions: [{
    id: `${id}.contribution`,
    type: 'skill',
    capabilities: [],
    permissions: []
  }]
});

const activate = async (governance, pluginId, evaluator, registry) => {
  await governance.transition(pluginId, 'VALIDATING');
  await governance.transition(pluginId, 'INSTALLED');
  await governance.transition(pluginId, 'ENABLED');
  const plugin = governance.get(pluginId);
  const proposal = await registry.propose({ candidateId: pluginId, pluginId, packageDigest: plugin.packageDigest });
  const fixtures = [{ caseId: 'activation', baseline: { status: 'SUCCEEDED' }, candidate: { status: 'SUCCEEDED' } }];
  await evaluator.shadow({ proposalId: proposal.proposalId, fixtures });
  await evaluator.canary(proposal.proposalId, { fixtures });
  await evaluator.promote(proposal.proposalId);
  const report = evaluator.latest(proposal.proposalId, 'CANARY');
  await evaluator.flush();
  await governance.transition(pluginId, 'ACTIVE', { evaluation: {
    reportId: report.reportId, reportDigest: report.reportDigest, pluginId, packageDigest: plugin.packageDigest
  } });
};

test('runTask activates only ACTIVE dynamic plugins and isolates failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-dynamic-runtime-'));
  const pluginRoot = join(root, 'plugins');
  const governancePath = join(root, 'plugin-governance.json');
  const workspace = join(root, 'workspace');
  await Promise.all([
    mkdir(pluginRoot, { recursive: true }),
    mkdir(workspace, { recursive: true })
  ]);
  await writeFile(join(workspace, 'README.md'), '# dynamic plugin test\n', 'utf8');
  const activePath = join(pluginRoot, 'active.mjs');
  const inactivePath = join(pluginRoot, 'inactive.mjs');
  const failingPath = join(pluginRoot, 'failing.mjs');
  const unauthorizedPath = join(pluginRoot, 'unauthorized.mjs');
  const importedMarker = join(root, 'active-imported.marker');
  await writeFile(activePath, [
    `import { writeFile } from 'node:fs/promises';`,
    `await writeFile(${JSON.stringify(importedMarker)}, 'imported', 'utf8');`,
    `export const createPlugin = (ctx) => { ctx.provide('com.example.active.marker', { loaded: true }); };`
  ].join('\n'), 'utf8');
  await writeFile(inactivePath, "throw new Error('INACTIVE_PLUGIN_IMPORTED');\n", 'utf8');
  await writeFile(failingPath, "export const createPlugin = () => { throw new Error('DYNAMIC_PLUGIN_SELF_TEST_FAILED'); };\n", 'utf8');
  await writeFile(unauthorizedPath, "export const createPlugin = (ctx) => { ctx.get('modelProvider'); };\n", 'utf8');

  const governance = new PluginGovernance({ storagePath: governancePath });
  const evolutionPath = join(root, 'evolution.json');
  const evaluationPath = join(root, 'evaluation.json');
  const registry = new EvolutionRegistry({ storagePath: evolutionPath });
  const evaluator = new EvolutionEvaluator({ registry, storagePath: evaluationPath });
  const loader = new DynamicPluginLoader({ rootDir: pluginRoot, governance, registry: new PluginRegistry() });
  const active = await loader.discover({ manifest: fixtureManifest('com.example.active'), entryPath: 'active.mjs' });
  const inactive = await loader.discover({ manifest: fixtureManifest('com.example.inactive'), entryPath: 'inactive.mjs' });
  const failing = await loader.discover({ manifest: fixtureManifest('com.example.failing'), entryPath: 'failing.mjs' });
  const unauthorized = await loader.discover({ manifest: fixtureManifest('com.example.unauthorized'), entryPath: 'unauthorized.mjs' });
  await activate(governance, active.pluginId, evaluator, registry);
  await activate(governance, failing.pluginId, evaluator, registry);
  await activate(governance, unauthorized.pluginId, evaluator, registry);
  await governance.flush();

  let failModel = false;
  const server = createServer((_request, response) => {
    if (failModel) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture model failure' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write('data: {"choices":[{"delta":{"content":"dynamic task complete"},"finish_reason":null}]}\n\n');
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const taskArgs = [
    'task', '--provider', 'deepseek', '--prompt', '检查 README', '--workspace', workspace
  ];
  const taskEnv = {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
    HMCODEX_PLUGIN_GOVERNANCE_STORE: governancePath,
    HMCODEX_PLUGIN_ROOT: pluginRoot,
    HMCODEX_EVOLUTION_STORE: evolutionPath,
    HMCODEX_EVALUATION_STORE: evaluationPath,
    HMCODEX_TRAJECTORY_STORE: join(root, 'trajectory.jsonl'),
    HMCODEX_DECISION_TRACE_STORE: join(root, 'decision-trace.json')
  };
  const phase1 = await run(taskArgs, { ...taskEnv, HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY' });
  assert.equal(phase1.code, 0, phase1.stdout);
  const phase1Payload = JSON.parse(phase1.stdout.trim());
  assert.ok(phase1Payload.dynamicPlugins.every((plugin) => plugin.state === 'DISABLED'));
  await assert.rejects(readFile(importedMarker), { code: 'ENOENT' });
  const phase1Governance = JSON.parse(await readFile(governancePath, 'utf8'));
  assert.equal(phase1Governance.plugins.find((plugin) => plugin.pluginId === active.pluginId).state, 'ACTIVE');
  const directLoad = await run(['plugin', 'load', '--plugin-id', active.pluginId], {
    ...taskEnv, HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY'
  });
  assert.equal(directLoad.code, 1);
  assert.equal(JSON.parse(directLoad.stdout.trim()).error, 'RELEASE_CHANNEL_DYNAMIC_PLUGIN_DISABLED');
  await assert.rejects(readFile(importedMarker), { code: 'ENOENT' });
  const result = await run(taskArgs, taskEnv);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.text, 'dynamic task complete');
  assert.deepEqual(payload.dynamicPlugins.map(({ pluginId, state }) => ({ pluginId, state })), [
    { pluginId: active.pluginId, state: 'LOADED' },
    { pluginId: failing.pluginId, state: 'QUARANTINED' },
    { pluginId: unauthorized.pluginId, state: 'QUARANTINED' }
  ]);
  assert.deepEqual(payload.dynamicPlugins[0].contextGrant, {
    pluginId: active.pluginId,
    services: [],
    permissions: [],
    ceiling: 'CONTROLLED'
  });
  assert.equal(payload.dynamicPlugins.some(({ pluginId }) => pluginId === inactive.pluginId), false);
  assert.equal(await readFile(importedMarker, 'utf8'), 'imported');

  const persisted = JSON.parse(await readFile(governancePath, 'utf8'));
  assert.equal(persisted.plugins.find((plugin) => plugin.pluginId === active.pluginId).state, 'ACTIVE');
  assert.equal(persisted.plugins.find((plugin) => plugin.pluginId === inactive.pluginId).state, 'DISCOVERED');
  assert.equal(persisted.plugins.find((plugin) => plugin.pluginId === failing.pluginId).state, 'QUARANTINED');
  assert.equal(persisted.plugins.find((plugin) => plugin.pluginId === unauthorized.pluginId).state, 'QUARANTINED');

  // A new runtime must consult persisted rollback state before executing
  // even the plugin's top-level module code.
  const activeProposal = registry.list().find((proposal) => proposal.pluginId === active.pluginId);
  const online = new EvolutionEvaluator({ registry, storagePath: evaluationPath });
  await online.load();
  const samples = online.listOutcomes({ proposalId: activeProposal.proposalId });
  assert.equal(samples.length, 1);
  assert.deepEqual(samples[0].deploymentProposalIds, [activeProposal.proposalId]);
  assert.equal(online.cohort({ proposalId: activeProposal.proposalId }).outcomes.length, 1);
  assert.equal(samples[0].status, 'SUCCEEDED');
  assert.equal(payload.evolution.monitoring.length, 1);
  assert.equal(payload.evolution.monitoring[0].proposalId, activeProposal.proposalId);
  assert.equal(payload.evolution.monitoring[0].status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(online.list(activeProposal.proposalId).filter((report) => report.stage === 'ONLINE_MONITOR').length, 1);
  failModel = true;
  for (let index = 0; index < 2; index += 1) {
    const failed = await run([...taskArgs, '--events', 'stdout'], taskEnv);
    assert.equal(failed.code, 1, failed.stdout);
    const frames = failed.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const monitoring = frames.find((frame) => frame.kind === 'evolution.monitored');
    assert.ok(monitoring, failed.stdout);
    assert.equal(monitoring.payload.status, index === 0 ? 'INSUFFICIENT_EVIDENCE' : 'ROLLED_BACK');
    const state = JSON.parse(await readFile(evolutionPath, 'utf8'));
    assert.equal(state.proposals.find((entry) => entry.proposalId === activeProposal.proposalId).status,
      index === 0 ? 'ACTIVE' : 'ROLLED_BACK');
  }
  failModel = false;
  await writeFile(importedMarker, 'awaiting-next-task', 'utf8');
  const afterRollback = await run(taskArgs, taskEnv);
  assert.equal(afterRollback.code, 0, `${afterRollback.stderr}\n${afterRollback.stdout}`);
  const nextPayload = JSON.parse(afterRollback.stdout.trim());
  assert.equal(nextPayload.ok, true);
  const blocked = nextPayload.dynamicPlugins.find((plugin) => plugin.pluginId === active.pluginId);
  assert.equal(blocked.state, 'QUARANTINED');
  assert.equal(blocked.errorCode, 'PLUGIN_EVALUATION_INVALID');
  assert.equal(await readFile(importedMarker, 'utf8'), 'awaiting-next-task');
  const after = JSON.parse(await readFile(governancePath, 'utf8'));
  assert.equal(after.plugins.find((plugin) => plugin.pluginId === active.pluginId).state, 'QUARANTINED');
});
