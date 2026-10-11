import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { buildTarball, stageArtifact } from '../scripts/pack.mjs';

const execFileAsync = promisify(execFile);
const NODE_DIR = dirname(process.execPath);

const runEntry = async (entry, args, env = {}) => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [entry, ...args], {
    env: { PATH: `${NODE_DIR}:${process.env.PATH ?? ''}`, ...env }
  });
  return { stdout, stderr };
};

const isolatedEnv = async (root) => {
  const env = {
    PATH: `${NODE_DIR}:${process.env.PATH ?? ''}`,
    HOME: join(root, 'home'),
    LANG: 'C',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache')
  };
  await mkdir(env.HOME, { recursive: true });
  return env;
};

test('the packaged tarball unpacks and its entry reports --version on Node 24', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'dda-dist-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const built = await buildTarball({ outDir });
  assert.equal((await stat(built.tarball)).isFile(), true);
  assert.match(built.sha256, /^[0-9a-f]{64}$/u);

  const extract = await mkdtemp(join(tmpdir(), 'dda-extract-'));
  t.after(() => rm(extract, { recursive: true, force: true }));
  await execFileAsync('tar', ['-xzf', built.tarball, '-C', extract]);
  const root = join(extract, 'dda-cli');
  assert.equal((await stat(join(root, 'bin', 'dda'))).isFile(), true);

  const entry = join(root, 'linux-cli', 'bin', 'dda.mjs');
  const { stdout } = await runEntry(entry, ['--version', '--format', 'jsonl']);
  const version = JSON.parse(stdout.trim());
  assert.equal(version.ok, true);
  assert.equal(version.platform, 'linux-cli');
  assert.equal(version.protocol, '1.0');

  // The bin/dda wrapper resolves node from PATH and runs the same entry.
  const viaWrapper = await execFileAsync(join(root, 'bin', 'dda'), ['--version', '--format', 'jsonl'], {
    env: { PATH: `${NODE_DIR}:${process.env.PATH ?? ''}` }
  });
  assert.equal(JSON.parse(viaWrapper.stdout.trim()).cli, version.cli);
});

test('the packaged entry runs health against the bundled runtime on Node 24', async (t) => {
  const stageRoot = await mkdtemp(join(tmpdir(), 'dda-stage-'));
  t.after(() => rm(stageRoot, { recursive: true, force: true }));
  // Symlink node_modules to keep the smoke test fast; the shipped tarball copies
  // them (covered by the tarball test above).
  const staged = await stageArtifact({ stageDir: join(stageRoot, 'dda-cli'), linkNodeModules: true });

  const dataRoot = await mkdtemp(join(tmpdir(), 'dda-health-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const env = await isolatedEnv(dataRoot);
  const { stdout } = await runEntry(staged.entry, ['health', '--format', 'jsonl'], env);
  const payload = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1));
  assert.equal(payload.ok, true, stdout);
  assert.equal(payload.runtime.platform, 'linux');
  assert.match(payload.runtime.node, /^v(2[4-9]|[3-9]\d)\./u);
});
