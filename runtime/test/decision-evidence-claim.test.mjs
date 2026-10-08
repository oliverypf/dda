import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionState } from '../src/decision/types.mjs';
import { hostToolPolicyDecisionClaim, modelAnswerDecisionClaim, proposedToolDecisionClaim, toolResultDecisionClaim } from '../src/decision/evidence-claim.mjs';

const throughWireBoundary = claim => {
  const state = createDecisionState({ evidence: [{ id: 'observed', claim, type: 'tool_result' }] });
  assert.ok(state.evidence[0].claim.length <= 500);
  return JSON.parse(state.evidence[0].claim);
};

test('a long model answer retains literal reported values after the real 500-character boundary', () => {
  const reported = 'literal-result-value-72f01';
  const answer = `${'Introduction '.repeat(140)}\n\`${reported}\`\n${'Trailing explanation '.repeat(110)}`;
  const evidence = throughWireBoundary(modelAnswerDecisionClaim(answer));
  assert.ok(evidence.quotedCode.includes(reported));
  assert.equal(evidence.untrustedModelAnswer.totalChars, answer.length);
  assert.equal(evidence.untrustedModelAnswer.truncated, true);
});

test('native process status and the end of a large test log survive without malformed JSON', () => {
  const stdout = `${'test detail\n'.repeat(400)}# pass 12\n# fail 0\n`;
  const evidence = throughWireBoundary(toolResultDecisionClaim('test.execute', { ok: true, exitCode: 0, stdout }));
  assert.equal(evidence.ok, true);
  assert.equal(evidence.exitCode, 0);
  assert.ok(evidence.outputData.tail.endsWith('# pass 12\n# fail 0\n'));
  assert.equal(evidence.outputData.totalChars, stdout.length);
  assert.equal(evidence.outputData.truncated, true);
});

test('JSON escaping and whitespace normalization cannot alter a short actual tool result', () => {
  const content = 'two  spaces\nquotes " and \\ and\u00a0Unicode';
  const evidence = throughWireBoundary(toolResultDecisionClaim('workspace.read', { path: 'README.md', content }));
  assert.equal(evidence.outputData.text, content);
  assert.equal(evidence.outputData.truncated, false);
});

test('a proposed process exposes its test operation without disclosing flag values or inline code', () => {
  const claim = proposedToolDecisionClaim('test.execute', { command: 'node', cwd: '.',
    args: ['--test', '--test-isolation=none', 'tags.test.mjs', '--token', 'private-secret.py', '--password=hidden', '-e', 'private-code.js'] });
  const data = throughWireBoundary(claim).untrustedProposedInput;
  assert.equal(data.commandName, 'node');
  assert.equal(data.cwd, '.');
  assert.ok(data.flags.includes('--test'));
  assert.deepEqual(data.targets, ['tags.test.mjs']);
  assert.equal(data.inlineCode, true);
  assert.equal(data.totalArgs, 8);
  assert.ok(!claim.includes('private-secret'));
  assert.ok(!claim.includes('private-code'));
  assert.ok(!claim.includes('hidden'));
});

test('tool policy distinguishes configured capability from a required host execution check', () => {
  const input = { name: 'test.execute', registered: true, available: true, readOnly: false,
    capability: 'test.execute', mode: 'CONTROLLED', configuredCapabilities: ['test.execute'], configuredCommands: ['node'] };
  const facts = throughWireBoundary(hostToolPolicyDecisionClaim(input)).hostToolPolicy;
  assert.equal(facts.capabilityConfigured, true);
  assert.deepEqual(facts.configuredCommandNames, ['node']);
  assert.equal(facts.executionPolicy, 'HOST_ONE_SHOT_LEASE_REQUIRED');
  assert.equal(facts.executionMode, 'CONTROLLED');
  assert.equal(throughWireBoundary(hostToolPolicyDecisionClaim({ ...input, available: false, configuredCapabilities: [] })).hostToolPolicy.capabilityConfigured, false);
  assert.equal(throughWireBoundary(hostToolPolicyDecisionClaim({ ...input, available: false })).hostToolPolicy.advertised, false);
});

test('out-of-workspace paths are classified without revealing absolute or traversal paths', () => {
  for (const path of ['../private.ts', 'C:/private.ts', '/private.ts', '\\\\server\\private.ts']) {
    const value = throughWireBoundary(proposedToolDecisionClaim('file.patch', { path }));
    assert.equal(value.untrustedProposedInput.pathClass, 'OUTSIDE_OR_OPAQUE');
    assert.ok(!JSON.stringify(value).includes('private.ts'));
  }
});

test('file edits carry the actual proposed change as bounded untrusted data', () => {
  const oldText = 'export const value = ;';
  const newText = 'export const value = 1;';
  const patch = throughWireBoundary(proposedToolDecisionClaim('file.patch', { path: 'value.mjs', replacements: [{ oldText, newText }] }));
  assert.equal(patch.untrustedProposedChange.kind, 'PATCH');
  assert.ok(patch.untrustedProposedChange.data.text.includes(oldText));
  assert.ok(patch.untrustedProposedChange.data.text.includes(newText));
  const write = throughWireBoundary(proposedToolDecisionClaim('file.write', { path: 'value.mjs', content: 'large content '.repeat(500) }));
  assert.equal(write.untrustedProposedChange.kind, 'WRITE');
  assert.equal(write.untrustedProposedChange.data.truncated, true);
});

test('an actual failed process preserves stderr evidence when stdout is empty', () => {
  const value = throughWireBoundary(toolResultDecisionClaim('test.execute', { ok: false, exitCode: 1, stdout: '', stderr: 'SyntaxError: unexpected token' }));
  assert.equal(value.ok, false);
  assert.equal(value.exitCode, 1);
  assert.equal(value.outputData.text, 'SyntaxError: unexpected token');
});
