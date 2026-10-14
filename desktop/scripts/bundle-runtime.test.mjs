import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { projectPaths } from './windows-path.mjs';

test('bundled runtime starts from resources without the source checkout', async (t) => {
  const { desktopRoot } = projectPaths(import.meta.url);
  const tauriRoot = join(desktopRoot, 'src-tauri');
  const config = JSON.parse(await readFile(join(tauriRoot, 'tauri.conf.json'), 'utf8'));
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'dda-bundle-runtime-'));
  t.after(async () => {
    // Only remove the specific temporary directory created by this test.
    assert.equal(dirname(await realpath(root)), tempRoot);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const bundleRoot = join(root, 'bundle');
  await mkdir(bundleRoot);
  // Copy real files according to the installer manifest. Symlinks or imports
  // from the checkout would conceal missing shared packages in the bundle.
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    const target = resolve(bundleRoot, destination);
    const relativeTarget = relative(bundleRoot, target);
    assert.ok(relativeTarget && !relativeTarget.startsWith('..') && !isAbsolute(relativeTarget));
    await cp(resolve(tauriRoot, source), target, { recursive: true, dereference: true });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|temp|tmp)$/i.test(key)));
  env.LOCALAPPDATA = join(root, 'user-data');
  env.DDA_PLATFORM = 'windows-desktop';
  const runtimeRoot = join(bundleRoot, 'runtime');
  const result = spawnSync(process.execPath, [
    join(runtimeRoot, 'src', 'index.mjs'), 'health',
    '--config', join(runtimeRoot, 'model-config.example.json')
  ], {
    cwd: runtimeRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const health = JSON.parse(result.stdout.trim());
  assert.equal(health.ok, true, result.stdout);
  assert.equal(health.config.loaded, true);
  assert.ok(health.plugins.length > 0);
});
