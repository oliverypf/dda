import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_IMPLICATIONS,
  CAPABILITY_PATH_DENY,
  CAPABILITY_PATH_REQUIRE_APPROVAL,
  HIGH_RISK_SINKS,
  analyzeCapabilityPath,
  applyCapabilityPathGate,
  capabilityPathGateHint,
  capabilityPathTelemetry,
  isCapabilityPathEnabled
} from '../src/capability-path.mjs';

const allowGate = { decision: 'ALLOW', reasonCode: 'JEV_ACTION_GATE_ALLOW' };
const blockGate = { decision: 'BLOCK', reasonCode: 'HARD_BLOCK' };
const requireGate = { decision: 'REQUIRE_APPROVAL', reasonCode: 'JEV_ACTION_GATE_REQUIRE_APPROVAL' };

test('helpers: defaults enabled, implications frozen, high-risk set', () => {
  assert.equal(isCapabilityPathEnabled({}), true);
  assert.equal(isCapabilityPathEnabled({ DDA_CAPABILITY_PATH: '0' }), false);
  assert.equal(isCapabilityPathEnabled({ DDA_CAPABILITY_PATH: '1' }), true);
  assert.ok(Object.isFrozen(CAPABILITY_IMPLICATIONS));
  assert.ok(HIGH_RISK_SINKS.includes('executor.invoke.controlled'));
  assert.ok(HIGH_RISK_SINKS.includes('network.connect.host'));
});

test('T-path-1 file.write closure includes write sinks, no expands → hint NONE', () => {
  const analysis = analyzeCapabilityPath({ toolName: 'file.write' });
  assert.ok(analysis.declared.includes('file.write'));
  assert.ok(analysis.effective.includes('filesystem.write.workspace'));
  assert.ok(analysis.effective.includes('workspace.write.patch'));
  // Direct sinks are declared-in for file.write → no soft expand.
  assert.equal(analysis.expandsBeyondDeclared, false);
  assert.equal(capabilityPathGateHint(analysis), 'NONE');

  const out = applyCapabilityPathGate({
    gateDecision: allowGate,
    analysis,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
  assert.equal(out.hint, 'NONE');
});

test('T-path-1b file.patch same declared-in write sinks → NONE', () => {
  const analysis = analyzeCapabilityPath({ toolName: 'file.patch' });
  assert.equal(analysis.expandsBeyondDeclared, false);
  assert.equal(capabilityPathGateHint(analysis), 'NONE');
});

test('T-path-2 shell.execute expands to filesystem/network → REQUIRE_APPROVAL', () => {
  const analysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  assert.ok(analysis.effective.includes('process.execute.shell'));
  assert.ok(analysis.effective.includes('process.execute.argv'));
  assert.ok(analysis.effective.includes('filesystem.write.workspace'));
  assert.ok(analysis.effective.includes('network.connect.host'));
  // Direct shell sinks are declared-in; indirect fs/network are NOT.
  assert.equal(analysis.expandsBeyondDeclared, true);
  assert.ok(analysis.highRiskSinks.includes('filesystem.write.workspace'));
  assert.ok(analysis.highRiskSinks.includes('network.connect.host'));
  assert.equal(capabilityPathGateHint(analysis), 'REQUIRE_APPROVAL');

  const out = applyCapabilityPathGate({
    gateDecision: allowGate,
    analysis,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'REQUIRE_APPROVAL');
  assert.equal(out.reasonCode, CAPABILITY_PATH_REQUIRE_APPROVAL);
  assert.equal(out.elevated, true);
  assert.equal(out.hint, 'REQUIRE_APPROVAL');
});

test('T-path-3 unknown tool no edges → effective={tool}, NONE', () => {
  const analysis = analyzeCapabilityPath({ toolName: 'weird.unknown.tool' });
  assert.deepEqual(analysis.declared, ['weird.unknown.tool']);
  assert.deepEqual(analysis.effective, ['weird.unknown.tool']);
  assert.deepEqual(analysis.path, []);
  assert.deepEqual(analysis.highRiskSinks, []);
  assert.equal(analysis.expandsBeyondDeclared, false);
  assert.equal(capabilityPathGateHint(analysis), 'NONE');
});

test('T-path-4 already BLOCK → unchanged', () => {
  const analysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  assert.equal(capabilityPathGateHint(analysis), 'REQUIRE_APPROVAL');
  const out = applyCapabilityPathGate({
    gateDecision: blockGate,
    analysis,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'BLOCK');
  assert.equal(out.reasonCode, 'HARD_BLOCK');
  assert.equal(out.elevated, false);
  assert.equal(out.preservedBlock, true);
});

test('T-path-5 readOnly / read-class tools not elevated', () => {
  const analysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  const out = applyCapabilityPathGate({
    gateDecision: allowGate,
    analysis,
    toolReadOnly: true
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
  assert.equal(out.readOnly, true);

  // Read-class tool with no write/exec edges stays NONE even when not flagged readOnly.
  const readAnalysis = analyzeCapabilityPath({ toolName: 'workspace.read.content' });
  assert.equal(capabilityPathGateHint(readAnalysis), 'NONE');
  const readOut = applyCapabilityPathGate({
    gateDecision: allowGate,
    analysis: readAnalysis,
    toolReadOnly: false
  });
  assert.equal(readOut.elevated, false);
});

test('T-path-6 DDA_CAPABILITY_PATH=0 → baseline (enabled:false)', () => {
  assert.equal(isCapabilityPathEnabled({ DDA_CAPABILITY_PATH: '0' }), false);
  const analysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  const out = applyCapabilityPathGate({
    gateDecision: allowGate,
    analysis,
    enabled: false,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
  assert.equal(out.disabled, true);
  assert.equal(out.hint, 'NONE');
});

test('DENY branch: injected edge to undeclared executor.invoke.controlled', () => {
  const custom = [
    ...CAPABILITY_IMPLICATIONS,
    { from: 'shell.execute', to: 'executor.invoke.controlled', reasonCode: 'INJECTED_EXECUTOR' }
  ];
  const analysis = analyzeCapabilityPath({
    toolName: 'shell.execute',
    implications: custom
  });
  assert.ok(analysis.highRiskSinks.includes('executor.invoke.controlled'));
  assert.equal(analysis.expandsBeyondDeclared, true);
  assert.equal(capabilityPathGateHint(analysis), 'DENY');

  const out = applyCapabilityPathGate({
    gateDecision: allowGate,
    analysis,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'BLOCK');
  assert.equal(out.reasonCode, CAPABILITY_PATH_DENY);
  assert.equal(out.elevated, true);

  // Also elevates REQUIRE_APPROVAL → BLOCK for DENY hint.
  const fromRequire = applyCapabilityPathGate({
    gateDecision: requireGate,
    analysis,
    toolReadOnly: false
  });
  assert.equal(fromRequire.decision, 'BLOCK');
  assert.equal(fromRequire.reasonCode, CAPABILITY_PATH_DENY);
  assert.equal(fromRequire.elevated, true);
});

test('declaredCapabilities union + network.* pattern + telemetry truncate', () => {
  const analysis = analyzeCapabilityPath({
    toolName: 'custom.tool',
    declaredCapabilities: ['network.fetch', '  network.fetch  ', '']
  });
  assert.deepEqual(analysis.declared, ['custom.tool', 'network.fetch']);
  assert.ok(analysis.effective.includes('network.connect.host'));
  assert.equal(analysis.expandsBeyondDeclared, true);
  assert.equal(capabilityPathGateHint(analysis), 'REQUIRE_APPROVAL');

  const longImplications = [];
  for (let i = 0; i < 20; i += 1) {
    longImplications.push({
      from: i === 0 ? 'chain.root' : `chain.n${i - 1}`,
      to: `chain.n${i}`,
      reasonCode: `STEP_${i}`
    });
  }
  // Make last hop a high-risk sink so expands is interesting.
  longImplications.push({
    from: 'chain.n19',
    to: 'network.connect.host',
    reasonCode: 'FINAL'
  });
  const chained = analyzeCapabilityPath({
    toolName: 'chain.root',
    implications: longImplications
  });
  const telem = capabilityPathTelemetry(chained, { pathLimit: 16 });
  assert.equal(telem.pathLen, chained.path.length);
  assert.ok(telem.pathLen > 16);
  assert.equal(telem.path.length, 16);
  assert.equal(telem.expandsBeyondDeclared, true);
});

test('never demote existing REQUIRE_APPROVAL on soft REQUIRE_APPROVAL hint', () => {
  const analysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  const out = applyCapabilityPathGate({
    gateDecision: requireGate,
    analysis,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'REQUIRE_APPROVAL');
  assert.equal(out.reasonCode, 'JEV_ACTION_GATE_REQUIRE_APPROVAL');
  assert.equal(out.elevated, false);
});
