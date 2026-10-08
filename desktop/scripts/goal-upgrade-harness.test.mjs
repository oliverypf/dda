import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGoalUpgradeHarness } from './goal-upgrade-harness.mjs';
import { runEvidenceProcess } from './goal-evidence-process.mjs';

const fixtureConfig = { protocol: 'chat-completions', model: 'fixture-active',
  apiKeyEnv: 'GOAL_UPGRADE_TEST_ONLY_KEY', baseURL: 'https://provider.invalid/v1' };
const configFile = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-upgrade-preflight-'));
  const path = join(directory, 'config.json');
  await writeFile(path, JSON.stringify(fixtureConfig));
  return { directory, path };
};

test('upgrade preflight rejects missing config, duplicate model and missing credential before inference', async () => {
  await assert.rejects(runGoalUpgradeHarness({ argv: [] }), /UPGRADE_LIVE_CONFIG_REQUIRED/u);
  const { path } = await configFile();
  await assert.rejects(runGoalUpgradeHarness({ argv: ['--live-config', path, '--strong-model', 'fixture-active'] }), /DISTINCT_ACTUAL_MODELS/u);
  await assert.rejects(runGoalUpgradeHarness({ argv: ['--live-config', path, '--strong-model', 'fixture-strong'] }), /LIVE_MODEL_KEY_MISSING:GOAL_UPGRADE_TEST_ONLY_KEY/u);
});

test('a setup failure after opening the first gateway closes it and exits without hanging', async () => {
  const { directory, path } = await configFile();
  const result = await runEvidenceProcess(process.execPath, [fileURLToPath(new URL('./goal-upgrade-harness.mjs', import.meta.url)),
    '--live-config', path, '--strong-model', 'fixture-strong', '--strong-pricing-config', join(directory, 'missing-price.json'),
    '--output', join(directory, 'report.json')], {
    env: { GOAL_UPGRADE_TEST_ONLY_KEY: 'local-test-only', JEV_API_KEY: 'local-test-only' }, timeoutMs: 5000
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/u);
});
