import test from 'node:test';
import assert from 'node:assert/strict';
import { runEvidenceProcess } from './goal-evidence-process.mjs';

test('an exited client with inherited pipes cannot hold a case beyond its deadline', async () => {
  const childSource = `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3500)'], {
      detached: true, windowsHide: true, stdio: ['ignore', process.stdout, process.stderr]
    });
    descendant.unref();
    console.log('parent-exited');
  `;
  const result = await runEvidenceProcess(process.execPath, ['-e', childSource], { timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /parent-exited/u);
  assert.equal(result.outputTruncated, true);
  assert.ok(result.wallMs < 3000, `case deadline defeated by inherited pipes: ${result.wallMs}ms`);
});

test('a timed out live client is terminated and cannot pass acceptance', async () => {
  const result = await runEvidenceProcess(process.execPath, ['-e', "console.log('started'); setInterval(() => {}, 1000)"], { timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /started/u);
  assert.notEqual(result.code, 0);
  assert.ok(result.wallMs < 7000);
});
