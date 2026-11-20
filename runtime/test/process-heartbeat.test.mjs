import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('process heartbeat is written while the main thread is blocked', async () => {
  const moduleUrl = pathToFileURL(join(runtimeRoot, 'src', 'process-heartbeat.mjs')).href;
  const script = `
    import { writeSync } from 'node:fs';
    import { startProcessHeartbeat } from ${JSON.stringify(moduleUrl)};
    const heartbeat = startProcessHeartbeat(200);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    writeSync(2, '{"type":"mark"}\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    heartbeat.kill();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: runtimeRoot,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  const markAt = stderr.indexOf('{"type":"mark"}');
  const beatAt = stderr.indexOf('{"type":"runtime_heartbeat"', markAt + 1);
  assert.ok(markAt >= 0, stderr);
  assert.ok(beatAt > markAt, stderr);
});
