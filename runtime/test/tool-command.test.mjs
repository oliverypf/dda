import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

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

test('lists and invokes read-only workspace tools without a model request', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-tools-'));
  await writeFile(join(workspace, 'README.md'), '# hello\n');
  await writeFile(join(workspace, '.env'), 'API_KEY=must-not-leak\n');

  const listed = await run(['tools', '--workspace', workspace], {
    OPENAI_API_KEY: 'must-not-be-read'
  });
  assert.equal(listed.code, 0, `${listed.stderr}\n${listed.stdout}`);
  const listing = JSON.parse(listed.stdout.trim());
  assert.equal(listing.ok, true);
  assert.deepEqual(listing.tools.map((tool) => tool.name), ['workspace.list', 'workspace.read']);
  assert.equal(JSON.stringify(listing).includes('must-not-leak'), false);

  const read = await run([
    'tools', '--workspace', workspace, '--tool', 'workspace.read',
    '--input', JSON.stringify({ path: 'README.md', maxChars: 4 })
  ]);
  assert.equal(read.code, 0, `${read.stderr}\n${read.stdout}`);
  const payload = JSON.parse(read.stdout.trim());
  assert.deepEqual(payload.result, {
    path: 'README.md',
    sizeBytes: 8,
    digest: 'sha256:9e8b62f81ea5c66fa06ee53da032751386b37702153070c0e14dd1d316282fa7',
    content: '# he',
    truncated: true
  });
});

test('returns a stable error and no content for a sensitive file', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-tools-sensitive-'));
  await writeFile(join(workspace, '.env'), 'API_KEY=must-not-leak\n');
  const result = await run([
    'tools', '--workspace', workspace, '--tool', 'workspace.read',
    '--input', JSON.stringify({ path: '.env' })
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /WORKSPACE_SENSITIVE_PATH/);
  assert.equal(result.stdout.includes('must-not-leak'), false);
});
