// Shared initial SELECT_TOPOLOGY for single + multi agentMode
// (freeze-harness-select-topology-single-r1). Extracted so tip default
// agentMode=single also emits topology.selected / PLAN_THEN_EXECUTE when
// topologyEnabled — previously the block lived only inside multi.
// Pure resolve stays in execution-topology.mjs; this module owns the
// Jev-optional pick + decision/event shape used by index.mjs.

import {
  TOPOLOGY_DIRECT_EXECUTE,
  TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
  isComplexTask,
  selectTopologyCandidates,
  resolveTopologySelection,
  shouldDeliberateForTopology
} from './execution-topology.mjs';

/**
 * Run one initial topology selection when topologyEnabled.
 * Skips on resumed plans and when topology is off.
 * agentMode is informational only — single and multi both call this.
 *
 * @returns {Promise<null | {
 *   selectedTopology: string,
 *   topologySelection: object,
 *   shouldDeliberate: boolean|undefined,
 *   complexTask: boolean,
 *   candidateIds: string[],
 *   resolved: object,
 *   topologyCandidates: object[]
 * }>}
 */
export async function runInitialTopologySelection({
  topologyEnabled = false,
  restoredResumePlan = false,
  prompt = '',
  topologyHint = '',
  acceptanceCommands = [],
  acceptanceFailureEvidence = false,
  topologyBudgets,
  planStepCount,
  planDigest,
  runId,
  decisionEngine,
  // Optional: caller may pre-supply extract; default uses length of acceptanceCommands
} = {}) {
  if (restoredResumePlan || topologyEnabled !== true) return null;

  const complexTask = isComplexTask({
    acceptanceCommands,
    topologyHint,
    acceptanceFailureEvidence
  });
  const failureEvidence = {
    acceptanceFailureEvidence,
    verificationFailed: acceptanceFailureEvidence
  };
  const candidateIds = selectTopologyCandidates({
    topologyEnabled: true,
    complex: complexTask,
    failureEvidence
  });
  const topologyCandidates = candidateIds.map((id) => ({
    candidateId: id,
    modelId: id,
    status: 'SUCCEEDED',
    expectedCost: id === TOPOLOGY_DIRECT_EXECUTE ? 1 : 2,
    expectedLatencyMs: id === TOPOLOGY_DIRECT_EXECUTE ? 1 : (id === TOPOLOGY_DIAGNOSE_PROBE_RECOVER ? 120 : 100)
  }));

  let jevSelectedId;
  let jevSource;
  if (decisionEngine?.enabled === true && topologyCandidates.length) {
    const jevPick = await decisionEngine.selectCandidates({
      state: {
        taskId: runId,
        goal: prompt,
        currentStep: 'topology-selection',
        action: { kind: 'SELECT_TOPOLOGY', summary: 'Choose the bounded plan execution topology' },
        observation: {
          status: 'PLAN_READY',
          complex: complexTask,
          acceptanceCommandCount: acceptanceCommands.length,
          acceptanceFailureEvidence,
          agentModeAgnostic: true
        },
        evidence: [{
          id: `plan-topology-${runId}`,
          type: 'plan',
          claim: `Plan has ${planStepCount ?? 0} steps`,
          source: planDigest ?? `run:${runId}`
        }]
      },
      candidates: topologyCandidates
    });
    if (jevPick?.source === 'jev') {
      jevSource = 'jev';
      jevSelectedId = jevPick.selectedCandidateId;
    }
  }

  const resolved = resolveTopologySelection({
    topologyEnabled: true,
    complex: complexTask,
    failureEvidence,
    jevSelectedId,
    jevSource
  });
  const selectedTopology = resolved.topology;
  const topologySelection = {
    topology: selectedTopology,
    source: resolved.source,
    reasonCodes: resolved.reasonCodes,
    complex: complexTask,
    candidates: candidateIds,
    budgets: topologyBudgets,
    ...(resolved.rejectedJev ? { rejectedJev: resolved.rejectedJev } : {})
  };

  return {
    selectedTopology,
    topologySelection,
    shouldDeliberate: shouldDeliberateForTopology(selectedTopology),
    complexTask,
    candidateIds,
    resolved,
    topologyCandidates
  };
}

/** Decision-trace payload shared by single + multi callers. */
export function buildSelectTopologyDecisionRecord({
  runId,
  parentDecisionId,
  selectedTopology,
  resolved,
  complexTask,
  topologyCandidates
}) {
  return {
    stepId: 'topology-selection',
    role: 'decision-engine',
    roleContextId: `${runId}-decision-engine`,
    decisionType: 'SELECT_TOPOLOGY',
    actionKind: 'TOPOLOGY',
    parentDecisionIds: parentDecisionId ? [parentDecisionId] : [],
    summary: resolved.source === 'jev'
      ? `Jev selected ${selectedTopology}`
      : `Rule selected ${selectedTopology} (topologyEnabled Rule fallback)`,
    outputRefs: [`topology-${runId}`],
    options: (topologyCandidates ?? []).map(({ candidateId: optionId }) => ({
      optionId,
      actionKind: 'TOPOLOGY',
      summary: optionId,
      requiredCapabilityIds: [],
      evidenceRefs: [],
      riskCodes: optionId === TOPOLOGY_DIAGNOSE_PROBE_RECOVER ? ['DIAGNOSE_PATH'] : [],
      rejectionReasonCodes: optionId === selectedTopology ? [] : ['NOT_SELECTED']
    })),
    selectedOptionId: selectedTopology,
    reasonCodes: resolved.reasonCodes,
    selectionCriteria: ['bounded-plan-topology', ...(complexTask ? ['complex-default-plan-then-execute'] : [])]
  };
}
