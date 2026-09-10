import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenVikingContextPort } from '../../runtime/src/openviking-context-port.mjs';

const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const srcTauriRoot = join(scriptRoot, '..', 'src-tauri');
const targetTriple = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.arch;
const executable = join(srcTauriRoot, 'target', targetTriple, process.env.HMCODEX_OPENVIKING_BUILD_MODE ?? 'debug', process.platform === 'win32' ? 'openviking-server.exe' : 'openviking-server');

const freePort = async () => new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.once('error', rejectPort);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

const port = await freePort();
const dataDir = await mkdtemp(join(scriptPathDataRoot(), 'hmcodex-openviking-'));
const child = spawn(executable, ['--host', '127.0.0.1', '--port', String(port)], {
  env: { ...process.env, HMCODEX_OPENVIKING_DATA_DIR: dataDir, HMCODEX_OPENVIKING_API_KEY: 'e2e-loopback-key' },
  stdio: 'ignore',
  windowsHide: true
});
child.once('error', (error) => {
  console.error(error);
});

try {
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`);
      const body = await response.json();
      ready = response.ok && body?.status === 'ok' && body?.result?.ready === true;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  assert.ok(ready, 'OpenViking sidecar did not become ready');

  const contextPort = createOpenVikingContextPort({
    baseURL: `http://127.0.0.1:${port}`,
    apiKey: 'e2e-loopback-key',
    workspaceRoot: 'Z:\\e2e-workspace'
  });
  const health = await contextPort.health();
  const recorded = await contextPort.record({
    runId: 'e2e-run-1',
    statement: 'Verified bounded OpenViking sidecar flow',
    sourceEventIds: ['event-1'],
    kind: 'TASK_OUTCOME',
    confidence: 0.9
  });
  const recalled = await contextPort.recall({
    runId: 'e2e-run-1',
    query: 'bounded OpenViking sidecar flow',
    limit: 4,
    maxChars: 1000
  });
  const used = await contextPort.used({
    runId: 'e2e-run-1',
    memoryIds: recalled.items.map((item) => item.memoryId)
  });
  const committed = await contextPort.commit({
    runId: 'e2e-run-1',
    memoryIds: [recorded.memory.memoryId]
  });

  assert.equal(health.status, 'AVAILABLE');
  assert.equal(recorded.status, 'RECORDED');
  assert.equal(recalled.items.length, 1);
  assert.equal(used.used.length, 1);
  assert.equal(committed.count, 1);
  console.log(JSON.stringify({
    status: 'passed',
    ready: true,
    recorded: recorded.status,
    recalled: recalled.items.length,
    used: used.used.length,
    committed: committed.count
  }));
} finally {
  if (child.exitCode === null) child.kill();
  await rm(dataDir, { recursive: true, force: true });
}

function scriptPathDataRoot() {
  return process.platform === 'win32' ? process.env.TEMP : '/tmp';
}
