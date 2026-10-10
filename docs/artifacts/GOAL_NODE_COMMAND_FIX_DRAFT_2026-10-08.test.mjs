import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { nodeProcessIntent, normalizedNodeProcessRequest } from './GOAL_NODE_COMMAND_FIX_DRAFT_2026-10-08.mjs';
import { nodeProcessIntent as original } from '../../runtime/src/decision/process-intent.mjs';
import { RestrictedWindowsExecutor, RuntimeSafetyMonitor, CAPABILITIES, EXECUTION_MODES } from '../../runtime/src/safety-executor.mjs';
test('native one-shot executor receipts agree with both supported Node request forms', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-command-intent-proof-'));
  await writeFile(join(workspace, 'entry.mjs'), "console.log('SCRIPT_NOT_TEST');\n");
  await writeFile(join(workspace, 'entry.test.mjs'), "import test from 'node:test'; test('native command fixture',()=>{});\n");
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace, commandAllowlist: ['node'] });
  const executor = new RestrictedWindowsExecutor({ monitor });
  for (const request of [{ command: 'node', args: ['--test', '--test-isolation=none'] }, { command: 'node --test --test-isolation=none' }, { command: '"node" --test --test-isolation=none', cwd: '.' }]) {
    const lease = monitor.issueLease({ capabilities: [CAPABILITIES.TEST], commands: ['node'] });
    const receipt = await executor.test(request, { lease });
    const normalized = normalizedNodeProcessRequest(request);
    const expected = 'sha256:' + createHash('sha256').update(JSON.stringify({ command: normalized.command, args: normalized.args })).digest('hex');
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.commandDigest, expected);
    assert.match(receipt.stdout, /native command fixture/u);
    assert.equal(nodeProcessIntent(request).kind, 'NODE_TEST');
  }
  assert.equal(original({ command: 'node --test --test-isolation=none' }), undefined, 'current production gap is reproduced independently');
  const scriptRequest = { command: 'node entry.mjs --test' };
  const scriptLease = monitor.issueLease({ capabilities: [CAPABILITIES.TEST], commands: ['node'] });
  const scriptReceipt = await executor.test(scriptRequest, { lease: scriptLease });
  assert.equal(scriptReceipt.exitCode, 0);
  assert.match(scriptReceipt.stdout, /SCRIPT_NOT_TEST/u);
  assert.equal(nodeProcessIntent(scriptRequest), undefined, 'real successful script execution must not become test-runner proof');
});
test('normalization retains rejection of unrecognized process semantics and private scope', () => {
  for (const request of [{ command: 'node --test; echo passed' }, { command: 'echo node --test' }, { command: 'node --test', args: ['--test-isolation=none'] },
    { command: 'node entry.mjs --test' }, { command: 'node --test entry.test.mjs --test-isolation=none' }, { command: 'node --test --import=preload.mjs' },
    { command: 'node --test', env: { NODE_OPTIONS: '--import=preload.mjs' } }, { command: 'node --test', input: 'private stdin' },
    { command: 'node --test ../private.test.mjs' }, { command: 'node --test', cwd: 'C:/private' }, { command: 'node', args: ['--test', 42] }]) {
    assert.equal(nodeProcessIntent(request), undefined, JSON.stringify(request));
  }
});
