// Diagnose / plan topology for single-task complex scheduling (freeze-diagnose-topology-r1).
// Pure functions: complex判定, SELECT_TOPOLOGY candidates, Rule fallback, budgets.
// When topologyEnabled: complex → PLAN_THEN_EXECUTE; DIAGNOSE only after failure evidence.
// Budgets never exempt hard BLOCK / lease.

export const TOPOLOGY_DIRECT_EXECUTE = 'DIRECT_EXECUTE';
export const TOPOLOGY_PLAN_THEN_EXECUTE = 'PLAN_THEN_EXECUTE';
/** Legacy alias — same deliberation semantics as PLAN_THEN_EXECUTE. */
export const TOPOLOGY_DELIBERATE_THEN_EXECUTE = 'DELIBERATE_THEN_EXECUTE';
export const TOPOLOGY_DIAGNOSE_PROBE_RECOVER = 'DIAGNOSE_PROBE_RECOVER';

export const EXECUTION_TOPOLOGIES = Object.freeze([
  TOPOLOGY_DIRECT_EXECUTE,
  TOPOLOGY_PLAN_THEN_EXECUTE,
  TOPOLOGY_DELIBERATE_THEN_EXECUTE,
  TOPOLOGY_DIAGNOSE_PROBE_RECOVER
]);

export const TOPOLOGY_BUDGET_WRITES = 'TOPOLOGY_BUDGET_WRITES';
export const TOPOLOGY_BUDGET_TOOLS = 'TOPOLOGY_BUDGET_TOOLS';
export const TOPOLOGY_BUDGET_PROBES = 'TOPOLOGY_BUDGET_PROBES';

export const DEFAULT_MAX_WRITES = 4;
export const DEFAULT_MAX_TOOLS = 30;
export const DEFAULT_MAX_PROBES = 6;

const WRITE_TOOL_NAMES = new Set([
  'file.write',
  'file.patch',
  'workspace.write',
  'workspace.patch',
  'kernel.workspace_write'
]);

const PROBE_TOOL_NAMES = new Set([
  'workspace.read',
  'workspace.list',
  'workspace.focus',
  'kernel.workspace_read',
  'kernel.workspace_list',
  'kernel.workspace_focus',
  'file.read'
]);

const positiveInt = (value, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
};

/** Map legacy deliberate alias onto the freeze canonical name for comparisons. */
export const normalizeTopology = (topology) => {
  if (topology === TOPOLOGY_DELIBERATE_THEN_EXECUTE) return TOPOLOGY_PLAN_THEN_EXECUTE;
  return topology;
};

export const isBudgetedTopology = (topology) => {
  const id = normalizeTopology(topology);
  return id === TOPOLOGY_PLAN_THEN_EXECUTE || id === TOPOLOGY_DIAGNOSE_PROBE_RECOVER;
};

export const shouldDeliberateForTopology = (topology) => {
  const id = normalizeTopology(topology);
  if (id === TOPOLOGY_DIRECT_EXECUTE) return false;
  if (id === TOPOLOGY_PLAN_THEN_EXECUTE || id === TOPOLOGY_DIAGNOSE_PROBE_RECOVER) return true;
  return undefined;
};

/**
 * Complex判定 (freeze §1.3): dual acceptance OR topologyHint OR prior acceptance fail.
 * `acceptanceFailureEvidence` covers "at least one acceptance fail with still-ungreen"
 * used both for complex and for DIAGNOSE upgrade.
 */
export const isComplexTask = ({
  acceptanceCommands = [],
  topologyHint,
  acceptanceFailureEvidence = false
} = {}) => {
  if (Array.isArray(acceptanceCommands) && acceptanceCommands.length >= 2) return true;
  const hint = typeof topologyHint === 'string' ? topologyHint.trim().toLowerCase() : '';
  if (hint === 'complex' || hint === 'diagnose') return true;
  if (acceptanceFailureEvidence === true) return true;
  return false;
};

/**
 * Failure classification evidence that unlocks DIAGNOSE_PROBE_RECOVER.
 * Not the same as "taskClass === diagnose" (which the rule classifier never emits).
 */
export const hasDiagnoseFailureEvidence = ({
  acceptanceFailureEvidence = false,
  toolInvalidInputUnresolved = false,
  recoveryPointsDiagnose = false,
  verificationFailed = false
} = {}) => Boolean(
  acceptanceFailureEvidence
  || toolInvalidInputUnresolved
  || recoveryPointsDiagnose
  || verificationFailed
);

/**
 * SELECT_TOPOLOGY candidates. Always includes PLAN_THEN_EXECUTE when enabled.
 * DIAGNOSE only when failure evidence exists (not merely taskClass==='diagnose').
 * Legacy DELIBERATE_THEN_EXECUTE kept as alias candidate for Jev compatibility.
 */
export const selectTopologyCandidates = ({
  topologyEnabled = false,
  complex = false,
  failureEvidence = false,
  includeLegacyDeliberate = true
} = {}) => {
  if (topologyEnabled !== true) return [];
  const diagnoseOk = hasDiagnoseFailureEvidence(
    typeof failureEvidence === 'object' && failureEvidence !== null
      ? failureEvidence
      : { acceptanceFailureEvidence: failureEvidence === true }
  );
  const candidates = [TOPOLOGY_DIRECT_EXECUTE, TOPOLOGY_PLAN_THEN_EXECUTE];
  if (includeLegacyDeliberate) candidates.push(TOPOLOGY_DELIBERATE_THEN_EXECUTE);
  if (diagnoseOk) candidates.push(TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
  // complex is informational for callers; candidates always include PLAN for Rule.
  void complex;
  return candidates;
};

/**
 * Rule fallback (no Jev required): complex → PLAN_THEN_EXECUTE;
 * otherwise DIRECT_EXECUTE. Never picks DIAGNOSE as initial without failure evidence.
 */
export const ruleSelectTopology = ({
  topologyEnabled = false,
  complex = false,
  failureEvidence = false,
  preferDiagnoseOnFailure = true
} = {}) => {
  if (topologyEnabled !== true) return undefined;
  const diagnoseOk = hasDiagnoseFailureEvidence(
    typeof failureEvidence === 'object' && failureEvidence !== null
      ? failureEvidence
      : { acceptanceFailureEvidence: failureEvidence === true }
  );
  if (preferDiagnoseOnFailure && diagnoseOk) return TOPOLOGY_DIAGNOSE_PROBE_RECOVER;
  if (complex || diagnoseOk) return TOPOLOGY_PLAN_THEN_EXECUTE;
  return TOPOLOGY_DIRECT_EXECUTE;
};

/** Whether DIAGNOSE may be the *initial* selection (freeze T-topo-2: no). */
export const maySelectDiagnoseInitially = ({ failureEvidence = false } = {}) =>
  hasDiagnoseFailureEvidence(
    typeof failureEvidence === 'object' && failureEvidence !== null
      ? failureEvidence
      : { acceptanceFailureEvidence: failureEvidence === true }
  );

/**
 * After acceptance/verification failure, allow upgrade PLAN → DIAGNOSE.
 * Returns next topology or the current one if upgrade not allowed.
 */
export const upgradeTopologyAfterFailure = ({
  topologyEnabled = false,
  currentTopology,
  failureEvidence = false
} = {}) => {
  if (topologyEnabled !== true) return currentTopology;
  if (!hasDiagnoseFailureEvidence(
    typeof failureEvidence === 'object' && failureEvidence !== null
      ? failureEvidence
      : { acceptanceFailureEvidence: failureEvidence === true, verificationFailed: failureEvidence === true }
  )) {
    return currentTopology;
  }
  const current = normalizeTopology(currentTopology);
  if (current === TOPOLOGY_DIAGNOSE_PROBE_RECOVER) return TOPOLOGY_DIAGNOSE_PROBE_RECOVER;
  if (current === TOPOLOGY_PLAN_THEN_EXECUTE || current === TOPOLOGY_DIRECT_EXECUTE || !current) {
    return TOPOLOGY_DIAGNOSE_PROBE_RECOVER;
  }
  return currentTopology;
};

export const resolveTopologyBudgets = ({
  maxWrites,
  maxTools,
  maxProbes,
  env = typeof process !== 'undefined' ? process.env : {}
} = {}) => ({
  maxWrites: positiveInt(maxWrites ?? env?.DDA_TOPOLOGY_MAX_WRITES, DEFAULT_MAX_WRITES),
  maxTools: positiveInt(maxTools ?? env?.DDA_TOPOLOGY_MAX_TOOLS, DEFAULT_MAX_TOOLS),
  maxProbes: positiveInt(maxProbes ?? env?.DDA_TOPOLOGY_MAX_PROBES, DEFAULT_MAX_PROBES)
});

export const createTopologyBudgetCounters = () => ({
  writes: 0,
  tools: 0,
  probes: 0
});

export const isWriteToolName = (name) => WRITE_TOOL_NAMES.has(String(name ?? ''));

/** Probe = read-only diagnostic action; counted only under DIAGNOSE topology. */
export const isProbeToolCall = ({ name, toolReadOnly } = {}) => {
  const n = String(name ?? '');
  if (PROBE_TOOL_NAMES.has(n)) return true;
  if (toolReadOnly === true && !isWriteToolName(n) && n !== 'shell.execute' && n !== 'test.execute') {
    return true;
  }
  return false;
};

/**
 * Assert budget before allowing a tool call under a budgeted topology.
 * Never softens hard BLOCK: if hardBlocked, return that decision unchanged.
 * When over budget → BLOCK with TOPOLOGY_BUDGET_* reasonCode.
 */
export const assertTopologyBudget = ({
  topologyEnabled = false,
  topology,
  counters = createTopologyBudgetCounters(),
  budgets = resolveTopologyBudgets(),
  toolName,
  toolReadOnly = false,
  hardBlocked = false,
  hardDecision
} = {}) => {
  // Hard BLOCK / lease always wins — topology budget must not exempt.
  if (hardBlocked === true || hardDecision?.decision === 'BLOCK') {
    return {
      allowed: false,
      blocked: true,
      preservedHardBlock: true,
      decision: hardDecision ?? { decision: 'BLOCK', reasonCode: 'HARD_BLOCK' },
      reasonCode: hardDecision?.reasonCode ?? 'HARD_BLOCK',
      reasonCodes: [hardDecision?.reasonCode ?? 'HARD_BLOCK'],
      counters
    };
  }
  if (topologyEnabled !== true || !isBudgetedTopology(topology)) {
    return { allowed: true, blocked: false, reasonCodes: [], counters };
  }

  const next = { ...counters };
  const name = String(toolName ?? '');
  // Prospective counts: reject if *this* call would exceed.
  const nextTools = next.tools + 1;
  if (nextTools > budgets.maxTools) {
    return {
      allowed: false,
      blocked: true,
      decision: {
        decision: 'BLOCK',
        confidence: 1,
        source: 'rule',
        fallbackUsed: false,
        reasonCode: TOPOLOGY_BUDGET_TOOLS,
        decisionType: 'ACTION_GATE'
      },
      reasonCode: TOPOLOGY_BUDGET_TOOLS,
      reasonCodes: [TOPOLOGY_BUDGET_TOOLS],
      counters: next
    };
  }

  const diagnose = normalizeTopology(topology) === TOPOLOGY_DIAGNOSE_PROBE_RECOVER;
  const isWrite = isWriteToolName(name);
  const isProbe = diagnose && isProbeToolCall({ name, toolReadOnly });

  if (isWrite && next.writes + 1 > budgets.maxWrites) {
    return {
      allowed: false,
      blocked: true,
      decision: {
        decision: 'BLOCK',
        confidence: 1,
        source: 'rule',
        fallbackUsed: false,
        reasonCode: TOPOLOGY_BUDGET_WRITES,
        decisionType: 'ACTION_GATE'
      },
      reasonCode: TOPOLOGY_BUDGET_WRITES,
      reasonCodes: [TOPOLOGY_BUDGET_WRITES],
      counters: next
    };
  }

  if (isProbe && next.probes + 1 > budgets.maxProbes) {
    return {
      allowed: false,
      blocked: true,
      decision: {
        decision: 'BLOCK',
        confidence: 1,
        source: 'rule',
        fallbackUsed: false,
        reasonCode: TOPOLOGY_BUDGET_PROBES,
        decisionType: 'ACTION_GATE'
      },
      reasonCode: TOPOLOGY_BUDGET_PROBES,
      reasonCodes: [TOPOLOGY_BUDGET_PROBES],
      counters: next
    };
  }

  return {
    allowed: true,
    blocked: false,
    reasonCodes: [],
    counters: next,
    pendingIncrement: {
      tools: 1,
      writes: isWrite ? 1 : 0,
      probes: isProbe ? 1 : 0
    }
  };
};

/** Apply a successful (or attempted) tool call to counters after gate allow. */
export const commitTopologyBudgetIncrement = (counters, pendingIncrement) => {
  const next = { ...(counters ?? createTopologyBudgetCounters()) };
  if (!pendingIncrement) return next;
  next.tools = (next.tools ?? 0) + (pendingIncrement.tools ?? 0);
  next.writes = (next.writes ?? 0) + (pendingIncrement.writes ?? 0);
  next.probes = (next.probes ?? 0) + (pendingIncrement.probes ?? 0);
  return next;
};

/**
 * Resolve final topology selection: prefer validated Jev choice, else Rule.
 * Rejects DIAGNOSE when no failure evidence even if Jev asks for it.
 * Rejects DIRECT_EXECUTE when complex and no failure evidence (Jev clamp → PLAN).
 */
export const resolveTopologySelection = ({
  topologyEnabled = false,
  complex = false,
  failureEvidence = false,
  jevSelectedId,
  jevSource
} = {}) => {
  if (topologyEnabled !== true) {
    return { topology: undefined, source: 'off', reasonCodes: ['TOPOLOGY_DISABLED'] };
  }
  const candidates = selectTopologyCandidates({
    topologyEnabled: true,
    complex,
    failureEvidence
  });
  const diagnoseOk = maySelectDiagnoseInitially({ failureEvidence });
  // Reject DIAGNOSE without failure evidence even if Jev names it (and even if
  // it was not offered in the candidate list).
  if (jevSource === 'jev' && jevSelectedId === TOPOLOGY_DIAGNOSE_PROBE_RECOVER && !diagnoseOk) {
    const rule = ruleSelectTopology({ topologyEnabled: true, complex, failureEvidence: false });
    return {
      topology: rule,
      source: 'rule',
      reasonCodes: ['RULE_FALLBACK', 'DIAGNOSE_REQUIRES_FAILURE_EVIDENCE'],
      rejectedJev: jevSelectedId
    };
  }
  // freeze-harness-complex-forbid-direct-initial-r1: complex + no failure evidence
  // must not start as DIRECT_EXECUTE — clamp Jev DIRECT to Rule PLAN_THEN_EXECUTE
  // (aligns with ruleSelectTopology / design comment complex → PLAN_THEN_EXECUTE).
  if (
    jevSource === 'jev'
    && complex === true
    && !diagnoseOk
    && normalizeTopology(jevSelectedId) === TOPOLOGY_DIRECT_EXECUTE
  ) {
    const rule = ruleSelectTopology({ topologyEnabled: true, complex: true, failureEvidence: false });
    return {
      topology: rule,
      source: 'rule',
      reasonCodes: ['RULE_FALLBACK', 'COMPLEX_FORBIDS_DIRECT_INITIAL'],
      rejectedJev: jevSelectedId
    };
  }
  if (jevSource === 'jev' && jevSelectedId && candidates.includes(jevSelectedId)) {
    return {
      topology: jevSelectedId,
      source: 'jev',
      reasonCodes: ['JEV_DECISION']
    };
  }
  const rule = ruleSelectTopology({ topologyEnabled: true, complex, failureEvidence });
  return {
    topology: rule,
    source: 'rule',
    reasonCodes: ['RULE_FALLBACK', 'DETERMINISTIC_RULE']
  };
};
