import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultModelConfigPath,
  loadModelConfig,
  resolveModelConfig
} from '../src/model-config.mjs';

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

test('uses OpenCode Go Chat Completions defaults when no configuration is provided', () => {
  assert.deepEqual(resolveModelConfig({ env: {} }), {
    schemaVersion: '1.0',
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'mimo-v2.5-pro',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    sessionHeader: 'x-opencode-session'
  });
});

test('preserves extra request headers and rejects unsafe header configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-headers-'));
  const configPath = join(directory, 'model-config.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'header-model',
    baseURL: 'https://gateway.example/v1',
    apiKeyEnv: 'HEADER_KEY',
    headers: { 'x-custom-routing': 'tenant-a' },
    sessionHeader: 'x-session-id'
  }));
  assert.deepEqual(await loadModelConfig(configPath), {
    schemaVersion: '1.0',
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'header-model',
    baseURL: 'https://gateway.example/v1',
    apiKeyEnv: 'HEADER_KEY',
    headers: { 'x-custom-routing': 'tenant-a' },
    sessionHeader: 'x-session-id'
  });
  await writeFile(configPath, JSON.stringify({ headers: { authorization: 'leak' } }));
  await assert.rejects(loadModelConfig(configPath), /MODEL_CONFIG_INVALID_FIELD:headers.authorization/);
  await writeFile(configPath, JSON.stringify({ headers: { 'x-test': 'bad\r\ninject' } }));
  await assert.rejects(loadModelConfig(configPath), /MODEL_CONFIG_INVALID_FIELD:headers.x-test/);
  await writeFile(configPath, JSON.stringify({ sessionHeader: 'content-type' }));
  await assert.rejects(loadModelConfig(configPath), /MODEL_CONFIG_INVALID_FIELD:sessionHeader/);
});

test('does not send the default session header when the route is overridden', () => {
  const resolved = resolveModelConfig({ overrides: { provider: 'openai', protocol: 'responses' }, env: {} });
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.sessionHeader, undefined);
});

test('gives the JSON file priority over legacy environment variables and CLI priority over both', () => {
  const fileConfig = {
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'file-model',
    baseURL: 'https://file.example/v1',
    apiKeyEnv: 'FILE_KEY'
  };
  const env = {
    HMCODEX_MODEL_PROVIDER: 'compatible',
    HMCODEX_MODEL_PROTOCOL: 'responses',
    HMCODEX_MODEL: 'env-model',
    HMCODEX_MODEL_BASE_URL: 'https://env.example/v1',
    HMCODEX_MODEL_API_KEY_ENV: 'ENV_KEY'
  };
  assert.deepEqual(resolveModelConfig({ fileConfig, env }), {
    schemaVersion: '1.0',
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'file-model',
    baseURL: 'https://file.example/v1',
    apiKeyEnv: 'FILE_KEY'
  });
  assert.deepEqual(resolveModelConfig({ fileConfig, env, overrides: {
    provider: 'openai',
    protocol: 'responses',
    model: 'cli-model',
    endpoint: 'https://cli.example/responses',
    apiKeyEnv: 'CLI_KEY'
  } }), {
    schemaVersion: '1.0',
    provider: 'openai',
    protocol: 'responses',
    model: 'cli-model',
    baseURL: 'https://file.example/v1',
    endpoint: 'https://cli.example/responses',
    apiKeyEnv: 'CLI_KEY'
  });
});

test('selects DeepSeek-specific defaults after provider resolution', () => {
  const resolved = resolveModelConfig({
    fileConfig: { provider: 'deepseek' },
    env: { OPENAI_MODEL: 'wrong-model', DEEPSEEK_MODEL: 'deepseek-reasoner', DEEPSEEK_BASE_URL: 'https://deepseek.example' }
  });
  assert.deepEqual(resolved, {
    schemaVersion: '1.0',
    provider: 'deepseek',
    protocol: 'deepseek-harness',
    model: 'deepseek-reasoner',
    baseURL: 'https://deepseek.example',
    apiKeyEnv: 'DEEPSEEK_API_KEY'
  });
});

test('does not carry provider-specific file settings across an explicit provider switch', () => {
  assert.deepEqual(resolveModelConfig({
    fileConfig: {
      provider: 'openai',
      protocol: 'responses',
      model: 'file-openai-model',
      baseURL: 'https://file-openai.example/v1',
      endpoint: 'https://file-openai.example/v1/responses',
      apiKeyEnv: 'FILE_OPENAI_KEY'
    },
    overrides: { provider: 'deepseek' },
    env: {
      DEEPSEEK_MODEL: 'deepseek-chat',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.example',
      DEEPSEEK_API_KEY: 'deepseek-key'
    }
  }), {
    schemaVersion: '1.0',
    provider: 'deepseek',
    protocol: 'deepseek-harness',
    model: 'deepseek-chat',
    baseURL: 'https://api.deepseek.example',
    apiKeyEnv: 'DEEPSEEK_API_KEY'
  });
});

test('does not carry a protocol-specific endpoint across an explicit protocol switch', () => {
  assert.deepEqual(resolveModelConfig({
    fileConfig: {
      provider: 'openai',
      protocol: 'responses',
      model: 'file-model',
      endpoint: 'https://gateway.example/v1/responses',
      apiKeyEnv: 'FILE_KEY'
    },
    overrides: { provider: 'openai-chat' },
    env: { OPENAI_MODEL: 'chat-model', OPENAI_BASE_URL: 'https://gateway.example/v1' }
  }), {
    schemaVersion: '1.0',
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'file-model',
    baseURL: 'https://gateway.example/v1',
    apiKeyEnv: 'FILE_KEY'
  });
});

test('loads a valid JSON config and rejects invalid config fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-config-'));
  const configPath = join(directory, 'model-config.json');
  await writeFile(configPath, JSON.stringify({ provider: 'openai', protocol: 'responses', model: 'fixture' }));
  assert.deepEqual(await loadModelConfig(configPath), {
    schemaVersion: '1.0', provider: 'openai', protocol: 'responses', model: 'fixture'
  });
  await writeFile(configPath, JSON.stringify({ provider: 'openai', unknown: true }));
  await assert.rejects(loadModelConfig(configPath), /MODEL_CONFIG_UNKNOWN_FIELD:unknown/);
  await writeFile(configPath, JSON.stringify({ endpoint: 'file:///tmp/model' }));
  await assert.rejects(loadModelConfig(configPath), /MODEL_CONFIG_INVALID_FIELD:endpoint/);
});

test('uses the Windows user config location when available', () => {
  assert.equal(
    defaultModelConfigPath({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }),
    'C:\\Users\\tester\\AppData\\Local\\hmCodex\\model-config.json'
  );
});

test('health reports the resolved route without requiring an API key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-health-'));
  const configPath = join(directory, 'model-config.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'health-model',
    endpoint: 'https://gateway.example/v1/chat/completions',
    apiKeyEnv: 'HEALTH_KEY'
  }));
  const result = await run(['health', '--config', configPath], {
    HMCODEX_MODEL_PROVIDER: 'deepseek',
    HMCODEX_MODEL: 'wrong-model'
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.model, {
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'health-model'
  });
  assert.equal(payload.config.loaded, true);
  assert.equal(payload.config.path, configPath);
  assert.equal(payload.runtime.node.startsWith('v'), true);

  const overrideResult = await run([
    'health', '--config', configPath, '--provider', 'compatible', '--protocol', 'responses', '--model', 'cli-health-model'
  ]);
  assert.equal(overrideResult.code, 0, `${overrideResult.stderr}\n${overrideResult.stdout}`);
  assert.deepEqual(JSON.parse(overrideResult.stdout.trim()).model, {
    provider: 'compatible',
    protocol: 'responses',
    model: 'cli-health-model'
  });
});
