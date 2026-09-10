import test from 'node:test';
import assert from 'node:assert/strict';
import { phase1BuildEnvironment, runPhase1Build } from './build-phase1.mjs';
import { join } from 'node:path';

test('Phase 1 build fixes the compiled channel without mutating caller environment', () => {
  const environment = { HMCODEX_BUILD_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', PATH: 'toolchain' };
  assert.deepEqual(phase1BuildEnvironment(environment), {
    HMCODEX_BUILD_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY', PATH: 'toolchain'
  });
  assert.equal(environment.HMCODEX_BUILD_RELEASE_CHANNEL, 'WINDOWS_FULL_LOCAL');
  assert.equal(phase1BuildEnvironment({}).HMCODEX_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_READ_ONLY');
});

test('build invokes the local Windows CLI with the fixed channel and propagates failure', () => {
  const desktopRoot = 'Z:\\workspace with spaces\\desktop';
  const spawn = (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [join(desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--target', 'x86_64-pc-windows-msvc']);
    assert.equal(options.cwd, desktopRoot);
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.HMCODEX_BUILD_RELEASE_CHANNEL, 'WINDOWS_PHASE1_READ_ONLY');
    return { status: 7 };
  };
  assert.equal(runPhase1Build({ desktopRoot, environment: {}, spawn }), 7);
  assert.equal(runPhase1Build({ desktopRoot, spawn: () => ({ status: null, signal: 'SIGTERM' }) }), 1);
  assert.throws(() => runPhase1Build({ desktopRoot, spawn: () => ({ error: new Error('spawn failed') }) }), /spawn failed/);
});
