import { createHash } from 'node:crypto';
const REQUIRED_DECISION_TYPES = Object.freeze([
  'CLASSIFY_TASK',
  'SELECT_ROUTE',
  'ALLOCATE_ROLE_CONTEXTS',
  'CREATE_PLAN',
  'VERIFY_TASK_RESULT'
]);
const EVIDENCE_DECISION_TYPES = new Set([
  'SELECT_TOOL_ACTION',
  'SELECT_CANDIDATE',
  'VERIFY_TASK_RESULT',
  'DIAGNOSE_VERIFICATION',
  'RECOVER_TASK'
]);
const NO_EVIDENCE_REQUIRED_CODE = 'NO_EVIDENCE_REQUIRED';
const LEARNING_OUTCOME_STATUSES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED']);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const clone = (value) => structuredClone(value);
const ratio = (passed, total) => total === 0 ? 1 : passed / total;
const percent = (passed, total) => Math.round(ratio(passed, total) * 10000) / 100;

const safeDecisionTypes = (decisions) => [...new Set(decisions.map((decision) => decision.decisionType).filter((type) => typeof type === 'string'))].sort();
const hasNoEvidenceRequirement = (decision) => Array.isArray(decision.reasonCodes)
  && decision.reasonCodes.includes(NO_EVIDENCE_REQUIRED_CODE);
const hasEliminationReasons = (decision) => decision.options
  .filter((option) => option.optionId !== decision.selectedOptionId)
  .every((option) => Array.isArray(option.rejectionReasonCodes) && option.rejectionReasonCodes.length > 0);
const outcomeMap = (trace, decisions) => {
  const result = new Map();
  for (const decision of decisions) {
    const outcomes = trace.listOutcomes(decision.decisionId);
    if (outcomes.length > 0) result.set(decision.decisionId, outcomes.sort((left, right) => right.linkedAtMs - left.linkedAtMs)[0]);
  }
  return result;
};

export const evaluateDecisionTrace = ({ trace, runId } = {}) => {
  if (!trace || typeof trace.list !== 'function' || typeof trace.listEvents !== 'function') throw new Error('DECISION_EVALUATOR_TRACE_REQUIRED');
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('DECISION_EVALUATOR_RUN_ID_REQUIRED');
  const decisions = trace.list({ runId }).sort((left, right) => left.createdAtMs - right.createdAtMs || left.decisionId.localeCompare(right.decisionId));
  const outcomes = outcomeMap(trace, decisions);
  const events = trace.listEvents({ runId });
  const committed = decisions.filter((decision) => decision.status === 'COMMITTED');
  const committedRequiredTypes = REQUIRED_DECISION_TYPES.filter((type) => committed.some((decision) => decision.decisionType === type));
  const presentRequiredTypes = REQUIRED_DECISION_TYPES.filter((type) => decisions.some((decision) => decision.decisionType === type));
  const missingRequiredTypes = REQUIRED_DECISION_TYPES.filter((type) => !committedRequiredTypes.includes(type));
  const decisionCoverage = {
    metric: 'decision-coverage',
    passed: committedRequiredTypes.length,
    total: REQUIRED_DECISION_TYPES.length,
    percent: percent(committedRequiredTypes.length, REQUIRED_DECISION_TYPES.length),
    requiredTypes: REQUIRED_DECISION_TYPES,
    presentRequiredTypes,
    committedRequiredTypes,
    missingRequiredTypes,
    decisionCount: decisions.length,
    committedDecisions: committed.length,
    allCommitted: decisions.length > 0 && committed.length === decisions.length,
    allRequiredTypesCommitted: committedRequiredTypes.length === REQUIRED_DECISION_TYPES.length
  };
  const branchDecisions = decisions.filter((decision) => Array.isArray(decision.options) && decision.options.length > 1);
  const selectedOptions = branchDecisions.filter((decision) => typeof decision.selectedOptionId === 'string'
    && decision.options.some((option) => option.optionId === decision.selectedOptionId)
    && hasEliminationReasons(decision));
  const missingEliminationReasonDecisionIds = branchDecisions
    .filter((decision) => !hasEliminationReasons(decision))
    .map((decision) => decision.decisionId);
  const optionCoverage = {
    metric: 'option-coverage',
    passed: selectedOptions.length,
    total: branchDecisions.length,
    percent: branchDecisions.length === 0 ? 0 : percent(selectedOptions.length, branchDecisions.length),
    branchDecisionCount: branchDecisions.length,
    vacuous: branchDecisions.length === 0,
    allSelected: branchDecisions.length > 0 && selectedOptions.length === branchDecisions.length,
    missingDecisionIds: branchDecisions.filter((decision) => !selectedOptions.includes(decision)).map((decision) => decision.decisionId),
    missingEliminationReasonDecisionIds
  };
  const evidenceDecisions = decisions.filter((decision) => EVIDENCE_DECISION_TYPES.has(decision.decisionType));
  const exemptEvidenceDecisions = evidenceDecisions.filter(hasNoEvidenceRequirement);
  const evidenceRequiredDecisions = evidenceDecisions.filter((decision) => !hasNoEvidenceRequirement(decision));
  const linkedEvidence = evidenceRequiredDecisions.filter((decision) => Array.isArray(decision.evidenceRefs) && decision.evidenceRefs.length > 0
    || decision.options?.some((option) => option.evidenceRefs?.length > 0));
  const evidenceLinkRate = {
    metric: 'evidence-link-rate',
    passed: linkedEvidence.length,
    total: evidenceRequiredDecisions.length,
    percent: percent(linkedEvidence.length, evidenceRequiredDecisions.length),
    vacuous: evidenceRequiredDecisions.length === 0,
    exemptDecisionIds: exemptEvidenceDecisions.map((decision) => decision.decisionId),
    allLinked: evidenceRequiredDecisions.length === 0 || linkedEvidence.length === evidenceRequiredDecisions.length,
    missingDecisionIds: evidenceRequiredDecisions.filter((decision) => !linkedEvidence.includes(decision)).map((decision) => decision.decisionId)
  };
  const linkedOutcomes = decisions.filter((decision) => outcomes.has(decision.decisionId));
  const decisionOutcomeLinkRate = {
    metric: 'decision-outcome-link-rate',
    passed: linkedOutcomes.length,
    total: decisions.length,
    percent: percent(linkedOutcomes.length, decisions.length),
    allLinked: decisions.length > 0 && linkedOutcomes.length === decisions.length,
    missingDecisionIds: decisions.filter((decision) => !outcomes.has(decision.decisionId)).map((decision) => decision.decisionId)
  };
  const eventDecisionIds = new Set(events.map((event) => event.decisionId));
  const invalidParentRefs = decisions.flatMap((decision) => (decision.parentDecisionIds ?? []).filter((parentId) => !decisions.some((parent) => parent.decisionId === parentId)).map((parentId) => ({ decisionId: decision.decisionId, parentId })));
  const traceIntegrity = {
    metric: 'trace-integrity',
    eventCount: events.length,
    decisionsWithEvents: decisions.filter((decision) => eventDecisionIds.has(decision.decisionId)).length,
    missingEventDecisionIds: decisions.filter((decision) => !eventDecisionIds.has(decision.decisionId)).map((decision) => decision.decisionId),
    invalidParentRefs,
    valid: decisions.length > 0 && invalidParentRefs.length === 0 && decisions.every((decision) => eventDecisionIds.has(decision.decisionId))
      && decisions.every((decision) => DIGEST.test(decision.recordDigest))
  };
  const replayChecksum = `sha256:${requireDigest(JSON.stringify({ decisions, events, outcomes: [...outcomes.values()] }))}`;
  const eligibleForLearning = decisionCoverage.allCommitted
    && decisionCoverage.allRequiredTypesCommitted
    && optionCoverage.allSelected
    && evidenceLinkRate.allLinked
    && decisionOutcomeLinkRate.allLinked
    && traceIntegrity.valid;
  return {
    runId,
    decisionCount: decisions.length,
    decisionTypes: safeDecisionTypes(decisions),
    decisionCoverage,
    optionCoverage,
    evidenceLinkRate,
    decisionOutcomeLinkRate,
    traceIntegrity,
    replayChecksum,
    eligibleForLearning,
    learningExclusionReasons: [
      ...(decisionCoverage.allCommitted ? [] : ['DECISION_NOT_COMMITTED']),
      ...(decisionCoverage.allRequiredTypesCommitted ? [] : ['DECISION_REQUIRED_TYPE_MISSING']),
      ...(optionCoverage.vacuous ? ['DECISION_OPTION_COVERAGE_VACUOUS'] : []),
      ...(!optionCoverage.vacuous && !optionCoverage.allSelected ? ['DECISION_OPTION_UNSELECTED'] : []),
      ...(missingEliminationReasonDecisionIds.length > 0 ? ['DECISION_ELIMINATION_REASON_MISSING'] : []),
      ...(evidenceLinkRate.allLinked ? [] : ['DECISION_EVIDENCE_MISSING']),
      ...(decisionOutcomeLinkRate.allLinked ? [] : ['DECISION_OUTCOME_MISSING']),
      ...(traceIntegrity.valid ? [] : ['DECISION_TRACE_INVALID'])
    ],
    outcomes: [...outcomes.values()].map(clone)
  };
};

const requireDigest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export const exportLearningSample = ({ trace, runId } = {}) => {
  const evaluation = evaluateDecisionTrace({ trace, runId });
  if (!evaluation.eligibleForLearning) throw new Error(`LEARNING_EXPORT_INCOMPLETE:${evaluation.learningExclusionReasons.join(',')}`);
  const decisions = trace.list({ runId }).filter((decision) => decision.status === 'COMMITTED');
  const outcomes = evaluation.outcomes.filter((outcome) => LEARNING_OUTCOME_STATUSES.has(outcome.status));
  if (outcomes.length !== decisions.length) throw new Error('LEARNING_EXPORT_OUTCOME_INELIGIBLE');
  return {
    schemaVersion: '1.0',
    runId,
    replayChecksum: evaluation.replayChecksum,
    decisions: clone(decisions),
    outcomes: clone(outcomes),
    metrics: {
      decisionCoverage: evaluation.decisionCoverage.percent,
      optionCoverage: evaluation.optionCoverage.percent,
      evidenceLinkRate: evaluation.evidenceLinkRate.percent,
      decisionOutcomeLinkRate: evaluation.decisionOutcomeLinkRate.percent,
      traceIntegrity: evaluation.traceIntegrity.valid
    }
  };
};
