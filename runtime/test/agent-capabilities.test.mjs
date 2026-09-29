import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tool-registry.mjs';
import { registerExecutorTools } from '../src/controlled-tools.mjs';
import { loadMcpConfig } from '../src/mcp-host.mjs';
import { registerPlaywrightTools } from '../src/playwright-host.mjs';
import { applyTextPatch, textDigest, unifiedTextDiff } from '../src/text-patch.mjs';

test('text patch is exact, digest guarded, and produces a unified diff', () => {
  const before = 'one\ntwo\n';
  const after = applyTextPatch(before, [{ oldText: 'two', newText: 'three' }], textDigest(before));
  assert.equal(after, 'one\nthree\n');
  assert.match(unifiedTextDiff(before, after, 'README.md'), /--- a\/README\.md/);
  assert.throws(() => applyTextPatch(before, [{ oldText: 'two', newText: 'three' }], 'sha256:stale'), /PATCH_STALE_DIGEST/);
});

test('file.patch and file.diff stay behind the existing executor lease path', async () => {
  let content = 'alpha\nbeta\n';
  const workspace = { read: async (path) => ({ path, content, digest: textDigest(content) }) };
  const executor = {
    shell: async () => ({}), test: async () => ({}),
    writeFile: async ({ path, content: next }, { lease }) => {
      content = next;
      return { ok: true, action: 'write_file', path, bytesWritten: Buffer.byteLength(next), contentDigest: textDigest(next), lease: lease?.id ?? null };
    }
  };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, { workspace, leaseProvider: async () => ({ id: 'lease-1' }) });
  const diff = await registry.invoke('file.diff', { path: 'README.md', baseContent: 'alpha\ngamma\n' });
  assert.equal(diff.changed, true);
  const patched = await registry.invoke('file.patch', {
    path: 'README.md', expectedDigest: textDigest(content),
    replacements: [{ oldText: 'beta', newText: 'gamma' }]
  });
  assert.equal(patched.action, 'patch_file');
  assert.equal(content, 'alpha\ngamma\n');
});

test('MCP config is static and rejects credentials or arbitrary server shapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-mcp-config-'));
  const path = join(directory, 'mcp.json');
  await writeFile(path, JSON.stringify({ servers: [{ id: 'docs', transport: 'http', url: 'https://docs.example.test/mcp', readOnlyTools: ['search'] }] }));
  const config = await loadMcpConfig(path);
  assert.equal(config.servers[0].id, 'docs');
  await writeFile(path, JSON.stringify({ servers: [{ id: 'bad', transport: 'stdio', command: 'node', env: { API_KEY: 'secret' } }] }));
  await assert.rejects(loadMcpConfig(path), /MCP_CONFIG_INVALID/);
  await writeFile(path, JSON.stringify({ servers: [{ id: 'private', transport: 'http', url: 'http://127.0.0.1:8080/mcp' }] }));
  await assert.rejects(loadMcpConfig(path), /MCP_CONFIG_INVALID/);
});

test('browser.open uses the isolated worker interface and host allowlist', async () => {
  const calls = [];
  const worker = { open: async (input) => { calls.push(input); return { ok: true, url: input.url, text: 'docs' }; } };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerPlaywrightTools(registry, worker, {
    leaseProvider: async () => ({ id: 'network-lease' }),
    runId: 'run-1', targets: [{ host: 'docs.example.test', scheme: 'https', methods: ['GET'] }]
  });
  const result = await registry.invoke('browser.open', { url: 'https://docs.example.test/start' });
  assert.equal(result.text, 'docs');
  assert.equal(calls[0].runId, 'run-1');
  await assert.rejects(registry.invoke('browser.open', { url: 'https://other.example.test/' }), /TOOL_HANDLER_FAILED/);
});
