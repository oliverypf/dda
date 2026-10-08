import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proposedToolDecisionClaim } from '../src/decision/evidence-claim.mjs';
import { toolWorkspaceDecisionEvidence } from '../src/decision/workspace-context.mjs';
import { nodeProcessIntent } from '../src/decision/process-intent.mjs';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { RestrictedWindowsExecutor, RuntimeSafetyMonitor, CAPABILITIES, EXECUTION_MODES } from '../src/safety-executor.mjs';
const preview = request => JSON.parse(proposedToolDecisionClaim('test.execute', request)).untrustedProposedInput;
const requests = [{ command: 'node', args: ['--test', '--test-isolation=none'] },
  { command: 'node --test --test-isolation=none' }, { command: '"node" --test --test-isolation=none' }];

test('safe Node request forms share one bounded untrusted preview without claiming a lease or execution', () => {
  const expected = preview(requests[0]);
  for (const request of requests) {
    assert.deepEqual(preview(request), expected);
    const claim = proposedToolDecisionClaim('test.execute', request);
    assert.ok(claim.length <= 500);
    assert.equal(claim.includes('OPAQUE_EXECUTABLE'), false);
    assert.equal(claim.includes('actualExecution'), false);
    assert.equal(claim.includes('leaseGranted'), false);
  }
  assert.equal(preview({ command: 'node --check entry.mjs' }).commandName, 'node');
  assert.deepEqual(preview({ command: 'node --check entry.mjs' }).targets, ['entry.mjs']);
});

test('real one-shot executor semantics still agree with every request preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-preview-native-'));
  await writeFile(join(root, 'entry.test.mjs'), "import test from 'node:test'; test('preview native fixture',()=>{});\n");
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: root, commandAllowlist: ['node'] });
  const executor = new RestrictedWindowsExecutor({ monitor });
  let digest;
  for (const request of requests) {
    const lease = monitor.issueLease({ capabilities: [CAPABILITIES.TEST], commands: ['node'] });
    const receipt = await executor.test(request, { lease });
    assert.equal(receipt.exitCode, 0);
    assert.match(receipt.stdout, /preview native fixture/u);
    assert.equal(preview(request).commandName, 'node');
    if (digest) assert.equal(receipt.commandDigest, digest); else digest = receipt.commandDigest;
    assert.equal(lease.consumed, true);
  }
});

test('full command strings collect current authorized fixture files, while excluded data stays absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-preview-context-'));
  await writeFile(join(root, 'entry.mjs'), 'export const value = 0;\n');
  await writeFile(join(root, 'entry.test.mjs'), 'TEST_FILE_CONTEXT');
  await writeFile(join(root, '.env'), 'PRIVATE_DO_NOT_SEND');
  const workspace = new ReadonlyWorkspace(root), snapshot = await workspace.snapshot();
  const input = { workspace, snapshot, name: 'test.execute' };
  await writeFile(join(root, 'entry.mjs'), 'export const value = 1;\n');
  for (const request of [...requests, { command: 'node.exe --test --test-isolation=none' }]) {
    const evidence = await toolWorkspaceDecisionEvidence({ ...input, proposedInputClaim: proposedToolDecisionClaim('test.execute', request) });
    assert.ok(evidence.some(item => JSON.parse(item.claim).path === 'entry.test.mjs'));
    assert.ok(evidence.some(item => JSON.parse(item.claim).outputData.text?.includes('value = 1')));
    assert.equal(JSON.stringify(evidence).includes('PRIVATE_DO_NOT_SEND'), false);
    assert.ok(evidence.length <= 4 && evidence.every(item => item.claim.length <= 500));
  }
});

test('private overrides, inline code, outside paths, preloads and ambiguous commands are not normalized as bounded tests', () => {
  for (const request of [{ command: 'node --test', env: { NODE_OPTIONS: '--import=private-secret.mjs' } },
    { command: 'node --test', input: 'private-stdin' }, { command: 'node --test --import=private-secret.mjs' },
    { command: 'node -e private-code' }, { command: 'node --test ../private.test.mjs' },
    { command: 'node --test', cwd: 'C:/private' }, { command: 'node --test', args: ['--test-isolation=none'] }]) {
    assert.equal(nodeProcessIntent(request), undefined);
    const claim = proposedToolDecisionClaim('test.execute', request);
    assert.equal(JSON.parse(claim).untrustedProposedInput.commandName, 'OPAQUE_EXECUTABLE');
    assert.ok(!claim.includes('private-secret') && !claim.includes('private-stdin') && !claim.includes('private-code'));
  }
});
