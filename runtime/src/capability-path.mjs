// Capability Path knife: Declared → Effective closure + soft tighten on
// high-risk sinks reached by implication edges. Pure: no I/O.
// Soft tighten only; never exempts hardDecision / lease; never demotes.
// Freeze: freeze-capability-path-r1.md

export const CAPABILITY_PATH_REQUIRE_APPROVAL = 'CAPABILITY_PATH_REQUIRE_APPROVAL';
export const CAPABILITY_PATH_DENY = 'CAPABILITY_PATH_DENY';

/** High-risk sinks (freeze §1.2). */
export const HIGH_RISK_SINKS = Object.freeze([
  'filesystem.write.workspace',
  'workspace.write.patch',
  'process.execute.shell',
  'process.execute.argv',
  'network.connect.host',
  'executor.invoke.controlled'
]);

const HIGH_RISK_SET = new Set(HIGH_RISK_SINKS);

/**
 * Static implication edges: holding `from` may reach `to`.
 * `from` may be an exact node id or a prefix pattern ending in `.*`
 * (e.g. `network.*` matches any node starting with `network.`).
 */
export const CAPABILITY_IMPLICATIONS = Object.freeze([
  Object.freeze({ from: 'shell.execute', to: 'process.execute.shell', reasonCode: 'IMPLIES_SHELL' }),
  Object.freeze({ from: 'shell.execute', to: 'process.execute.argv', reasonCode: 'IMPLIES_ARGV' }),
  Object.freeze({ from: 'file.write', to: 'filesystem.write.workspace', reasonCode: 'IMPLIES_FS_WRITE' }),
  Object.freeze({ from: 'file.write', to: 'workspace.write.patch', reasonCode: 'IMPLIES_PATCH' }),
  Object.freeze({ from: 'file.patch', to: 'filesystem.write.workspace', reasonCode: 'IMPLIES_FS_WRITE' }),
  Object.freeze({ from: 'file.patch', to: 'workspace.write.patch', reasonCode: 'IMPLIES_PATCH' }),
  Object.freeze({ from: 'process.execute.shell', to: 'filesystem.write.workspace', reasonCode: 'SHELL_INDIRECT_WRITE' }),
  Object.freeze({ from: 'process.execute.shell', to: 'network.connect.host', reasonCode: 'SHELL_INDIRECT_NETWORK' }),
  Object.freeze({ from: 'process.execute.argv', to: 'filesystem.write.workspace', reasonCode: 'ARGV_INDIRECT_WRITE' }),
  Object.freeze({ from: 'network.*', to: 'network.connect.host', reasonCode: 'NETWORK_TO_CONNECT' })
]);

export function isCapabilityPathEnabled(env = process.env) {
  return env?.DDA_CAPABILITY_PATH !== '0';
}

function normalizeDeclaredList(toolName, declaredCapabilities) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  push(toolName);
  if (Array.isArray(declaredCapabilities)) {
    for (const item of declaredCapabilities) push(item);
  }
  return out;
}

/**
 * Declared-in convention (freeze §1.3 #4): direct sinks of shell/file tools
 * count as declared-in; indirect shell→fs / shell→network do NOT.
 */
export function declaredInSet(toolName, declared) {
  const set = new Set(declared);
  if (toolName === 'shell.execute') {
    set.add('process.execute.shell');
    set.add('process.execute.argv');
  }
  if (toolName === 'file.write' || toolName === 'file.patch') {
    set.add('filesystem.write.workspace');
    set.add('workspace.write.patch');
  }
  return set;
}

function edgeMatches(fromPattern, node) {
  if (fromPattern === node) return true;
  if (typeof fromPattern === 'string' && fromPattern.endsWith('.*')) {
    const prefix = fromPattern.slice(0, -1); // keep trailing '.'
    // `network.*` matches `network.foo` but not the exact pattern string itself,
    // and not `network.connect.host` when that is already the sink (still OK to match).
    return typeof node === 'string' && node.startsWith(prefix) && node !== fromPattern;
  }
  return false;
}

function buildAdjacency(implications) {
  // Exact edges indexed by from; pattern edges kept separately.
  const exact = new Map();
  const patterns = [];
  for (const edge of implications) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
    const reasonCode = typeof edge.reasonCode === 'string' ? edge.reasonCode : 'IMPLIES';
    if (edge.from.endsWith('.*')) {
      patterns.push({ from: edge.from, to: edge.to, reasonCode });
    } else {
      if (!exact.has(edge.from)) exact.set(edge.from, []);
      exact.get(edge.from).push({ to: edge.to, reasonCode });
    }
  }
  return { exact, patterns };
}

function neighborsOf(node, adj) {
  const out = [];
  const exactList = adj.exact.get(node);
  if (exactList) {
    for (const e of exactList) out.push({ from: node, to: e.to, reasonCode: e.reasonCode });
  }
  for (const p of adj.patterns) {
    if (edgeMatches(p.from, node)) {
      out.push({ from: node, to: p.to, reasonCode: p.reasonCode });
    }
  }
  return out;
}

/**
 * Analyze Declared → Effective capability closure.
 *
 * @param {{
 *   toolName?: string,
 *   declaredCapabilities?: string[],
 *   implications?: Array<{ from: string, to: string, reasonCode?: string }>
 * }} input
 */
export function analyzeCapabilityPath({
  toolName,
  declaredCapabilities,
  implications = CAPABILITY_IMPLICATIONS
} = {}) {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  const declared = normalizeDeclaredList(name, declaredCapabilities);
  const adj = buildAdjacency(Array.isArray(implications) ? implications : CAPABILITY_IMPLICATIONS);

  const effectiveSet = new Set(declared);
  const path = [];
  const queue = [...declared];

  while (queue.length > 0) {
    const node = queue.shift();
    for (const edge of neighborsOf(node, adj)) {
      if (effectiveSet.has(edge.to)) continue;
      effectiveSet.add(edge.to);
      path.push({ from: edge.from, to: edge.to, reasonCode: edge.reasonCode });
      queue.push(edge.to);
    }
  }

  const effective = [...effectiveSet];
  const inSet = declaredInSet(name, declared);
  const highRiskSinks = effective.filter((id) => HIGH_RISK_SET.has(id));
  const expandsBeyondDeclared = highRiskSinks.some((sink) => !inSet.has(sink));

  return {
    declared,
    effective,
    path,
    highRiskSinks,
    expandsBeyondDeclared
  };
}

/**
 * Gate hint from analysis (freeze §1.3 #5).
 * @returns {'NONE' | 'REQUIRE_APPROVAL' | 'DENY'}
 */
export function capabilityPathGateHint(analysis) {
  if (!analysis || typeof analysis !== 'object') return 'NONE';
  if (analysis.expandsBeyondDeclared !== true) return 'NONE';

  const sinks = Array.isArray(analysis.highRiskSinks) ? analysis.highRiskSinks : [];
  const declared = Array.isArray(analysis.declared) ? analysis.declared : [];
  // DENY when undeclared executor.invoke.controlled appears (branch must exist
  // even if default implications have no edge into it — inject edges in tests).
  const toolName = declared[0];
  const inSet = declaredInSet(toolName, declared);
  if (sinks.includes('executor.invoke.controlled') && !inSet.has('executor.invoke.controlled')) {
    return 'DENY';
  }
  return 'REQUIRE_APPROVAL';
}

/**
 * Soft-tighten gate from Capability Path analysis. Elevate only; never demote;
 * never rewrite hard BLOCK; skip readOnly.
 *
 * @returns {{
 *   decision: string | undefined,
 *   reasonCode: string | undefined,
 *   elevated: boolean,
 *   hint: 'NONE' | 'REQUIRE_APPROVAL' | 'DENY',
 *   analysis: object | undefined
 * }}
 */
export function applyCapabilityPathGate({
  gateDecision = {},
  analysis,
  enabled = true,
  toolReadOnly
} = {}) {
  const decision = gateDecision?.decision;
  const reasonCode = gateDecision?.reasonCode;
  const hint = enabled === false ? 'NONE' : capabilityPathGateHint(analysis);

  const unchanged = (extra = {}) => ({
    decision,
    reasonCode,
    elevated: false,
    hint,
    analysis,
    ...extra
  });

  if (enabled === false) return unchanged({ disabled: true });
  if (!analysis || typeof analysis !== 'object') return unchanged();

  // Hard BLOCK short-circuit (including hardDecision path already BLOCK).
  if (decision === 'BLOCK') return unchanged({ preservedBlock: true });

  // Read-only fast-path: never elevate.
  if (toolReadOnly === true) return unchanged({ readOnly: true });

  if (hint === 'NONE') return unchanged();

  // Never demote REQUIRE_APPROVAL / etc. Only elevate ALLOW (and for DENY, may
  // also raise REQUIRE_APPROVAL → BLOCK).
  if (hint === 'DENY') {
    if (decision === 'BLOCK') return unchanged({ preservedBlock: true });
    return {
      decision: 'BLOCK',
      reasonCode: CAPABILITY_PATH_DENY,
      elevated: true,
      hint,
      analysis
    };
  }

  // REQUIRE_APPROVAL: only raise plain ALLOW.
  if (decision !== 'ALLOW') return unchanged();

  return {
    decision: 'REQUIRE_APPROVAL',
    reasonCode: CAPABILITY_PATH_REQUIRE_APPROVAL,
    elevated: true,
    hint,
    analysis
  };
}

/** Compact telemetry blob for Trace / emit (path truncated to 16 edges). */
export function capabilityPathTelemetry(analysis, { pathLimit = 16 } = {}) {
  if (!analysis || typeof analysis !== 'object') {
    return {
      effective: [],
      highRiskSinks: [],
      pathLen: 0,
      expandsBeyondDeclared: false,
      path: []
    };
  }
  const path = Array.isArray(analysis.path) ? analysis.path : [];
  const limit = Number.isInteger(pathLimit) && pathLimit > 0 ? pathLimit : 16;
  return {
    effective: Array.isArray(analysis.effective) ? analysis.effective.slice() : [],
    highRiskSinks: Array.isArray(analysis.highRiskSinks) ? analysis.highRiskSinks.slice() : [],
    pathLen: path.length,
    expandsBeyondDeclared: analysis.expandsBeyondDeclared === true,
    path: path.slice(0, limit).map((e) => ({
      from: e.from,
      to: e.to,
      reasonCode: e.reasonCode
    }))
  };
}
