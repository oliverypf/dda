import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { controlledBuildEnvironment, runControlledBuild } from './build-controlled.mjs';
import { fullLocalBuildEnvironment, prepareBuildTarget, runFullLocalBuild } from './build-full-local.mjs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';

test('Phase 1.5 build fixes the controlled channel without mutating caller environment', () => {
  const environment = { DDA_BUILD_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', PATH: 'toolchain' };
  assert.deepEqual(controlledBuildEnvironment(environment), {
    DDA_BUILD_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED', PATH: 'toolchain'
  });
  assert.equal(environment.DDA_BUILD_RELEASE_CHANNEL, 'WINDOWS_FULL_LOCAL');
  assert.equal(controlledBuildEnvironment({}).DDA_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_5_CONTROLLED');
});

test('controlled build invokes the local Windows CLI and supports fast mode', () => {
  const desktopRoot = 'C:\\work\\hmCodex\\desktop';
  const spawnCalls = [];
  const spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return { status: 3 };
  };
  assert.equal(runControlledBuild({ desktopRoot, environment: {}, spawn, fast: true }), 3);
  assert.deepEqual(spawnCalls[0].args, [
    join(desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'),
    'build', '--target', 'x86_64-pc-windows-msvc', '--debug', '--no-bundle'
  ]);
  assert.equal(spawnCalls[0].options.env.DDA_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_5_CONTROLLED');
  assert.equal(runControlledBuild({ desktopRoot, environment: {}, spawn }), 3);
  assert.deepEqual(spawnCalls[1].args, [
    join(desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'),
    'build', '--target', 'x86_64-pc-windows-msvc'
  ]);
});

test('full local build fixes the release channel without mutating caller environment', () => {
  const environment = { DDA_BUILD_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED', PATH: 'toolchain' };
  assert.deepEqual(fullLocalBuildEnvironment(environment), {
    DDA_BUILD_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', PATH: 'toolchain'
  });
  assert.equal(environment.DDA_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_5_CONTROLLED');
  const desktopRoot = 'C:\\work\\hmCodex\\desktop';
  const spawnCalls = [];
  const spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return { status: 3 };
  };
  assert.equal(runFullLocalBuild({ desktopRoot, environment: {}, spawn, fast: true }), 3);
  assert.equal(spawnCalls[0].options.env.DDA_BUILD_RELEASE_CHANNEL, 'WINDOWS_FULL_LOCAL');
});

test('stage-only reuses an existing executable without invoking Tauri', async () => {
  const spawnCalls = [];
  const root = await mkdtemp(join(tmpdir(), 'dda-stage-only-'));
  const target = join(root, 'dda-desktop.exe');
  await writeFile(target, 'exe');
  assert.equal(runFullLocalBuild({ desktopRoot: 'C:\\work\\hmCodex\\desktop', targetExecutable: target, stageOnly: true, spawn: (...args) => spawnCalls.push(args) }), 0);
  assert.deepEqual(spawnCalls, []);
});

test('locked executable is renamed with the established backup convention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dda-build-lock-'));
  const target = join(root, 'dda-desktop.exe');
  await writeFile(target, 'old exe');
  const result = await prepareBuildTarget({
    path: target,
    platform: 'win32',
    now: new Date('2026-11-23T12:34:56Z'),
    spawn: () => ({ status: 32 })
  });
  assert.equal(result.disposition, 'RENAMED_LOCKED_TARGET');
  assert.match(basename(result.backup), /^dda-desktop\.locked-before-20261123123456\.exe$/);
  assert.equal(await readFile(result.backup, 'utf8'), 'old exe');
});
