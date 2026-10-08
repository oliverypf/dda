import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { proposedToolDecisionClaim, toolResultDecisionClaim, verifiedToolDecisionEvidence } from '../src/decision/evidence-claim.mjs';
import { toolWorkspaceDecisionEvidence } from '../src/decision/workspace-context.mjs';
import { createDecisionState } from '../src/decision/types.mjs';

test('automatic test context reads current authorized files rather than stale snapshot contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-decision-file-context-'));
  await writeFile(join(root, 'name.mjs'), 'export const value = ;\n');
  await writeFile(join(root, 'name.test.mjs'), "import {value} from './name.mjs';\n");
  await writeFile(join(root, '.env'), 'PRIVATE_CONTEXT_KEY_DO_NOT_SEND');
  for (const path of ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs']) await writeFile(join(root, path), '// unrelated source');
  const workspace = new ReadonlyWorkspace(root);
  const snapshot = await workspace.snapshot();
  const request = { command: 'node', args: ['--test', '--test-isolation=none'], cwd: '.' };
  const collect = () => toolWorkspaceDecisionEvidence({ workspace, snapshot, name: 'test.execute',
    proposedInputClaim: proposedToolDecisionClaim('test.execute', request) });
  const initial = await collect();
  assert.ok(initial.some(item => JSON.parse(item.claim).outputData.text?.includes('export const value = ;')));
  assert.ok(initial.some(item => JSON.parse(item.claim).path === 'name.test.mjs'));
  await writeFile(join(root, 'name.mjs'), 'export const value = 1;\n');
  const current = await collect();
  assert.ok(current.some(item => JSON.parse(item.claim).outputData.text?.includes('export const value = 1;')));
  assert.notEqual(current.find(item => JSON.parse(item.claim).path === 'name.mjs').source,
    initial.find(item => JSON.parse(item.claim).path === 'name.mjs').source);
  assert.equal(JSON.stringify(current).includes('PRIVATE_CONTEXT_KEY_DO_NOT_SEND'), false);
  assert.ok(current.length <= 4 && current.every(item => item.claim.length <= 500));
});

test('context collection preserves workspace exclusions and never follows opaque or escaped proposals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-decision-context-policy-'));
  await writeFile(join(root, 'private-store.mjs'), 'PRIVATE_STORE_DO_NOT_SEND');
  await writeFile(join(root, 'name.test.mjs'), 'TEST_CONTEXT');
  const workspace = new ReadonlyWorkspace(root, { excludedPaths: [join(root, 'private-store.mjs')] });
  const snapshot = await workspace.snapshot();
  const collect = (name, request) => toolWorkspaceDecisionEvidence({ workspace, snapshot, name,
    proposedInputClaim: proposedToolDecisionClaim(name, request) });
  for (const path of ['../outside.mjs', 'C:/private.mjs', '/private.mjs']) assert.deepEqual(await collect('file.write', { path, content: 'x' }), []);
  assert.deepEqual(await collect('test.execute', { command: 'node', args: ['--test'], cwd: '../outside' }), []);
  assert.deepEqual(await collect('test.execute', { command: 'node', args: ['-e', 'private inline code'] }), []);
  const context = await collect('file.write', { path: 'private-store.mjs', content: 'x' });
  assert.equal(JSON.stringify(context).includes('PRIVATE_STORE_DO_NOT_SEND'), false);
  assert.equal(context.some(item => JSON.parse(item.claim).path === 'private-store.mjs'), false);
  assert.equal(JSON.stringify(toolResultDecisionClaim('workspace.context.read', { content: 'partial', truncated: true })).includes('sourceTruncated'), true);
});

test('actual failed and successful tests remain visible after a long chain and state compaction', () => {
  const actual = (name, state, index, value) => ({ name, state,
    verifiedResult: { decisionClaim: toolResultDecisionClaim(name, value), outputDigest: `sha256:${String(index).padStart(64, '0')}` } });
  const first = actual('test.execute', 'FAILED', 1, { ok: false, exitCode: 1, stderr: 'REAL_INITIAL_TEST_FAILURE' });
  const writes = actual('file.write', 'SUCCEEDED', 2, { ok: true, path: 'name.mjs' });
  const passed = actual('test.execute', 'SUCCEEDED', 3, { ok: true, exitCode: 0, stdout: 'REAL_PASSED_TEST' });
  const reads = Array.from({ length: 40 }, (_, i) => actual('workspace.read', 'SUCCEEDED', i + 4, { path: `source-${i}.mjs`, content: 'read' }));
  const actions = [first, writes, passed, ...reads, { name: 'test.execute', state: 'FAILED', errorCode: 'TOOL_ACTION_REQUIRES_EVIDENCE', invocationAttempted: false }];
  const evidence = verifiedToolDecisionEvidence(actions);
  assert.equal(evidence.length, 8);
  assert.ok(evidence.some(item => item.claim.includes('REAL_INITIAL_TEST_FAILURE')));
  assert.ok(evidence.some(item => item.claim.includes('REAL_PASSED_TEST')));
  assert.ok(evidence.some(item => JSON.parse(item.claim).name === 'file.write'));
  const state = createDecisionState({ taskId: 'test', evidence: [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `old-${i}`, type: 'tool_result', claim: 'x'.repeat(500) })), ...evidence
  ] });
  assert.ok(state.evidence.some(item => item.claim.includes('REAL_INITIAL_TEST_FAILURE')));
  assert.ok(state.evidence.some(item => item.claim.includes('REAL_PASSED_TEST')));
  assert.equal(JSON.stringify(state).includes('TOOL_ACTION_REQUIRES_EVIDENCE'), false, 'a deferred proposal is not actual execution evidence');
});
