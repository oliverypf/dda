import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

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

const parse = (result) => JSON.parse(result.stdout.trim());

const writeEvidence = async (root, name, payload) => {
  const filePath = join(root, name);
  await writeFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  return filePath;
};

test('plugin versions fail closed without evidence and persist activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-version-cli-'));
  const env = { HMCODEX_PLUGIN_GOVERNANCE_STORE: join(root, 'plugin-governance.json') };
  const pluginId = 'com.example.version-cli';
  const activateArgs = (version, evidence) => [
    'plugin', 'activate-version', '--plugin-id', pluginId, '--version', version,
    '--migration-plan', evidence.migration, '--self-test-report', evidence.selfTest,
    '--shadow-report', evidence.shadow
  ];
  const noEvidence = await run(['plugin', 'activate-version', '--plugin-id', pluginId, '--version', '1.0.0'], env);
  assert.equal(noEvidence.code, 1);
  assert.equal(parse(noEvidence).error, 'PLUGIN_MIGRATION_EVIDENCE_REQUIRED');
  for (const version of ['1.0.0', '2.0.0']) {
    const installed = await run([
      'plugin', 'install-version', '--plugin-id', pluginId, '--version', version,
      '--package-digest', `sha256:${version.padEnd(64, '0')}`
    ], env);
    assert.equal(installed.code, 0, `${installed.stderr}\n${installed.stdout}`);
    assert.equal(parse(installed).version.state, 'INSTALLED');
  }
  const duplicate = await run([
    'plugin', 'install-version', '--plugin-id', pluginId, '--version', '1.0.0',
    '--package-digest', `sha256:${'c'.repeat(64)}`
  ], env);
  assert.equal(duplicate.code, 1);
  assert.equal(parse(duplicate).error, 'PLUGIN_VERSION_ALREADY_INSTALLED');

  const migration = await writeEvidence(root, 'migration.json', { ok: true, config: { featureFlag: true } });
  const selfTest = await writeEvidence(root, 'self-test.json', { ok: true });
  const shadow = await writeEvidence(root, 'shadow.json', { ok: true });
  const noConfig = await writeEvidence(root, 'migration-no-config.json', { ok: true });
  const failedSelfTest = await writeEvidence(root, 'self-test-failed.json', { ok: false });
  const invalidMigration = await run(activateArgs('1.0.0', { migration: noConfig, selfTest, shadow }), env);
  assert.equal(invalidMigration.code, 1);
  assert.equal(parse(invalidMigration).error, 'PLUGIN_MIGRATION_EVIDENCE_INVALID');
  const failingEvidence = await run(activateArgs('1.0.0', { migration, selfTest: failedSelfTest, shadow }), env);
  assert.equal(failingEvidence.code, 1);
  assert.equal(parse(failingEvidence).error, 'PLUGIN_EVIDENCE_NOT_OK');

  const evidence = { migration, selfTest, shadow };
  const first = await run(activateArgs('1.0.0', evidence), env);
  assert.equal(first.code, 0, `${first.stderr}\n${first.stdout}`);
  assert.equal(parse(first).activation.active.version, '1.0.0');
  const idempotent = await run(activateArgs('1.0.0', evidence), env);
  assert.equal(parse(idempotent).activation.idempotent, true);
  const second = await run(activateArgs('2.0.0', evidence), env);
  assert.equal(second.code, 0, `${second.stderr}\n${second.stdout}`);
  const secondPayload = parse(second);
  assert.equal(secondPayload.activation.active.version, '2.0.0');
  assert.equal(secondPayload.activation.previous.version, '1.0.0');
  assert.equal(secondPayload.activation.previous.state, 'ROLLED_BACK_AVAILABLE');

  const listed = await run(['plugin', 'versions', '--plugin-id', pluginId], env);
  assert.equal(listed.code, 0, `${listed.stderr}\n${listed.stdout}`);
  const states = Object.fromEntries(parse(listed).versions.map((item) => [item.version, item.state]));
  assert.deepEqual(states, { '1.0.0': 'ROLLED_BACK_AVAILABLE', '2.0.0': 'ACTIVE' });

  // The desktop governance panel reads the version lifecycle from the plugin
  // list command, so the active pointer must survive a process restart too.
  const governance = await run(['plugin', '--operation', 'list'], env);
  assert.equal(governance.code, 0, `${governance.stderr}\n${governance.stdout}`);
  const lifecycle = parse(governance).versionLifecycle;
  assert.equal(lifecycle.schemaVersion, '1.0');
  assert.equal(lifecycle.active[pluginId], `${pluginId}@2.0.0`);
  assert.deepEqual(
    Object.fromEntries(lifecycle.versions.map((item) => [item.version, item.state])),
    { '1.0.0': 'ROLLED_BACK_AVAILABLE', '2.0.0': 'ACTIVE' }
  );

  const rolledBack = await run(['plugin', 'rollback-version', '--plugin-id', pluginId], env);
  assert.equal(rolledBack.code, 0, `${rolledBack.stderr}\n${rolledBack.stdout}`);
  assert.equal(parse(rolledBack).active.version, '1.0.0');
  const afterRestart = await run(['plugin', 'versions', '--plugin-id', pluginId], env);
  const restarted = parse(afterRestart);
  assert.equal(restarted.active.version, '1.0.0');
  assert.deepEqual(
    Object.fromEntries(restarted.versions.map((item) => [item.version, item.state])),
    { '1.0.0': 'ACTIVE', '2.0.0': 'ROLLED_BACK' }
  );
  const noPrevious = await run(['plugin', 'rollback-version', '--plugin-id', pluginId], env);
  assert.equal(noPrevious.code, 1);
  assert.equal(parse(noPrevious).error, 'PLUGIN_PREVIOUS_VERSION_UNAVAILABLE');
});
