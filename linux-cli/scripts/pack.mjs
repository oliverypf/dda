#!/usr/bin/env node
// L4 packaging starter.
//
// Assembles a self-contained, runnable tree from the in-repo `linux-cli` and
// its sibling `runtime` (the CLI imports `../../runtime/src/...`, so both must
// ship together) and emits a `.tar.gz` plus a `bin/dda` wrapper. This is the
// first installable artifact: extract it, add `bin/` to PATH, and run `dda`.
//
// This intentionally does NOT produce a .deb, AppImage, or Node SEA — those are
// not shipped. It also is not a plain `npm pack` of `linux-cli` alone, which
// would omit the runtime and not run.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');
export const LINUX_CLI_ROOT = resolve(HERE, '..');
export const RUNTIME_ROOT = join(REPO_ROOT, 'runtime');

const WRAPPER = `#!/bin/sh
# dda launcher: run the bundled Node entry with the host Node (>=24 required).
here=$(cd "$(dirname "$0")" && pwd)
exec node "$here/../linux-cli/bin/dda.mjs" "$@"
`;

async function readVersion() {
  const pkg = JSON.parse(await readFile(join(LINUX_CLI_ROOT, 'package.json'), 'utf8'));
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
}

async function copyTree(from, to, { link = false } = {}) {
  if (link) {
    await mkdir(dirname(to), { recursive: true });
    await symlink(from, to, 'dir');
    return;
  }
  await cp(from, to, { recursive: true, dereference: false });
}

// Build the staging tree under `stageDir`. When `linkNodeModules` is true the
// runtime dependencies are symlinked instead of copied — used by the smoke test
// to stay fast; the shipped tarball always copies them in.
export async function stageArtifact({ stageDir, linkNodeModules = false } = {}) {
  const version = await readVersion();
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  await copyTree(join(LINUX_CLI_ROOT, 'bin'), join(stageDir, 'linux-cli', 'bin'));
  await copyTree(join(LINUX_CLI_ROOT, 'src'), join(stageDir, 'linux-cli', 'src'));
  await copyTree(join(LINUX_CLI_ROOT, 'package.json'), join(stageDir, 'linux-cli', 'package.json'));
  await copyTree(join(LINUX_CLI_ROOT, 'README.md'), join(stageDir, 'linux-cli', 'README.md'));

  await copyTree(join(RUNTIME_ROOT, 'src'), join(stageDir, 'runtime', 'src'));
  await copyTree(join(RUNTIME_ROOT, 'package.json'), join(stageDir, 'runtime', 'package.json'));

  const runtimeModules = join(RUNTIME_ROOT, 'node_modules');
  try {
    await stat(runtimeModules);
  } catch {
    throw new Error('RUNTIME_DEPENDENCIES_MISSING: run `npm install` in runtime/ before packaging');
  }
  await copyTree(runtimeModules, join(stageDir, 'runtime', 'node_modules'), { link: linkNodeModules });

  await mkdir(join(stageDir, 'bin'), { recursive: true });
  await writeFile(join(stageDir, 'bin', 'dda'), WRAPPER, { mode: 0o755 });
  await writeFile(join(stageDir, 'package.json'), `${JSON.stringify({
    name: '@dda/cli-dist',
    version,
    private: true,
    type: 'module',
    description: 'Self-contained dda CLI bundle (linux-cli + runtime).',
    bin: { dda: 'bin/dda', hmcodex: 'bin/dda' },
    engines: { node: '>=24.0.0' }
  }, null, 2)}\n`);
  return { stageDir, version, entry: join(stageDir, 'linux-cli', 'bin', 'dda.mjs'), wrapper: join(stageDir, 'bin', 'dda') };
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Produce dist/dda-cli-<version>.tar.gz. Returns { tarball, version, bytes, sha256 }.
export async function buildTarball({ outDir = join(LINUX_CLI_ROOT, 'dist') } = {}) {
  const staging = await mkdtemp(join(tmpdir(), 'dda-pack-'));
  const stageDir = join(staging, 'dda-cli');
  try {
    const { version } = await stageArtifact({ stageDir });
    await mkdir(outDir, { recursive: true });
    const tarball = join(outDir, `dda-cli-${version}.tar.gz`);
    await execFileAsync('tar', ['-czf', tarball, '-C', staging, 'dda-cli']);
    const info = await stat(tarball);
    return { tarball, version, bytes: info.size, sha256: await sha256(tarball) };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = await buildTarball();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    tarball: result.tarball,
    version: result.version,
    bytes: result.bytes,
    sha256: result.sha256
  }, null, 2)}\n`);
}
