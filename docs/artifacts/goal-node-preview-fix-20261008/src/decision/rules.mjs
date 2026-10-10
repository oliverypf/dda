import {
  EVIDENCE_DECISIONS,
  ESCALATION_DECISIONS,
  FAILURE_TYPES,
  STOP_DECISIONS,
  TEST_DECISIONS,
  clamp01,
  decisionResult,
  optionScores
} from './types.mjs';

const textOf = (value) => JSON.stringify(value ?? '').toLowerCase();
const hasAny = (value, patterns) => patterns.some((pattern) => pattern.test(value));

const failure = (decision, reasonCode) => decisionResult({
  decision,
  confidence: 1,
  scores: optionScores(FAILURE_TYPES, decision, 1),
  reasonCode,
  source: 'rule'
});

export const deterministicFailureRouter = ({ action, observation } = {}) => {
  const source = textOf({ action, observation });
  const status = String(observation?.status ?? observation?.result ?? '').toUpperCase();
  const exitCode = observation?.exitCode;
  const failed = observation?.ok === false || (Number.isFinite(Number(exitCode)) && Number(exitCode) !== 0)
    || ['FAIL', 'FAILED', 'ERROR', 'TIMEOUT', 'CANCELLED', 'UNKNOWN', 'UNCERTAIN'].includes(status);
  if (!failed) return failure('NONE', 'EXIT_CODE_ZERO_OR_VERIFIER_PASS');
  const testContext = /test|pytest|vitest|jest|assertion|expected .* actual/u.test(source);
  if (testContext && hasAny(source, [/assertion/u, /test failure/u, /tests? failed/u, /expected .* actual/u, /pytest/u, /vitest/u, /jest/u, /test_failure/u])) {
    return failure('TEST_FAILURE', 'TEST_FAILURE_SIGNAL');
  }
  if (hasAny(source, [/401\b/u, /403\b/u, /permission denied/u, /forbidden/u, /not authorized/u, /access denied/u])) {
    return failure('PERMISSION', 'HTTP_OR_ACCESS_DENIED');
  }
  if (hasAny(source, [/timeout/u, /timed[ -]?out/u, /deadline exceeded/u, /etimedout/u])) {
    return failure('TIMEOUT', 'TIMEOUT_SIGNAL');
  }
  if (hasAny(source, [/command not found/u, /enoent/u, /no such file/u, /working directory/u, /environment/u])) {
    return failure('ENVIRONMENT', 'ENVIRONMENT_SIGNAL');
  }
  if (hasAny(source, [/cannot find module/u, /module not found/u, /package .* not found/u, /dependency/u, /npm err! code enoent/u])) {
    return failure('DEPENDENCY', 'DEPENDENCY_SIGNAL');
  }
  if (hasAny(source, [/tool_error/u, /tool error/u, /tool invocation/u, /invalid tool/u, /tool_not_allowed/u])) {
    return failure('TOOL_ERROR', 'TOOL_FAILURE_SIGNAL');
  }
  if (hasAny(source, [/assertion/u, /test failure/u, /tests? failed/u, /expected .* actual/u, /vitest/u, /jest/u, /pytest/u, /test_failure/u])) {
    return failure('TEST_FAILURE', 'TEST_FAILURE_SIGNAL');
  }
  if (hasAny(source, [/syntaxerror/u, /typeerror/u, /referenceerror/u, /compile error/u, /build failed/u, /lint failed/u, /code_error/u])) {
    return failure('CODE_ERROR', 'CODE_FAILURE_SIGNAL');
  }
  if (hasAny(source, [/assumption/u, /invalid premise/u, /not applicable/u, /wrong target/u])) {
    return failure('BAD_ASSUMPTION', 'ASSUMPTION_FAILURE_SIGNAL');
  }
  return undefined;
};

const evidence = (decision, reasonCode, confidence = 1) => decisionResult({
  decision,
  confidence,
  scores: optionScores(EVIDENCE_DECISIONS, decision, confidence),
  reasonCode,
  source: 'rule'
});

const hasEvidenceType = (state, types) => state.evidence.some((item) => types.includes(item.type));

export const deterministicEvidenceJudge = (state = {}) => {
  const requirements = Array.isArray(state.requirements) ? state.requirements : [];
  if (requirements.some((item) => item.status === 'contradicted')) {
    return evidence('CONFLICTING_EVIDENCE', 'REQUIRED_REQUIREMENT_CONTRADICTED');
  }
  if (requirements.some((item) => item.status === 'unknown' && /test|regression|verify|验证/u.test(item.description ?? ''))
    && !hasEvidenceType(state, ['test_result'])) {
    return evidence('MISSING_TEST_EVIDENCE', 'TEST_REQUIREMENT_UNVERIFIED');
  }
  if (requirements.some((item) => item.status === 'unknown' && /environment|runtime|permission|环境/u.test(item.description ?? ''))
    && !hasEvidenceType(state, ['runtime_state', 'external_fact'])) {
    return evidence('MISSING_ENVIRONMENT_EVIDENCE', 'RUNTIME_REQUIREMENT_UNVERIFIED');
  }
  if (requirements.some((item) => item.status === 'unknown') && !hasEvidenceType(state, ['tool_result', 'test_result', 'file_content', 'runtime_state'])) {
    return evidence('MISSING_EXECUTION_EVIDENCE', 'NO_EXECUTION_EVIDENCE');
  }
  if (requirements.length > 0 && requirements.every((item) => item.status === 'supported')) {
    return evidence('SUFFICIENT', 'ALL_REQUIREMENTS_SUPPORTED');
  }
  if (state.observation?.ok === true && state.observation?.status === 'PASS') {
    return evidence('SUFFICIENT', 'PASS_WITHOUT_UNRESOLVED_REQUIREMENTS');
  }
  return undefined;
};

const testResult = (decision, candidate, reasonCode, confidence = 1) => decisionResult({
  decision,
  confidence,
  scores: optionScores(TEST_DECISIONS, decision, confidence),
  reasonCode,
  source: 'rule',
  ...(candidate ? { candidateId: candidate.id, command: candidate.command } : {})
});

export const deterministicTestSelector = (state = {}, evidenceDecision) => {
  if (evidenceDecision?.decision === 'SUFFICIENT') return testResult('NONE', undefined, 'EVIDENCE_ALREADY_SUFFICIENT');
  const candidates = Array.isArray(state.availableTests) ? state.availableTests : [];
  if (!candidates.length) return undefined;
  const ranked = candidates.slice().sort((left, right) => {
    const leftScore = (Number(left.estimatedCost) || 0) + ((Number(left.estimatedDurationMs) || 0) / 1000);
    const rightScore = (Number(right.estimatedCost) || 0) + ((Number(right.estimatedDurationMs) || 0) / 1000);
    return leftScore - rightScore || left.id.localeCompare(right.id);
  });
  const selected = ranked[0];
  const type = String(selected.type ?? 'targeted').toLowerCase();
  const decision = {
    targeted: 'RUN_TARGETED_TEST',
    unit: 'RUN_UNIT_TEST',
    integration: 'RUN_INTEGRATION_TEST',
    lint: 'RUN_LINT',
    typecheck: 'RUN_TYPECHECK',
    build: 'RUN_BUILD',
    full: 'RUN_FULL_TEST'
  }[type] ?? 'RUN_TARGETED_TEST';
  return testResult(decision, selected, 'CHEAPEST_AVAILABLE_EVIDENCE', candidates.length === 1 ? 0.9 : 0.55);
};

const stop = (decision, reasonCode, confidence = 1) => decisionResult({
  decision,
  confidence,
  scores: optionScores(STOP_DECISIONS, decision, confidence),
  reasonCode,
  source: 'rule'
});

export const deterministicStopJudge = (state = {}, failureDecision, evidenceDecision) => {
  if (state.observation?.status === 'PASS' && state.requirements?.some((item) => item.status === 'contradicted')) {
    return stop('NEED_MORE_EVIDENCE', 'CONTRADICTED_REQUIREMENT_BLOCKS_STOP');
  }
  if (failureDecision?.decision && failureDecision.decision !== 'NONE') {
    if (['PERMISSION', 'TIMEOUT'].includes(failureDecision.decision)) {
      return stop('NEED_ESCALATION', 'NON_RETRYABLE_OR_EXPENSIVE_FAILURE');
    }
    return stop('CONTINUE_EXECUTION', 'RECOVERABLE_FAILURE');
  }
  if (evidenceDecision?.decision && evidenceDecision.decision !== 'SUFFICIENT') {
    return stop('NEED_MORE_EVIDENCE', 'EVIDENCE_GAP_REMAINS');
  }
  if (state.observation?.status === 'PASS' && (state.requirements ?? []).every((item) => item.status !== 'unknown')) {
    return stop('STOP_SUCCESS', 'HARD_SUCCESS_WITH_COMPLETE_REQUIREMENTS');
  }
  if (state.observation?.status === 'PASS') return stop('STOP_SUCCESS', 'VERIFIER_PASS');
  return undefined;
};

const escalation = (decision, reasonCode, confidence = 1) => decisionResult({
  decision,
  confidence,
  scores: optionScores(ESCALATION_DECISIONS, decision, confidence),
  reasonCode,
  source: 'rule'
});

export const deterministicEscalationGate = (state = {}, { failureDecision, evidenceDecision, stopDecision } = {}) => {
  if (failureDecision?.decision === 'PERMISSION') return escalation('USE_STRONG_MODEL', 'PERMISSION_REQUIRES_NEW_REASONING');
  if (failureDecision?.decision === 'TIMEOUT' && (state.retryCount ?? 0) > 0) return escalation('USE_STRONG_MODEL', 'REPEATED_TIMEOUT');
  if (evidenceDecision?.decision === 'CONFLICTING_EVIDENCE') return escalation('USE_STRONG_MODEL', 'CONFLICTING_EVIDENCE');
  if (stopDecision?.decision === 'STOP_SUCCESS') return escalation('LOCAL_CONTINUE', 'NO_ESCALATION_AFTER_SUCCESS');
  if ((state.retryCount ?? 0) >= 3 || (state.loopCount ?? 0) >= 8) return escalation('USE_STRONG_MODEL', 'RECOVERY_BUDGET_NEAR_EXHAUSTION');
  if ((state.currentConfidence ?? 1) >= 0.8) return escalation('LOCAL_CONTINUE', 'HIGH_CONFIDENCE');
  if (state.availableTests?.length) return escalation('COLLECT_EVIDENCE', 'CHEAPER_EVIDENCE_AVAILABLE', 0.7);
  return undefined;
};

export const fallbackFailure = () => failure('UNKNOWN', 'JEV_UNAVAILABLE_CONSERVATIVE_FALLBACK');
export const fallbackEvidence = () => evidence('UNKNOWN', 'JEV_UNAVAILABLE_CONSERVATIVE_FALLBACK', 0.2);
export const fallbackTest = () => testResult('NONE', undefined, 'JEV_UNAVAILABLE_CONSERVATIVE_FALLBACK', 0.2);
export const fallbackStop = () => stop('NEED_MORE_EVIDENCE', 'JEV_UNAVAILABLE_CONSERVATIVE_FALLBACK', 0.2);
export const fallbackEscalation = () => escalation('USE_STRONG_MODEL', 'JEV_UNAVAILABLE_CONSERVATIVE_FALLBACK', 0.2);

export const normalizeDecisionChoice = (raw, allowed, fallback) => {
  const rawDecision = raw?.decision ?? raw?.choice ?? raw?.label ?? raw?.value;
  const decision = typeof rawDecision === 'string' && allowed.includes(rawDecision.toUpperCase())
    ? rawDecision.toUpperCase()
    : fallback;
  const confidence = clamp01(raw?.confidence ?? raw?.score ?? raw?.probability, 0);
  const scores = raw?.scores ?? raw?.probabilities ?? raw?.distribution;
  return { decision, confidence, scores, reasonCode: raw?.reasonCode ?? 'JEV_CHOICE' };
};
