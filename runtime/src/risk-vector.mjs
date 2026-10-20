// Risk Vector knife: ten-dim score + trajectory soft gate.
// Soft tighten only; never exempts hardDecision / lease; never demotes.
// Freeze: freeze-risk-vector-r1.md
// Consumes Capability Path analysis for P/X (and part of A); does NOT
// duplicate the implication graph.

export const RISK_VECTOR_REQUIRE_APPROVAL = 'RISK_VECTOR_REQUIRE_APPROVAL';
export const RISK_VECTOR_DENY = 'RISK_VECTOR_DENY';
export const TRAJECTORY_READ_THEN_EGRESS = 'TRAJECTORY_READ_THEN_EGRESS';

/** Default equal weights (freeze §1.1). Injectable for tests. */
export const RISK_VECTOR_WEIGHTS = Object.freeze({
  I: 0.1,
  P: 0.1,
  B: 0.1,
  V: 0.1,
  D: 0.1,
  A: 0.1,
  X: 0.1,
  N: 0.1,
  F: 0.1,
  T: 0.1
});

export const DIM_KEYS = Object.freeze(['I', 'P', 'B', 'V', 'D', 'A', 'X', 'N', 'F', 'T']);

/** Tools known to the harness (novelty low). Not an implication graph. */
const KNOWN_TOOLS = new Set([
  'shell.execute',
  'file.write',
  'file.patch',
  'file.read',
  'file.delete',
  'workspace.read.content',
  'workspace.read',
  'workspace.list',
  'kernel.exec',
  'kernel.host_request',
  'kernel.session_start',
  'kernel.session_stop',
  'network.fetch',
  'network.connect',
  'network.request'
]);

const SENSITIVE_TOOL_RE =
  /(trajectory|profile|secret|credential|sensitive|safety\.profile|key(store|ring)?|token|passwd|password)/i;
const NETWORK_TOOL_RE = /network/i;
const SHELL_TOOL_RE = /^(shell\.|process\.|kernel\.exec)/i;
const WRITE_TOOL_RE = /(file\.(write|patch|delete)|filesystem\.write|workspace\.write)/i;
const READ_TOOL_RE = /(file\.read|workspace\.read|workspace\.list|\.read\b)/i;

export function isRiskVectorEnabled(env = process.env) {
  return env?.DDA_RISK_VECTOR !== '0';
}

function clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function round2(n) {
  return Math.round(clamp01(n) * 100) / 100;
}

function maxDimValues(dims) {
  if (!dims || typeof dims !== 'object') return 0;
  let m = 0;
  for (const k of DIM_KEYS) {
    const v = dims[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > m) m = v;
  }
  return m;
}

function emptyDims() {
  return { I: 0, P: 0, B: 0, V: 0, D: 0, A: 0, X: 0, N: 0, F: 0, T: 0 };
}

/**
 * Weighted average of dims. Weights injectable (must sum conceptually to 1;
 * missing keys treated as 0 contribution / still divide by sum of provided).
 */
export function scoreFromDims(dims, weights = RISK_VECTOR_WEIGHTS) {
  const w = weights && typeof weights === 'object' ? weights : RISK_VECTOR_WEIGHTS;
  let num = 0;
  let den = 0;
  for (const k of DIM_KEYS) {
    const weight = typeof w[k] === 'number' && Number.isFinite(w[k]) ? w[k] : 0;
    const val = typeof dims?.[k] === 'number' && Number.isFinite(dims[k]) ? clamp01(dims[k]) : 0;
    num += weight * val;
    den += weight;
  }
  if (den <= 0) return 0;
  // Avoid binary float tails (0.1+… → 0.10000000000000002).
  return Math.round(clamp01(num / den) * 1e12) / 1e12;
}

function scoreIntentDeviation(toolName, runStats) {
  const name = toolName || '';
  const taskClass = typeof runStats?.taskClass === 'string' ? runStats.taskClass.toLowerCase() : '';
  const goal = typeof runStats?.goal === 'string' ? runStats.goal.toLowerCase() : '';
  const hasPlan = runStats?.hasPlan === true
    || /\b(plan|fix|bug|refactor)\b/.test(taskClass)
    || /\b(fix|bug|plan)\b/.test(goal);

  if (READ_TOOL_RE.test(name) && !WRITE_TOOL_RE.test(name) && !SHELL_TOOL_RE.test(name)) {
    return hasPlan || /fix|bug/.test(taskClass) || /fix|bug/.test(goal) ? 0.05 : 0.15;
  }
  if (SHELL_TOOL_RE.test(name)) return hasPlan ? 0.45 : 0.65;
  if (WRITE_TOOL_RE.test(name)) return hasPlan ? 0.3 : 0.4;
  if (NETWORK_TOOL_RE.test(name)) return hasPlan ? 0.4 : 0.55;
  return 0.25;
}

function scorePrivilege(toolName, pathAnalysis) {
  if (pathAnalysis && typeof pathAnalysis === 'object') {
    const sinks = Array.isArray(pathAnalysis.highRiskSinks) ? pathAnalysis.highRiskSinks : [];
    if (pathAnalysis.expandsBeyondDeclared === true) {
      // Soft-expand into high-risk sinks → elevated privilege.
      return sinks.includes('network.connect.host') || sinks.includes('executor.invoke.controlled')
        ? 0.85
        : 0.75;
    }
    if (sinks.length > 0) return 0.35;
    return 0.1;
  }
  // Path-off heuristic (freeze §1.2).
  const name = toolName || '';
  if (SHELL_TOOL_RE.test(name)) return 0.7;
  if (NETWORK_TOOL_RE.test(name)) return 0.8;
  if (WRITE_TOOL_RE.test(name)) return 0.5;
  return 0.1;
}

function collectWritePaths(toolArgs) {
  if (!toolArgs || typeof toolArgs !== 'object') return [];
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  push(toolArgs.path);
  push(toolArgs.file);
  push(toolArgs.filePath);
  push(toolArgs.target);
  if (Array.isArray(toolArgs.paths)) {
    for (const p of toolArgs.paths) push(p);
  }
  if (Array.isArray(toolArgs.files)) {
    for (const p of toolArgs.files) push(typeof p === 'string' ? p : p?.path);
  }
  return out;
}

function scoreBlastRadius(toolName, toolArgs) {
  const name = toolName || '';
  const paths = collectWritePaths(toolArgs);
  const isWriteLike = WRITE_TOOL_RE.test(name) || SHELL_TOOL_RE.test(name);

  if (paths.length === 0) {
    // No path → neutral 0.3 (freeze); shell/write without path sit at 0.35
    // so Path-expand shell still clears the 0.4 approval band with V=0.
    if (READ_TOOL_RE.test(name) && !isWriteLike) return 0.1;
    return isWriteLike ? 0.35 : 0.2;
  }

  let score = 0.15; // single clear file baseline
  if (paths.length > 1) score = Math.max(score, 0.55);
  for (const p of paths) {
    if (p.includes('*') || p.includes('**') || p.includes('?')) score = Math.max(score, 0.75);
    if (p.startsWith('/') && !p.startsWith('/workspace') && !p.startsWith('/home/box')) {
      score = Math.max(score, 0.7);
    }
    if (/(^|\/)\.\.(\/|$)/.test(p)) score = Math.max(score, 0.8);
  }
  if (paths.length === 1 && score <= 0.15) return 0.15;
  return clamp01(score);
}

function scoreVelocity(runStats) {
  const count = runStats?.toolCount;
  if (count === undefined || count === null || !Number.isFinite(Number(count))) return 0;
  const n = Number(count);
  if (n <= 2) return 0.15;
  if (n <= 10) return 0.5;
  return 0.9;
}

function scoreDataExposure(toolName) {
  const name = toolName || '';
  if (SENSITIVE_TOOL_RE.test(name)) return 0.85;
  if (READ_TOOL_RE.test(name)) return 0.15;
  if (SHELL_TOOL_RE.test(name)) return 0.25;
  if (WRITE_TOOL_RE.test(name)) return 0.2;
  return 0.1;
}

function scoreAutonomy(toolName, pathAnalysis) {
  const name = toolName || '';
  if (READ_TOOL_RE.test(name) && !WRITE_TOOL_RE.test(name) && !SHELL_TOOL_RE.test(name) && !NETWORK_TOOL_RE.test(name)) {
    return 0;
  }
  if (SHELL_TOOL_RE.test(name)) return 0.85;
  if (NETWORK_TOOL_RE.test(name)) return 0.75;
  if (/file\.delete|delete/i.test(name)) return 0.8;
  if (WRITE_TOOL_RE.test(name)) return 0.55;
  // Path sinks can bump A slightly when expands into exec/network.
  if (pathAnalysis?.expandsBeyondDeclared === true) {
    const sinks = pathAnalysis.highRiskSinks ?? [];
    if (sinks.includes('process.execute.shell') || sinks.includes('network.connect.host')) {
      return 0.7;
    }
  }
  return 0.2;
}

function scoreEgress(toolName, pathAnalysis) {
  if (pathAnalysis && typeof pathAnalysis === 'object') {
    const effective = Array.isArray(pathAnalysis.effective) ? pathAnalysis.effective : [];
    const sinks = Array.isArray(pathAnalysis.highRiskSinks) ? pathAnalysis.highRiskSinks : [];
    if (effective.includes('network.connect.host') || sinks.includes('network.connect.host')) {
      return 0.85;
    }
  }
  // Path-off / no analysis heuristic.
  const name = toolName || '';
  if (NETWORK_TOOL_RE.test(name)) return 0.85;
  if (SHELL_TOOL_RE.test(name)) return 0.45; // indirect potential
  return 0;
}

function scoreNovelty(toolName, pathAnalysis) {
  const name = toolName || '';
  if (!name) return 0.9;
  if (KNOWN_TOOLS.has(name)) return 0.1;
  if (pathAnalysis && typeof pathAnalysis === 'object') {
    const path = Array.isArray(pathAnalysis.path) ? pathAnalysis.path : [];
    const effective = Array.isArray(pathAnalysis.effective) ? pathAnalysis.effective : [];
    // Unknown tool with no implication edges → high novelty.
    if (path.length === 0 && effective.length <= 1) return 0.85;
    if (path.length === 0) return 0.6;
    return 0.2;
  }
  // Path-off: unknown name → high.
  if (/^[a-z0-9]+(\.[a-z0-9_-]+)+$/i.test(name)) return 0.7;
  return 0.8;
}

function scoreFanout(runStats) {
  const fanout = runStats?.fanout ?? runStats?.parallelToolCount ?? 1;
  const n = Number(fanout);
  if (!Number.isFinite(n) || n <= 1) return 0.1;
  if (n <= 3) return 0.4;
  if (n <= 6) return 0.7;
  return 0.9;
}

function isSensitiveReadTool(toolName) {
  const name = toolName || '';
  if (SENSITIVE_TOOL_RE.test(name)) return true;
  // Explicit trajectory / profile style ids used in tests/harness.
  return /^(dda\.)?trajectory\b/i.test(name) || /^safety\.profile/i.test(name);
}

function isEgressTool(toolName) {
  const name = toolName || '';
  return NETWORK_TOOL_RE.test(name) || SHELL_TOOL_RE.test(name);
}

/**
 * Score a single-step Risk Vector (freeze §1.1).
 *
 * @param {{
 *   toolName?: string,
 *   pathAnalysis?: object,
 *   runStats?: { toolCount?: number, fanout?: number, taskClass?: string, goal?: string, hasPlan?: boolean },
 *   toolArgs?: object,
 *   priorVector?: { dims?: object },
 *   weights?: object
 * }} input
 */
export function scoreRiskVector({
  toolName,
  pathAnalysis,
  runStats,
  toolArgs,
  priorVector,
  weights = RISK_VECTOR_WEIGHTS
} = {}) {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  const reasons = [];

  const dims = emptyDims();
  dims.I = scoreIntentDeviation(name, runStats);
  dims.P = scorePrivilege(name, pathAnalysis);
  dims.B = scoreBlastRadius(name, toolArgs);
  dims.V = scoreVelocity(runStats);
  dims.D = scoreDataExposure(name);
  dims.A = scoreAutonomy(name, pathAnalysis);
  dims.X = scoreEgress(name, pathAnalysis);
  dims.N = scoreNovelty(name, pathAnalysis);
  dims.F = scoreFanout(runStats);
  // T: single-step placeholder = max of prior dims (or 0).
  dims.T = priorVector?.dims ? maxDimValues(priorVector.dims) : 0;

  if (pathAnalysis?.expandsBeyondDeclared === true) {
    reasons.push('PATH_EXPANDS_BEYOND_DECLARED');
  }
  if (!pathAnalysis) {
    reasons.push('PATH_ANALYSIS_ABSENT_HEURISTIC');
  }
  if (dims.N >= 0.7) reasons.push('NOVEL_TOOL');
  if (SENSITIVE_TOOL_RE.test(name)) reasons.push('SENSITIVE_TOOL');

  const score = scoreFromDims(dims, weights);
  return {
    dims,
    score,
    reasons,
    toolName: name
  };
}

/**
 * Combine ordered step vectors for one run (freeze §1.3).
 * 1) per-dim max
 * 2) sensitive-read → later network/shell bumps D & X to ≥0.7
 * 3) re-score; write T back
 */
export function combineTrajectoryRisk(vectors = [], { weights = RISK_VECTOR_WEIGHTS } = {}) {
  const list = Array.isArray(vectors) ? vectors.filter((v) => v && typeof v === 'object') : [];
  const dims = emptyDims();
  const reasons = [];

  if (list.length === 0) {
    return { dims, score: 0, stepCount: 0, reasons };
  }

  for (const v of list) {
    const d = v.dims || emptyDims();
    for (const k of DIM_KEYS) {
      const val = typeof d[k] === 'number' && Number.isFinite(d[k]) ? clamp01(d[k]) : 0;
      if (val > dims[k]) dims[k] = val;
    }
    if (Array.isArray(v.reasons)) {
      for (const r of v.reasons) {
        if (typeof r === 'string' && r && !reasons.includes(r)) reasons.push(r);
      }
    }
  }

  // Trajectory: sensitive-read/trajectory then later network/shell.
  let seenSensitiveRead = false;
  for (const v of list) {
    const name = typeof v.toolName === 'string' ? v.toolName : '';
    if (!seenSensitiveRead) {
      if (isSensitiveReadTool(name)) seenSensitiveRead = true;
      continue;
    }
    if (isEgressTool(name)) {
      if (dims.D < 0.7) dims.D = 0.7;
      if (dims.X < 0.7) dims.X = 0.7;
      if (!reasons.includes(TRAJECTORY_READ_THEN_EGRESS)) {
        reasons.push(TRAJECTORY_READ_THEN_EGRESS);
      }
      break;
    }
  }

  // Write T back: max of combined dims (trajectory signal) after bumps.
  const withoutT = { ...dims, T: 0 };
  dims.T = Math.max(dims.T, maxDimValues(withoutT));

  const score = scoreFromDims(dims, weights);
  return {
    dims,
    score,
    stepCount: list.length,
    reasons
  };
}

/**
 * @returns {'NONE' | 'REQUIRE_APPROVAL' | 'DENY'}
 */
export function riskVectorGateHint({ score, dims } = {}) {
  const d = dims && typeof dims === 'object' ? dims : {};
  const a = typeof d.A === 'number' ? d.A : 0;
  const x = typeof d.X === 'number' ? d.X : 0;
  const p = typeof d.P === 'number' ? d.P : 0;
  if (a >= 0.9 || x >= 0.9 || p >= 0.9) return 'DENY';
  const s = typeof score === 'number' && Number.isFinite(score) ? score : 0;
  if (s >= 0.75) return 'DENY';
  if (s >= 0.4) return 'REQUIRE_APPROVAL';
  return 'NONE';
}

export function hintRank(hint) {
  if (hint === 'DENY') return 2;
  if (hint === 'REQUIRE_APPROVAL') return 1;
  return 0;
}

function allDimsBelow(dims, threshold = 0.4) {
  if (!dims || typeof dims !== 'object') return true;
  for (const k of DIM_KEYS) {
    const v = dims[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= threshold) return false;
  }
  return true;
}

/**
 * Soft-tighten from Risk Vector. Elevate only; never demote; never rewrite
 * hard BLOCK; readOnly + all dims < 0.4 → force NONE / skip.
 */
export function applyRiskVectorGate({
  gateDecision = {},
  vector,
  hint: hintOverride,
  enabled = true,
  toolReadOnly
} = {}) {
  const decision = gateDecision?.decision;
  const reasonCode = gateDecision?.reasonCode;
  const dims = vector?.dims;
  const score = vector?.score;

  let hint = enabled === false
    ? 'NONE'
    : (hintOverride ?? riskVectorGateHint({ score, dims }));

  // readOnly AND all dims < 0.4 → skip / force NONE (freeze §1.1).
  if (toolReadOnly === true && allDimsBelow(dims, 0.4)) {
    hint = 'NONE';
  }

  const unchanged = (extra = {}) => ({
    decision,
    reasonCode,
    elevated: false,
    hint,
    vector,
    ...extra
  });

  if (enabled === false) return unchanged({ disabled: true });
  if (!vector || typeof vector !== 'object') return unchanged();

  if (decision === 'BLOCK') return unchanged({ preservedBlock: true });

  // Broad readOnly: never elevate (matches T-rv-5 + Path pattern).
  if (toolReadOnly === true) return unchanged({ readOnly: true });

  if (hint === 'NONE') return unchanged();

  if (hint === 'DENY') {
    if (decision === 'BLOCK') return unchanged({ preservedBlock: true });
    return {
      decision: 'BLOCK',
      reasonCode: RISK_VECTOR_DENY,
      elevated: true,
      hint,
      vector
    };
  }

  // REQUIRE_APPROVAL: only raise plain ALLOW.
  if (decision !== 'ALLOW') return unchanged();

  return {
    decision: 'REQUIRE_APPROVAL',
    reasonCode: RISK_VECTOR_REQUIRE_APPROVAL,
    elevated: true,
    hint,
    vector
  };
}

/** Compact telemetry: dims rounded to 2 decimals. */
export function riskVectorTelemetry(vector, { stepCount } = {}) {
  const dimsIn = vector?.dims && typeof vector.dims === 'object' ? vector.dims : emptyDims();
  const dims = {};
  for (const k of DIM_KEYS) dims[k] = round2(dimsIn[k] ?? 0);
  return {
    dims,
    score: round2(typeof vector?.score === 'number' ? vector.score : 0),
    stepCount: Number.isInteger(stepCount)
      ? stepCount
      : (Number.isInteger(vector?.stepCount) ? vector.stepCount : 1)
  };
}
