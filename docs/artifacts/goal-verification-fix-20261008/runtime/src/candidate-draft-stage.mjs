import {
  buildCandidateSelectionDecision,
  CandidateSafetyFilter,
  CandidateSelectionPolicy,
  planCandidateFanout,
  runCandidateFanout
} from './candidate-fanout.mjs';

const clone = (value) => structuredClone(value);

/** Run the read-only candidate draft stage for one role turn.
 *
 * Fanout only ever produces drafts: no candidate model gets tools, no candidate
 * gets a lease, and only the selected draft is handed back to the caller. The
 * unselected drafts stay in memory for the lifetime of the call and are never
 * persisted — the durable record carries per-candidate digests, scores and
 * attribution instead.
 */
export const runCandidateDraftStage = async ({
  spec,
  risk = 'LOW',
  precheck,
  constraints = {},
  draftPrompt,
  draftContext = '',
  invokeCandidate,
  judge,
  signal,
  onEvent
} = {}) => {
  if (typeof invokeCandidate !== 'function') throw new Error('CANDIDATE_DRAFT_INVOKE_REQUIRED');
  const plan = planCandidateFanout({ spec, risk });
  const candidates = plan.candidateBindings.map((binding) => ({
    candidateId: binding.bindingId,
    bindingId: binding.bindingId,
    modelId: binding.modelId,
    ...(binding.provider ? { provider: binding.provider } : {}),
    ...(binding.expectedCost !== undefined ? { expectedCost: binding.expectedCost } : {}),
    ...(binding.expectedLatencyMs !== undefined ? { expectedLatencyMs: binding.expectedLatencyMs } : {}),
    ...(binding.expectedTokens !== undefined ? { expectedTokens: binding.expectedTokens } : {})
  }));

  const safety = new CandidateSafetyFilter().filter({
    candidates,
    precheck,
    constraints: {
      allowedModelIds: candidates.map((candidate) => candidate.modelId),
      ...constraints,
      ...(spec?.fanoutBudget?.maxCost !== undefined ? { maxCost: spec.fanoutBudget.maxCost } : {}),
      ...(spec?.fanoutBudget?.maxTokens !== undefined ? { maxTokens: spec.fanoutBudget.maxTokens } : {})
    }
  });
  if (safety.blocked) {
    return {
      status: 'BLOCKED',
      reason: safety.reason,
      plan,
      safety,
      selectedDraft: undefined,
      decision: undefined,
      optionStates: {}
    };
  }

  const drafts = new Map();
  const fanout = await runCandidateFanout({
    candidates: safety.admitted,
    concurrency: plan.maxConcurrency,
    signal,
    onEvent,
    invoke: async ({ candidate, signal: candidateSignal }) => {
      const output = await invokeCandidate({ binding: candidate, signal: candidateSignal });
      if (typeof output?.text === 'string') drafts.set(candidate.bindingId, output.text);
      return output;
    }
  });

  const selection = await new CandidateSelectionPolicy().select({
    candidates: fanout.candidates,
    judge: judge && typeof judge.score === 'function' ? {
      ...judge,
      score: ({ candidates: pool, ...options }) => judge.score({
        ...options,
        candidates: pool.map((candidate) => ({ ...candidate, draftText: drafts.get(candidate.candidateId) ?? '' }))
      })
    } : judge,
    policyRef: spec?.selectionPolicyRef
  });
  const built = buildCandidateSelectionDecision({
    candidates: fanout.candidates,
    selection,
    selectionPolicyRef: spec?.selectionPolicyRef,
    fanout: plan.fanout,
    risk: plan.risk,
    truncation: {
      requestedFanout: plan.requestedFanout,
      truncated: plan.truncated,
      truncationReasons: plan.truncationReasons,
      droppedBindingIds: plan.droppedBindingIds
    }
  });
  return {
    status: selection.status === 'SELECTED' ? 'SELECTED' : 'NO_ELIGIBLE_CANDIDATE',
    reason: selection.reason,
    plan,
    safety,
    fanout: {
      status: fanout.status,
      reason: fanout.reason,
      successCount: fanout.successCount,
      failureCount: fanout.failureCount,
      duplicates: clone(fanout.duplicates),
      candidates: clone(fanout.candidates)
    },
    selection: clone(selection),
    decision: built,
    optionStates: built.optionStates,
    selectedDraft: selection.selectedCandidateId ? drafts.get(selection.selectedCandidateId) : undefined,
    // Per-candidate cost/egress accounting for Support Bundle and cost reports.
    egress: clone(fanout.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      ...(candidate.provider ? { provider: candidate.provider } : {}),
      ...(candidate.expectedCost !== undefined ? { expectedCost: candidate.expectedCost } : {}),
      ...(candidate.expectedTokens !== undefined ? { expectedTokens: candidate.expectedTokens } : {}),
      status: candidate.status
    })))
  };
};
