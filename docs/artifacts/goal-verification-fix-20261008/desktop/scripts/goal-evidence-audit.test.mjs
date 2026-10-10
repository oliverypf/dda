import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../runtime/src/model-tool-calls.mjs';
import { verifiedRuntimeOutputs, runtimeNativeOutcomes, successfulNativeTest, auditGoalEvidence } from './goal-evidence-audit.mjs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('model-visible tool content must match a successful durable native result', () => {
  const output = JSON.stringify({ path: 'README.md', content: 'actual marker' });
  const outputDigest = `sha256:${createHash('sha256').update(canonicalJson(JSON.parse(output))).digest('hex')}`;
  const requests = [{ body: { input: [{ type: 'function_call_output', output }] } }];
  const event = { kind: 'ToolInvocationCompleted', payload: { ok: true, outputDigest } };
  assert.deepEqual(verifiedRuntimeOutputs([event], requests), [output]);
  assert.deepEqual(verifiedRuntimeOutputs([{ ...event, payload: { ok: false, outputDigest } }], requests), []);
  assert.deepEqual(verifiedRuntimeOutputs([], requests), []);
  assert.deepEqual(verifiedRuntimeOutputs([event], [{ body: { input: [{ type: 'function_call_output', output: '{"content":"invented"}' }] } }]), []);
});

test('canonical hashing accepts field ordering but excludes snapshot and assistant text', () => {
  const value = { content: 'actual marker', path: 'README.md' };
  const outputDigest = `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
  const output = '{"path":"README.md","content":"actual marker"}';
  assert.deepEqual(verifiedRuntimeOutputs([{ kind: 'ToolInvocationCompleted', payload: { payload: { ok: true, outputDigest } } }],
    [{ body: { input: [{ type: 'message', output }, { type: 'function_call_output', output }] } }]), [output]);
});

test('a completed invocation returning exit failure does not count as a successful process', () => {
  const value = { ok: false, exitCode: 1, stdout: 'tests failed' };
  const output = JSON.stringify(value);
  const outputDigest = `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
  const events = [{ kind: 'ToolInvocationCompleted', payload: { ok: true, name: 'test.execute', outputDigest } }];
  const requests = [{ body: { input: [{ type: 'function_call_output', output }] } }];
  assert.deepEqual(verifiedRuntimeOutputs(events, requests), []);
  assert.equal(runtimeNativeOutcomes(events, requests)[0].ok, false);
});

test('successful test evidence requires a matching native invocation of the actual test suite', () => {
  const hash = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
  const input = { command: 'node', args: ['--test', '--test-isolation=none'] };
  const value = { ok: true, exitCode: 0, action: 'test', cwd: '.', commandDigest: `sha256:${createHash('sha256').update(JSON.stringify({ command: 'node', args: input.args })).digest('hex')}` };
  const events = [{ kind: 'ToolInvocationCompleted', payload: { ok: true, name: 'test.execute', inputDigest: hash(input), outputDigest: hash(value) } }];
  const requests = [{ output: [{ type: 'function_call', name: 'hmc_test_x2e_execute', arguments: JSON.stringify(input) }],
    body: { input: [{ type: 'function_call_output', output: JSON.stringify(value) }] } }];
  const [outcome] = runtimeNativeOutcomes(events, requests);
  assert.equal(successfulNativeTest(outcome), true);
  assert.equal(successfulNativeTest(runtimeNativeOutcomes(events, [{ ...requests[0], output: requests[0].output[0] }])[0]), true);
  assert.equal(successfulNativeTest({ ...outcome, input: { ...input, args: ['--check', 'name.mjs'] } }), false);
  assert.equal(successfulNativeTest({ ...outcome, input: undefined }), false);
  assert.equal(successfulNativeTest({ ...outcome, ok: false }), false);
});

test('Jev variant labels still require successful native hmCodex evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-ablation-native-audit-'));
  await mkdir(join(root, 'workspace-final'));
  const marker = 'GOAL_EVIDENCE_abc123';
  await writeFile(join(root, 'workspace-final/README.md'), marker);
  const value = { content: marker };
  const hash = `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
  await writeFile(join(root, 'model-requests.json'), JSON.stringify([{ body: { input: [{ type: 'function_call_output', output: JSON.stringify(value) }] } }]));
  await writeFile(join(root, 'native-events.json'), JSON.stringify([{ kind: 'ToolInvocationCompleted', payload: { ok: true, outputDigest: hash } }]));
  // A fabricated Codex-looking success must not supply the hmCodex evidence.
  await writeFile(join(root, 'stdout.jsonl'), JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0, status: 'completed', aggregated_output: marker } }));
  const report = { evidenceDirectory: root, rows: ['hmcodex-jev-off', 'hmcodex-jev-on'].map(condition => ({
    client: 'hmcodex-runtime', condition, taskId: 'inspect-readme-001', evidenceDirectory: root
  })) };
  assert.equal((await auditGoalEvidence(report)).passed, true);
  await writeFile(join(root, 'native-events.json'), '[]');
  assert.equal((await auditGoalEvidence(report)).passed, false);
});
