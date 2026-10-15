import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelConfig, resolveModelConfig } from '../src/model-config.mjs';
import {
  CATALOG_FETCH_TIMEOUT_MS,
  applyCatalogConfirmation,
  buildCatalogPickerRows,
  fetchProviderModels,
  joinModelsUrl,
  normalizeCatalogAddress,
  redactCatalogError,
  resolveCatalogTarget,
  runCatalogCli,
  saveProviderModelCatalog
} from '../src/provider-model-catalog.mjs';

const secret = 'sk-test-secret-value';

const baseDocument = () => ({
  schemaVersion: '1.0',
  provider: 'openai-chat',
  protocol: 'chat-completions',
  model: 'mimo-v2.5-pro',
  baseURL: 'https://backup.example/v1',
  endpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  headers: { 'X-Tenant': 'tenant-a' },
  sessionHeader: 'x-opencode-session',
  models: [{ modelId: 'keep-route', provider: 'openai-chat', protocol: 'chat-completions', model: 'mimo-v2.5-pro' }],
  roleBindings: { executor: 'keep-route' },
  decision: { enabled: true, model: 'jev-latest' },
  providerModelCatalogs: [
    {
      providerKey: 'opencode-go',
      models: [
        { id: 'minimax-m3', displayName: 'MiniMax-M3' },
        { id: 'local-only', displayName: 'Local Only' },
        { id: 'needs-name' }
      ]
    },
    {
      providerKey: 'deepseek',
      models: [{ id: 'deepseek-chat', displayName: 'DeepSeek Chat' }]
    }
  ]
});

const protectedSnapshot = (document) => {
  const { providerModelCatalogs, ...rest } = document;
  return { rest, otherCatalogs: providerModelCatalogs.filter((entry) => entry.providerKey !== 'opencode-go') };
};

const writeConfig = async (document) => {
  const directory = await mkdtemp(join(tmpdir(), 'catalog-'));
  const configPath = join(directory, 'model-config.json');
  const raw = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(configPath, raw);
  return { configPath, raw };
};

test('joins model URLs without doubling /v1 or /models', () => {
  const cases = [
    ['https://opencode.ai/zen/go/v1/', 'openai', 'https://opencode.ai/zen/go/v1/models'],
    ['https://opencode.ai/zen/go/v1/chat/completions', 'openai', 'https://opencode.ai/zen/go/v1/models'],
    ['https://api.openai.com/v1/responses', 'openai', 'https://api.openai.com/v1/models'],
    ['https://api.openai.com/v1/models', 'openai', 'https://api.openai.com/v1/models'],
    ['https://example.com/proxy', 'openai', 'https://example.com/proxy/v1/models'],
    ['https://api.deepseek.com', 'deepseek', 'https://api.deepseek.com/models'],
    ['https://api.deepseek.com/v1', 'deepseek', 'https://api.deepseek.com/v1/models'],
    ['https://api.deepseek.com/models', 'deepseek', 'https://api.deepseek.com/models']
  ];
  for (const [raw, kind, expected] of cases) {
    const normalized = normalizeCatalogAddress(raw);
    assert.equal(joinModelsUrl(normalized, kind), expected, raw);
    assert.equal(expected.includes('/v1/v1/models'), false);
    assert.equal(expected.includes('/models/v1/models'), false);
  }
});

test('derives providerKey from the normalized URL and ignores DeepSeek endpoint', () => {
  const endpointWins = resolveCatalogTarget({
    provider: 'openai-chat',
    baseURL: 'https://opencode.ai/zen/go/v1/',
    endpoint: 'https://elsewhere.example/v1',
    apiKeyEnv: 'FILE_KEY'
  });
  assert.equal(endpointWins.providerKey, 'openai-chat');
  assert.equal(endpointWins.modelsUrl, 'https://elsewhere.example/v1/models');
  assert.equal(endpointWins.apiKeyEnv, 'FILE_KEY');

  const opencode = resolveCatalogTarget({
    provider: 'openai-chat',
    baseURL: 'https://opencode.ai/zen/go/v1/'
  });
  assert.equal(opencode.providerKey, 'opencode-go');
  assert.equal(opencode.modelsUrl, 'https://opencode.ai/zen/go/v1/models');
  assert.equal(opencode.apiKeyEnv, 'OPENCODE_GO_API_KEY');

  const opencodeFromChatCompletions = resolveCatalogTarget({
    provider: 'compatible',
    baseURL: 'https://opencode.ai/zen/go/v1/chat/completions'
  });
  assert.equal(opencodeFromChatCompletions.providerKey, 'opencode-go');
  assert.equal(opencodeFromChatCompletions.modelsUrl, 'https://opencode.ai/zen/go/v1/models');

  const deepseek = resolveCatalogTarget({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/',
    endpoint: 'https://evil.example/v1'
  });
  assert.equal(deepseek.providerKey, 'deepseek');
  assert.equal(deepseek.modelsUrl, 'https://api.deepseek.com/models');
  assert.equal(deepseek.modelsUrl.includes('evil.example'), false);
  assert.equal(deepseek.apiKeyEnv, 'DEEPSEEK_API_KEY');

  const deepseekDefault = resolveCatalogTarget({ provider: 'deepseek', endpoint: 'https://evil.example/v1' });
  assert.equal(deepseekDefault.modelsUrl, 'https://api.deepseek.com/models');

  const fileKey = resolveCatalogTarget({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'FILE_DEEPSEEK_KEY'
  });
  assert.equal(fileKey.apiKeyEnv, 'FILE_DEEPSEEK_KEY');

  const compatible = resolveCatalogTarget({
    provider: 'compatible',
    baseURL: 'https://gateway.example/openai'
  });
  assert.equal(compatible.providerKey, 'compatible');
  assert.equal(compatible.modelsUrl, 'https://gateway.example/openai/v1/models');
  assert.equal(compatible.apiKeyEnv, undefined);

  assert.throws(() => resolveCatalogTarget({ provider: 'openai-chat' }), /CATALOG_ADDRESS_MISSING/);
  assert.throws(() => resolveCatalogTarget({
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1?token=secret'
  }), /CATALOG_ADDRESS_INVALID/);
  const lookalike = resolveCatalogTarget({
    provider: 'openai-chat',
    baseURL: 'https://opencode.ai.evil.example/zen/go/v1',
    apiKeyEnv: 'OTHER_KEY'
  });
  assert.equal(lookalike.providerKey, 'openai-chat');
  assert.notEqual(lookalike.origin, 'https://opencode.ai');
});

test('preserves an existing displayName and fills only a missing one', () => {
  const remote = [
    { id: 'minimax-m3', name: 'Remote Mini' },
    { id: 'qwen3.7-max', name: 'Qwen3.7 Max' },
    { id: 'owned-only', owned_by: 'org', object: 'model' }
  ];
  const catalog = [
    { id: 'minimax-m3', displayName: 'MiniMax-M3' },
    { id: 'needs-name' },
    { id: 'local-only', displayName: 'Local Only' }
  ];
  const rows = buildCatalogPickerRows({ catalogModels: catalog, remoteModels: remote });
  const named = rows.find((row) => row.id === 'minimax-m3');
  assert.equal(named.displayName, 'MiniMax-M3');
  assert.equal(named.checked, true);
  const filled = rows.find((row) => row.id === 'needs-name');
  assert.equal(filled.displayName, 'needs-name');
  assert.equal(filled.localOnly, true);
  const created = rows.find((row) => row.id === 'qwen3.7-max');
  assert.equal(created.displayName, 'Qwen3.7 Max');
  assert.equal(created.checked, false);
  const owned = rows.find((row) => row.id === 'owned-only');
  assert.equal(owned.displayName, 'owned-only');

  const kept = applyCatalogConfirmation({
    catalogModels: catalog,
    remoteModels: remote,
    checkedIds: ['minimax-m3', 'needs-name', 'local-only']
  });
  assert.deepEqual(kept.models, [
    { id: 'minimax-m3', displayName: 'MiniMax-M3' },
    { id: 'needs-name', displayName: 'needs-name' },
    { id: 'local-only', displayName: 'Local Only' }
  ]);

  const filledFromRemote = applyCatalogConfirmation({
    catalogModels: [{ id: 'qwen3.7-max' }],
    remoteModels: [{ id: 'qwen3.7-max', name: 'Qwen3.7 Max', owned_by: 'nope' }],
    checkedIds: ['qwen3.7-max']
  });
  assert.deepEqual(filledFromRemote.models, [{ id: 'qwen3.7-max', displayName: 'Qwen3.7 Max' }]);
});

test('deletes a local-only id only when it is unchecked on confirm', async () => {
  const { configPath, raw } = await writeConfig(baseDocument());
  const remote = [
    { id: 'minimax-m3', name: 'Remote Mini' },
    { id: 'qwen3.7-max', name: 'Qwen3.7 Max' }
  ];
  const fetched = await runCatalogCli({
    command: 'fetch',
    configPath,
    env: { OPENCODE_GO_API_KEY: secret },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: remote.map((item) => ({ ...item, owned_by: 'org' })) }) }),
    createSessionId: () => 'session-1'
  });
  assert.equal(fetched.ok, true);
  assert.equal(await readFile(configPath, 'utf8'), raw);
  const local = fetched.rows.find((row) => row.id === 'local-only');
  assert.equal(local.checked, true);
  assert.equal(local.localOnly, true);
  assert.equal(local.displayName, 'Local Only');

  const stillChecked = await saveProviderModelCatalog({
    configPath,
    providerKey: 'opencode-go',
    checkedIds: fetched.rows.filter((row) => row.checked).map((row) => row.id),
    remote: fetched.remote
  });
  assert.equal(stillChecked.ok, true);
  assert.ok(stillChecked.models.some((model) => model.id === 'local-only' && model.displayName === 'Local Only'));

  const removed = await saveProviderModelCatalog({
    configPath,
    providerKey: 'opencode-go',
    checkedIds: ['minimax-m3', 'needs-name'],
    remote: fetched.remote
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.models.some((model) => model.id === 'local-only'), false);
  assert.deepEqual(removed.models.find((model) => model.id === 'minimax-m3'), { id: 'minimax-m3', displayName: 'MiniMax-M3' });
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.providerModelCatalogs.find((entry) => entry.providerKey === 'deepseek'), {
    providerKey: 'deepseek',
    models: [{ id: 'deepseek-chat', displayName: 'DeepSeek Chat' }]
  });
  assert.equal(saved.models[0].modelId, 'keep-route');
  assert.equal(saved.roleBindings.executor, 'keep-route');
  assert.equal(saved.headers['X-Tenant'], 'tenant-a');
  assert.equal(saved.model, 'mimo-v2.5-pro');
  assert.equal(saved.endpoint, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(saved.baseURL, 'https://backup.example/v1');
});

test('failed fetch leaves the catalog and route fields untouched', async () => {
  const { configPath, raw } = await writeConfig(baseDocument());
  const cases = [
    async () => { throw new Error(`Bearer ${secret} https://user:pass@evil.example/v1`); },
    async () => ({ ok: false, status: 401, json: async () => ({ error: secret }) }),
    async () => ({ ok: true, json: async () => { throw new Error('not json'); } }),
    async () => ({ ok: true, json: async () => ({ object: 'list' }) }),
    async (_url, init) => {
      await new Promise((resolve) => { init.signal.addEventListener('abort', resolve); });
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
  ];
  for (const fetchImpl of cases) {
    const result = await runCatalogCli({
      command: 'fetch',
      configPath,
      env: { OPENCODE_GO_API_KEY: secret },
      fetchImpl,
      createSessionId: () => 'session-1',
      timeoutMs: 20
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.includes(secret), false);
    assert.equal(/authorization/iu.test(result.error), false);
    assert.equal(result.error.includes('user:pass'), false);
    assert.equal(await readFile(configPath, 'utf8'), raw);
  }
  const missingKey = await fetchProviderModels({
    route: { provider: 'compatible', baseURL: 'https://gateway.example/v1' },
    env: { OPENAI_API_KEY: secret },
    fetchImpl: async () => { throw new Error('should not be called'); },
    createSessionId: () => 'nope'
  });
  assert.equal(missingKey.ok, false);
  assert.equal(missingKey.error.includes(secret), false);
});

test('fetch uses bearer auth, file headers, and a generated session id', async () => {
  let captured;
  const result = await fetchProviderModels({
    route: {
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      endpoint: 'https://evil.example/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      sessionHeader: 'x-session-id',
      headers: { 'X-Tenant': 'tenant-a' }
    },
    headers: { 'X-Tenant': 'tenant-a' },
    env: { DEEPSEEK_API_KEY: secret },
    createSessionId: () => 'generated-session',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ data: [] }) };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.providerKey, 'deepseek');
  assert.equal(captured.url, 'https://api.deepseek.com/models');
  assert.equal(captured.init.headers.authorization, `Bearer ${secret}`);
  assert.equal(captured.init.headers['X-Tenant'], 'tenant-a');
  assert.equal(captured.init.headers['x-session-id'], 'generated-session');
  assert.notEqual(captured.init.headers['x-session-id'], 'x-session-id');
  assert.equal(result.remote.length, 0);
  assert.equal(CATALOG_FETCH_TIMEOUT_MS, 30_000);
  assert.equal(redactCatalogError(`Bearer ${secret}`).includes(secret), false);
});

test('confirm does not write route fields and does not use save_model_config', async () => {
  const original = baseDocument();
  const { configPath } = await writeConfig(original);
  const saved = await saveProviderModelCatalog({
    configPath,
    providerKey: 'opencode-go',
    checkedIds: ['minimax-m3', 'local-only', 'needs-name', 'qwen3.7-max', 'not-in-picker'],
    remote: [{ id: 'qwen3.7-max', name: 'Qwen3.7 Max' }, { id: 'minimax-m3', name: 'Should Not Replace' }]
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.models.find((model) => model.id === 'minimax-m3'), { id: 'minimax-m3', displayName: 'MiniMax-M3' });
  assert.deepEqual(saved.models.find((model) => model.id === 'qwen3.7-max'), { id: 'qwen3.7-max', displayName: 'Qwen3.7 Max' });
  assert.equal(saved.models.some((model) => model.id === 'not-in-picker'), false);
  const document = JSON.parse(await readFile(configPath, 'utf8'));
  const before = protectedSnapshot(original);
  const after = protectedSnapshot(document);
  assert.deepEqual(after.rest, before.rest);
  assert.deepEqual(after.otherCatalogs, before.otherCatalogs);

  const bridge = await readFile(new URL('../../desktop/src/services/desktopBridge.ts', import.meta.url), 'utf8');
  const session = await readFile(new URL('../../desktop/src/domain/provider-catalog-session.ts', import.meta.url), 'utf8');
  const saveStart = bridge.indexOf('saveProviderModelCatalog');
  const saveBody = bridge.slice(saveStart, bridge.indexOf('async desktopSettings'));
  assert.match(saveBody, /PROVIDER_CATALOG_COMMANDS\.save/);
  assert.doesNotMatch(saveBody, /save_model_config/);
  assert.match(session, /save:\s*'save_provider_model_catalog'/);
  const rust = await readFile(new URL('../../desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const rustStart = rust.indexOf('async fn save_provider_model_catalog');
  assert.notEqual(rustStart, -1);
  const rustBody = rust.slice(rustStart, rust.indexOf('\nfn ', rustStart + 10));
  assert.match(rustBody, /run_catalog_cli/);
  assert.doesNotMatch(rustBody, /persist_model_config|save_model_config/);
  const cliStart = rust.indexOf('fn run_catalog_cli');
  const cliBody = rust.slice(cliStart, rust.indexOf('\nfn ', cliStart + 10));
  assert.match(cliBody, /provider-model-catalog-cli/);
  assert.doesNotMatch(cliBody, /persist_model_config|save_model_config/);
  const persistStart = rust.indexOf('for key in [');
  const persistKeys = rust.slice(persistStart, rust.indexOf(']', persistStart));
  assert.equal(persistKeys.includes('providerModelCatalogs'), false);
});

test('a failed confirm and a route change leave every catalog untouched', async () => {
  const original = baseDocument();
  const seeded = await writeConfig(original);
  original.padding = 'x'.repeat(Math.max(0, 30_000 - seeded.raw.length));
  const { configPath, raw } = await writeConfig(original);
  assert.ok(Buffer.byteLength(raw) < 32 * 1024);
  const tooBig = await saveProviderModelCatalog({
    configPath,
    providerKey: 'opencode-go',
    checkedIds: Array.from({ length: 200 }, (_value, index) => `model-${index}`),
    remote: Array.from({ length: 200 }, (_value, index) => ({ id: `model-${index}`, name: 'n'.repeat(80) }))
  });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /32 KB/);
  assert.equal(await readFile(configPath, 'utf8'), raw);

  const invalidDocument = baseDocument();
  invalidDocument.providerModelCatalogs[0].models.push({ id: 'bad id', displayName: 'Bad' });
  const invalidFile = await writeConfig(invalidDocument);
  const invalid = await saveProviderModelCatalog({
    configPath: invalidFile.configPath,
    providerKey: 'opencode-go',
    checkedIds: ['minimax-m3', 'bad id'],
    remote: []
  });
  assert.equal(invalid.ok, false);
  assert.equal(await readFile(invalidFile.configPath, 'utf8'), invalidFile.raw);

  const switched = structuredClone(original);
  switched.provider = 'deepseek';
  switched.baseURL = 'https://api.deepseek.com';
  delete switched.endpoint;
  const switchedFile = await writeConfig(switched);
  const rejected = await saveProviderModelCatalog({
    configPath: switchedFile.configPath,
    providerKey: 'opencode-go',
    checkedIds: [],
    remote: []
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /未写入/);
  const kept = JSON.parse(await readFile(switchedFile.configPath, 'utf8'));
  assert.deepEqual(kept.providerModelCatalogs, switched.providerModelCatalogs);
  assert.equal(kept.provider, 'deepseek');
  assert.equal(kept.models[0].modelId, 'keep-route');
  assert.equal(kept.roleBindings.executor, 'keep-route');
});

test('runtime load allows providerModelCatalogs and still passes them through resolve', async () => {
  const { configPath } = await writeConfig({
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'fixture',
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    models: [{ id: 'fixture', provider: 'openai-chat', protocol: 'chat-completions', model: 'fixture' }],
    roleBindings: { executor: 'fixture' },
    providerModelCatalogs: [{ providerKey: 'opencode-go', models: [{ id: 'qwen3.7-max', displayName: 'Qwen3.7 Max' }] }]
  });
  const loaded = await loadModelConfig(configPath);
  assert.equal(loaded.providerModelCatalogs[0].providerKey, 'opencode-go');
  assert.equal(loaded.models[0].modelId, 'fixture');
  assert.equal(loaded.roleBindings.executor, 'fixture');
  const resolved = resolveModelConfig({
    fileConfig: loaded,
    overrides: { provider: 'deepseek' },
    env: {}
  });
  assert.equal(resolved.provider, 'deepseek');
  assert.equal(resolved.providerModelCatalogs[0].models[0].displayName, 'Qwen3.7 Max');
  const { writeFile: write } = await import('node:fs/promises');
  await write(configPath, JSON.stringify({ providerModelCatalogs: [{ providerKey: 'opencode-go', models: [{ id: 'ok', extra: true }] }] }));
  await assert.rejects(loadModelConfig(configPath), /MODEL_CONFIG_UNKNOWN_FIELD:providerModelCatalogs\.models\.extra/);
});
