import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { controlledBuildEnvironment, runControlledBuild } from './build-controlled.mjs';
import { fullLocalBuildEnvironment, runFullLocalBuild } from './build-full-local.mjs';

test('Phase 1.5 build fixes the controlled channel without mutating caller environment', () => {
  const environment = { HMCODEX_BUILD_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', PATH: 'toolchain' };
  assert.deepEqual(controlledBuildEnvironment(environment), {
    HMCODEX_BUILD_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED', PATH: 'toolchain'
  });
  assert.equal(environment.HMCODEX_BUILD_RELEASE_CHANNEL, 'WINDOWS_FULL_LOCAL');
  assert.equal(controlledBuildEnvironment({}).HMCODEX_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_5_CONTROLLED');
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
  assert.equal(spawnCalls[0].options.env.HMCODEX_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_5_CONTROLLED');
  assert.equal(runControlledBuild({ desktopRoot, environment: {}, spawn }), 3);
  assert.deepEqual(spawnCalls[1].args, [
    join(desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'),
    'build', '--target', 'x86_64-pc-windows-msvc'
  ]);
});

test('full local build fixes the release channel without mutating caller environment', () => {
  const environment = { HMCODEX_BUILD_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED', PATH: 'toolchain' };
  assert.deepEqual(fullLocalBuildEnvironment(environment), {
    HMCODEX_BUILD_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', PATH: 'toolchain'
  });
  assert.equal(environment.HMCODEX_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_5_CONTROLLED');
  const desktopRoot = 'C:\\work\\hmCodex\\desktop';
  const spawnCalls = [];
  const spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return { status: 3 };
  };
  assert.equal(runFullLocalBuild({ desktopRoot, environment: {}, spawn, fast: true }), 3);
  assert.equal(spawnCalls[0].options.env.HMCODEX_BUILD_RELEASE_CHANNEL, 'WINDOWS_FULL_LOCAL');
});
