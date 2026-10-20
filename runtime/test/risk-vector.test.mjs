import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCapabilityPath } from '../src/capability-path.mjs';
import {
  RISK_VECTOR_DENY,
  RISK_VECTOR_REQUIRE_APPROVAL,
  RISK_VECTOR_WEIGHTS,
  TRAJECTORY_READ_THEN_EGRESS,
  applyRiskVectorGate,
  combineTrajectoryRisk,
  hintRank,
  isRiskVectorEnabled,
  riskVectorGateHint,
  riskVectorTelemetry,
  scoreFromDims,
  scoreRiskVector
} from '../src/risk-vector.mjs';

const allowGate = { decision: 'ALLOW', reasonCode: 'JEV_ACTION_GATE_ALLOW' };
const blockGate = { decision: 'BLOCK', reasonCode: 'HARD_BLOCK' };
const requireGate = { decision: 'REQUIRE_APPROVAL', reasonCode: 'JEV_ACTION_GATE_REQUIRE_APPROVAL' };

test('helpers: defaults enabled, weights frozen, equal score', () => {
  assert.equal(isRiskVectorEnabled({}), true);
  assert.equal(isRiskVectorEnabled({ DDA_RISK_VECTOR: '0' }), false);
  assert.equal(isRiskVectorEnabled({ DDA_RISK_VECTOR: '1' }), true);
  assert.ok(Object.isFrozen(RISK_VECTOR_WEIGHTS));
  assert.ok(Math.abs(scoreFromDims({
    I: 1, P: 0, B: 0, V: 0, D: 0, A: 0, X: 0, N: 0, F: 0, T: 0
  }) - 0.1) < 1e-9);
  assert.equal(hintRank('DENY'), 2);
  assert.equal(hintRank('REQUIRE_APPROVAL'), 1);
  assert.equal(hintRank('NONE'), 0);
});

test('T-rv-1 file.write single file → mid/low score; no false DENY', () => {
  const pathAnalysis = analyzeCapabilityPath({ toolName: 'file.write' });
  const vector = scoreRiskVector({
    toolName: 'file.write',
    pathAnalysis,
    toolArgs: { path: 'src/app.mjs' },
    runStats: { toolCount: 0, fanout: 1 }
  });
  assert.ok(vector.score < 0.75, `score=${vector.score} should be mid/low`);
  assert.ok(vector.score < 0.4 || vector.score >= 0.4, 'score finite');
  assert.notEqual(riskVectorGateHint(vector), 'DENY');
  // Prefer mid/low: typically NONE for single declared-in write.
  assert.ok(vector.score < 0.4, `expected mid/low <0.4, got ${vector.score}`);
  assert.equal(riskVectorGateHint(vector), 'NONE');

  const out = applyRiskVectorGate({
    gateDecision: allowGate,
    vector,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
  assert.equal(out.hint, 'NONE');
});

test('T-rv-2 shell.execute + Path expands → score≥0.4 → REQUIRE_APPROVAL', () => {
  const pathAnalysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  assert.equal(pathAnalysis.expandsBeyondDeclared, true);
  const vector = scoreRiskVector({
    toolName: 'shell.execute',
    pathAnalysis,
    runStats: { toolCount: 1, fanout: 1 }
  });
  assert.ok(vector.score >= 0.4, `score=${vector.score} expected ≥0.4`);
  // Must not trip single-dim DENY (A|X|P ≥ 0.9) for this acceptance case.
  assert.ok(vector.dims.A < 0.9, `A=${vector.dims.A}`);
  assert.ok(vector.dims.X < 0.9, `X=${vector.dims.X}`);
  assert.ok(vector.dims.P < 0.9, `P=${vector.dims.P}`);
  assert.ok(vector.score < 0.75, `score=${vector.score} should be approval band not deny`);
  assert.equal(riskVectorGateHint(vector), 'REQUIRE_APPROVAL');

  const out = applyRiskVectorGate({
    gateDecision: allowGate,
    vector,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'REQUIRE_APPROVAL');
  assert.equal(out.reasonCode, RISK_VECTOR_REQUIRE_APPROVAL);
  assert.equal(out.elevated, true);
});

test('T-rv-3 combo: sensitive-read then network/shell → TRAJECTORY_READ_THEN_EGRESS bumps D/X', () => {
  const readVec = scoreRiskVector({
    toolName: 'safety.profile.read',
    runStats: { toolCount: 0 }
  });
  assert.ok(readVec.dims.D >= 0.7, `sensitive D=${readVec.dims.D}`);

  const netVec = scoreRiskVector({
    toolName: 'network.fetch',
    runStats: { toolCount: 1 },
    priorVector: readVec
  });

  const combined = combineTrajectoryRisk([readVec, netVec]);
  assert.ok(combined.reasons.includes(TRAJECTORY_READ_THEN_EGRESS));
  assert.ok(combined.dims.D >= 0.7, `combined D=${combined.dims.D}`);
  assert.ok(combined.dims.X >= 0.7, `combined X=${combined.dims.X}`);
  assert.equal(combined.stepCount, 2);

  // Also works with shell as the egress step.
  const shellVec = scoreRiskVector({
    toolName: 'shell.execute',
    pathAnalysis: analyzeCapabilityPath({ toolName: 'shell.execute' }),
    runStats: { toolCount: 1 },
    priorVector: readVec
  });
  const combinedShell = combineTrajectoryRisk([readVec, shellVec]);
  assert.ok(combinedShell.reasons.includes(TRAJECTORY_READ_THEN_EGRESS));
  assert.ok(combinedShell.dims.X >= 0.7);
});

test('T-rv-4 score≥0.75 or A≥0.9 → BLOCK via DENY apply', () => {
  // Force DENY via A≥0.9 with injectable-like high dims.
  const highA = scoreRiskVector({ toolName: 'shell.execute' });
  highA.dims.A = 0.95;
  highA.score = scoreFromDims(highA.dims);
  assert.equal(riskVectorGateHint(highA), 'DENY');
  const outA = applyRiskVectorGate({
    gateDecision: allowGate,
    vector: highA,
    toolReadOnly: false
  });
  assert.equal(outA.decision, 'BLOCK');
  assert.equal(outA.reasonCode, RISK_VECTOR_DENY);
  assert.equal(outA.elevated, true);

  // Force DENY via score≥0.75.
  const highScore = {
    dims: { I: 0.8, P: 0.8, B: 0.8, V: 0.8, D: 0.8, A: 0.8, X: 0.8, N: 0.8, F: 0.8, T: 0.8 },
    score: 0.8,
    reasons: ['INJECTED_HIGH']
  };
  assert.equal(riskVectorGateHint(highScore), 'DENY');
  const outS = applyRiskVectorGate({
    gateDecision: requireGate,
    vector: highScore,
    toolReadOnly: false
  });
  assert.equal(outS.decision, 'BLOCK');
  assert.equal(outS.reasonCode, RISK_VECTOR_DENY);
  assert.equal(outS.elevated, true);
});

test('T-rv-5 already BLOCK / readOnly low → no false elevate', () => {
  const pathAnalysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  const vector = scoreRiskVector({ toolName: 'shell.execute', pathAnalysis });
  assert.equal(riskVectorGateHint(vector), 'REQUIRE_APPROVAL');

  const blocked = applyRiskVectorGate({
    gateDecision: blockGate,
    vector,
    toolReadOnly: false
  });
  assert.equal(blocked.decision, 'BLOCK');
  assert.equal(blocked.reasonCode, 'HARD_BLOCK');
  assert.equal(blocked.elevated, false);
  assert.equal(blocked.preservedBlock, true);

  const lowRead = scoreRiskVector({
    toolName: 'workspace.read.content',
    runStats: { toolCount: 0 }
  });
  assert.ok(lowRead.score < 0.4, `low read score=${lowRead.score}`);
  const readOnlyOut = applyRiskVectorGate({
    gateDecision: allowGate,
    vector: lowRead,
    toolReadOnly: true
  });
  assert.equal(readOnlyOut.decision, 'ALLOW');
  assert.equal(readOnlyOut.elevated, false);
  assert.equal(readOnlyOut.readOnly, true);

  // Even shell vector must not elevate when toolReadOnly.
  const readOnlyShell = applyRiskVectorGate({
    gateDecision: allowGate,
    vector,
    toolReadOnly: true
  });
  assert.equal(readOnlyShell.elevated, false);
  assert.equal(readOnlyShell.decision, 'ALLOW');
});

test('T-rv-6 DDA_RISK_VECTOR=0 → baseline', () => {
  assert.equal(isRiskVectorEnabled({ DDA_RISK_VECTOR: '0' }), false);
  const pathAnalysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  const vector = scoreRiskVector({ toolName: 'shell.execute', pathAnalysis });
  const out = applyRiskVectorGate({
    gateDecision: allowGate,
    vector,
    enabled: false,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
  assert.equal(out.disabled, true);
  assert.equal(out.hint, 'NONE');
});

test('Path-off heuristic for P/X (no pathAnalysis)', () => {
  const shell = scoreRiskVector({ toolName: 'shell.execute', runStats: { toolCount: 0 } });
  assert.ok(shell.reasons.includes('PATH_ANALYSIS_ABSENT_HEURISTIC'));
  assert.ok(shell.dims.P >= 0.5, `shell P heuristic=${shell.dims.P}`);
  assert.ok(shell.dims.X > 0, `shell X heuristic=${shell.dims.X}`);

  const net = scoreRiskVector({ toolName: 'network.fetch' });
  assert.ok(net.dims.P >= 0.7, `network P=${net.dims.P}`);
  assert.ok(net.dims.X >= 0.7, `network X=${net.dims.X}`);

  const write = scoreRiskVector({
    toolName: 'file.write',
    toolArgs: { path: 'a.mjs' }
  });
  assert.ok(write.dims.P >= 0.4, `write P=${write.dims.P}`);
  assert.equal(write.dims.X, 0);
});

test('telemetry rounds dims; combine max; weights injectable', () => {
  const v = scoreRiskVector({
    toolName: 'file.write',
    toolArgs: { path: 'x.mjs' },
    pathAnalysis: analyzeCapabilityPath({ toolName: 'file.write' })
  });
  const telem = riskVectorTelemetry(v, { stepCount: 3 });
  assert.equal(telem.stepCount, 3);
  assert.equal(Object.keys(telem.dims).length, 10);
  for (const k of Object.keys(telem.dims)) {
    const s = String(telem.dims[k]);
    const frac = s.includes('.') ? s.split('.')[1] : '';
    assert.ok(frac.length <= 2, `${k}=${telem.dims[k]}`);
  }

  const a = scoreRiskVector({ toolName: 'workspace.read.content' });
  const b = scoreRiskVector({ toolName: 'file.write', toolArgs: { path: 'z.mjs' } });
  const c = combineTrajectoryRisk([a, b]);
  assert.equal(c.stepCount, 2);
  assert.ok(c.dims.A >= b.dims.A);

  const skewed = scoreFromDims(
    { I: 1, P: 0, B: 0, V: 0, D: 0, A: 0, X: 0, N: 0, F: 0, T: 0 },
    { I: 1, P: 0, B: 0, V: 0, D: 0, A: 0, X: 0, N: 0, F: 0, T: 0 }
  );
  assert.equal(skewed, 1);
});

test('stricter combined hint overrides step (index contract)', () => {
  const readVec = scoreRiskVector({ toolName: 'dda.trajectory.read' });
  const lowNet = {
    toolName: 'network.fetch',
    dims: { I: 0.2, P: 0.2, B: 0.2, V: 0.1, D: 0.2, A: 0.3, X: 0.3, N: 0.1, F: 0.1, T: 0.2 },
    score: 0.2,
    reasons: []
  };
  assert.equal(riskVectorGateHint(lowNet), 'NONE');
  const combined = combineTrajectoryRisk([readVec, lowNet]);
  assert.ok(combined.reasons.includes(TRAJECTORY_READ_THEN_EGRESS));
  // After bump, D/X ≥0.7 may push score into approval band.
  const stepHint = riskVectorGateHint(lowNet);
  const comboHint = riskVectorGateHint(combined);
  assert.ok(hintRank(comboHint) >= hintRank(stepHint));
});
