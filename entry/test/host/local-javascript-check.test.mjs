import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadArkTS } from './sdk-host.mjs';

const { checkJavaScript } = loadArkTS('services/LocalJavaScriptCheck');
const { runProjectCommand } = loadArkTS('services/LocalCommandExecutor');
const { LocalWorkspace } = loadArkTS('services/LocalWorkspace');

test('vendored Acorn matches the pinned ESM distribution', async () => {
  const asset = await readFile(new URL('../../src/main/ets/vendor/acorn/acorn.js', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(asset.replaceAll('\r\n', '\n')).digest('hex'),
    'b4c8c70200e72bae33cf1085e0ecb1e792c1b6924ed50cab817caf14f51bb249');
});

test('check-js matches Node syntax checking on common script and module fixtures without running code', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dda-check-js-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = new LocalWorkspace({ filesDir: dir });
  await workspace.initialize();
  await writeFile(join(dir, 'package.json'), '{"type":"commonjs"}');
  const cases = [
    ['good.cjs', "#!/usr/bin/env node\nthrow new Error('must never run');\nmodule.exports = a => a?.name ?? 'ok';", true],
    ['good.js', 'class Sample { #counter = 0; next() { return ++this.#counter; } }\n', true],
    ['good.mjs', "import { value } from './unavailable.mjs';\nexport default await value();", true],
    ['bad.js', 'const valid = 42;\nconst missing = ;', false],
    ['bad.cjs', 'function a() {\n  const = 3;\n}', false],
    ['bad.mjs', 'export const value = ', false]
  ];
  for (const [name, source, valid] of cases) {
    const path = '/' + name;
    await workspace.createFile(path, source);
    let nodeAccepts = true;
    try { await promisify(execFile)(process.execPath, ['--check', join(dir, 'workspace', name)]); }
    catch (error) { assert.equal(error.code, 1); nodeAccepts = false; }
    assert.equal(nodeAccepts, valid, name);
    const result = await runProjectCommand(workspace, 'check-js', [path]);
    assert.equal(result.exitCode, nodeAccepts ? 0 : 1, name);
    if (valid) { assert.match(result.stdout, /syntax OK/); }
    else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^\/[^:]+:\d+:\d+: /);
      if (name === 'bad.js') { assert.match(result.stderr, /^\/bad\.js:2:17: /); }
    }
  }
});

test('module mode, language edition, extension and UTF-8 work bound are explicit', () => {
  assert.match(checkJavaScript('/module.js', 'export const x = 1;'), /module/);
  assert.match(checkJavaScript('/module.cjs', 'return 3;'), /return/);
  assert.equal(checkJavaScript('/module.mjs', 'export default await Promise.resolve(1);'), '');
  assert.match(checkJavaScript('/old.mjs', 'using x = resource;'), /:1:\d+:/);
  assert.match(checkJavaScript('/unsupported.ts', 'let x: number = 1;'), /请指定/);
  assert.equal(checkJavaScript('/limit.js', ' '.repeat(65536)), '');
  assert.match(checkJavaScript('/large.js', '中'.repeat(21846)), /64 KiB/);
});

test('nearest in-project manifest controls .js mode; explicit extensions and malformed manifests are handled locally', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dda-check-js-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workspace = new LocalWorkspace({ filesDir: dir });
  await workspace.initialize();
  const probe = 'export default await Promise.resolve(1);';
  const check = path => runProjectCommand(workspace, 'check-js', [path]);
  // A package outside the selected project must have no influence on it.
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await workspace.createFile('/bare.js', probe);
  assert.equal((await check('/bare.js')).exitCode, 1);
  await workspace.createFile('/package.json', '{"type":"module"}');
  await workspace.createFile('/lib/deep.js', probe);
  await workspace.createFile('/legacy/package.json', '{"type":"commonjs"}');
  await workspace.createFile('/legacy/invalid.js', probe);
  await workspace.createFile('/legacy/sub/ok.js', 'exports.value = 2;');
  await workspace.createFile('/fresh/package.json', '{}');
  await workspace.createFile('/fresh/default.js', probe);
  for (const path of ['/bare.js', '/lib/deep.js', '/legacy/invalid.js', '/legacy/sub/ok.js']) {
    let status = 0;
    try { await promisify(execFile)(process.execPath, ['--check', join(dir, 'workspace', path)]); }
    catch (error) { assert.equal(error.code, 1); status = 1; }
    assert.equal((await check(path)).exitCode, status, path);
  }
  assert.equal((await check('/fresh/default.js')).exitCode, 1);
  await workspace.createFile('/broken/package.json', '{"private-field-must-not-leak":');
  await workspace.createFile('/broken/needs-manifest.js', probe);
  const bad = await check('/broken/needs-manifest.js');
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /\/broken\/package\.json.+JSON/);
  assert(!bad.stderr.includes('private-field'));
  await workspace.createFile('/broken/direct.mjs', probe);
  await workspace.createFile('/broken/direct.cjs', probe);
  assert.equal((await check('/broken/direct.mjs')).exitCode, 0);
  assert.match((await check('/broken/direct.cjs')).stderr, /direct\.cjs:1:1:/);
});
