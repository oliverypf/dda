#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.env.HMCODEX_OPENVIKING_SERVER
  ?? fileURLToPath(new URL('../src-tauri/binaries/openviking-server.exe', import.meta.url));
const port = await new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.once('error', rejectPort);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

const dataDir = await mkdtemp(join(process.env.TEMP, 'hmcodex-openviking-corrupt-'));
await writeFile(join(dataDir, 'openviking-store.json'), '{corrupted', 'utf8');
const child = spawn(executable, ['--host', '127.0.0.1', '--port', String(port)], {
  env: {
    ...process.env,
    HMCODEX_OPENVIKING_DATA_DIR: dataDir,
    HMCODEX_OPENVIKING_API_KEY: 'corruption-e2e-key'
  },
  stdio: 'ignore',
  windowsHide: true
});

try {
  const deadline = Date.now() + 10_000;
  let body;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(1000) });
      body = await response.json();
      if (response.ok) break;
    } catch {
      body = undefined;
    }
    await delay(100);
  }
  assert.equal(body?.status, 'ok');
  assert.equal(body?.result?.ready, true);
  assert.equal(body?.result?.degraded, true);
  const files = await readdir(dataDir);
  assert.ok(files.some((name) => /^openviking-store\.corrupt-\d+\.json$/u.test(name)), files.join(','));
  console.log(JSON.stringify({ status: 'passed', ready: true, degraded: true, backup: files }));
} finally {
  if (child.exitCode === null) child.kill();
  await rm(dataDir, { recursive: true, force: true });
}
