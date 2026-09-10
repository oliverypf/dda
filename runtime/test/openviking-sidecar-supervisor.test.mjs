import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenVikingSidecarSupervisor,
  parseOpenVikingSidecarURL,
  resolveOpenVikingSidecarConfig
} from '../src/openviking-sidecar-supervisor.mjs';

const file = () => ({ isFile: () => true, isDirectory: () => false });
const directory = () => ({ isFile: () => false, isDirectory: () => true });

test('sidecar configuration requires a loopback URL and absolute Windows executable', async () => {
  const statImpl = async (path) => path.endsWith('openviking-server.exe') ? file() : directory();
  const config = await resolveOpenVikingSidecarConfig({
    platform: 'win32',
    statImpl,
    env: {
      HMCODEX_OPENVIKING_EXECUTABLE: 'C:\\Tools\\openviking-server.exe',
      HMCODEX_OPENVIKING_URL: 'http://localhost:1933',
      HMCODEX_OPENVIKING_WORKING_DIR: 'C:\\OpenViking'
    }
  });
  assert.equal(config.endpoint.host, '127.0.0.1');
  assert.equal(config.endpoint.port, 1933);
  await assert.rejects(() => resolveOpenVikingSidecarConfig({
    platform: 'win32',
    statImpl,
    env: { HMCODEX_OPENVIKING_EXECUTABLE: '.\\openviking-server.exe' }
  }), /OPENVIKING_SIDECAR_EXECUTABLE_INVALID/u);
  assert.throws(() => parseOpenVikingSidecarURL('http://example.com:1933'), /OPENVIKING_SIDECAR_URL_INVALID/u);
  assert.throws(() => parseOpenVikingSidecarURL('https://127.0.0.1:1933'), /OPENVIKING_SIDECAR_URL_INVALID/u);
});

test('sidecar supervisor restarts an unhealthy child and stops the owned process', async () => {
  const children = [];
  const killed = [];
  const events = [];
  let healthCall = 0;
  const config = {
    executable: 'C:\\Tools\\openviking-server.exe',
    endpoint: { url: 'http://127.0.0.1:1933', host: '127.0.0.1', port: 1933 },
    workingDirectory: 'C:\\OpenViking',
    startupTimeoutMs: 1000,
    healthIntervalMs: 250,
    healthFailureThreshold: 2,
    maxRestarts: 2
  };
  const spawnImpl = (_executable, args, options) => {
    assert.deepEqual(args, ['--host', '127.0.0.1', '--port', '1933']);
    assert.equal(options.shell, false);
    const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, exitCode: null });
    children.push(child);
    return child;
  };
  let supervisor;
  supervisor = new OpenVikingSidecarSupervisor({
    config,
    spawnImpl,
    delayImpl: async () => {},
    healthImpl: async () => {
      healthCall += 1;
      // First child starts, then fails two health probes. The restarted child
      // becomes ready and the observer requests a clean stop.
      return healthCall === 1 || healthCall >= 4;
    },
    killTree: (child) => {
      killed.push(child.pid);
      child.exitCode = 1;
    },
    emit: (event) => {
      events.push(event);
      if (event.state === 'READY' && event.restartCount === 1) supervisor.stop();
    }
  });
  await supervisor.run();
  assert.equal(children.length, 2);
  assert.deepEqual(killed, [100, 101]);
  assert.ok(events.some((event) => event.state === 'RESTARTING' && event.restartCount === 1));
  assert.equal(events.at(-1).state, 'STOPPED');
});
