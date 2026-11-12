import test from 'node:test';
import assert from 'node:assert/strict';
import { phase1BuildEnvironment, runPhase1Build } from './build-phase1.mjs';
import { controlledBuildEnvironment } from './build-controlled.mjs';
import { join } from 'node:path';

test('the retired phase-1 read-only build channel fails closed (ADR-0026)', () => {
  assert.throws(() => phase1BuildEnvironment({}), /RELEASE_CHANNEL_RETIRED/u);
  assert.throws(() => phase1BuildEnvironment({ DDA_BUILD_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL' }), /RELEASE_CHANNEL_RETIRED/u);
  assert.throws(() => runPhase1Build({ desktopRoot: 'Z:\\workspace\\desktop' }), /RELEASE_CHANNEL_RETIRED/u);
});

test('the controlled build fixes the channel without mutating caller environment', () => {
  const environment = { DDA_BUILD_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY', PATH: 'toolchain' };
  assert.deepEqual(controlledBuildEnvironment(environment), {
    DDA_BUILD_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED', PATH: 'toolchain'
  });
  assert.equal(environment.DDA_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_READ_ONLY');
  assert.equal(controlledBuildEnvironment({}).DDA_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_5_CONTROLLED');
});

test('controlled build invokes the local Windows CLI with the fixed channel and propagates failure', async () => {
  const { runControlledBuild } = await import('./build-controlled.mjs');
  const desktopRoot = 'Z:\\workspace with spaces\\desktop';
  const spawn = (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [join(desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--target', 'x86_64-pc-windows-msvc']);
    assert.equal(options.cwd, desktopRoot);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.DDA_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_5_CONTROLLED');
    return { status: 7 };
  };
  assert.equal(runControlledBuild({ desktopRoot, environment: {}, spawn }), 7);
  assert.equal(runControlledBuild({ desktopRoot, spawn: () => ({ status: null, signal: 'SIGTERM' }) }), 1);
  assert.throws(() => runControlledBuild({ desktopRoot, spawn: () => ({ error: new Error('spawn failed') }) }), /spawn failed/);
});
