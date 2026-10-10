import { createHash } from 'node:crypto';

export const FAILURE_TYPES = Object.freeze([
  'NONE',
  'CODE_ERROR',
  'TEST_FAILURE',
  'ENVIRONMENT',
  'DEPENDENCY',
  'PERMISSION',
  'TOOL_ERROR',
  'TIMEOUT',
  'BAD_ASSUMPTION',
  'UNKNOWN'
]);

export const EVIDENCE_DECISIONS = Object.freeze([
  'SUFFICIENT',
  'MISSING_EXECUTION_EVIDENCE',
  'MISSING_TEST_EVIDENCE',
  'MISSING_ENVIRONMENT_EVIDENCE',
  'CONFLICTING_EVIDENCE',
  'UNKNOWN'
]);

export const TEST_DECISIONS = Object.freeze([
  'RUN_TARGETED_TEST',
  'RUN_UNIT_TEST',
  'RUN_INTEGRATION_TEST',
  'RUN_LINT',
  'RUN_TYPECHECK',
  'RUN_BUILD',
  'RUN_FULL_TEST',
  'NONE'
]);

export const STOP_DECISIONS = Object.freeze([
  'STOP_SUCCESS',
  'CONTINUE_EXECUTION',
  'NEED_MORE_EVIDENCE',
  'NEED_REPLAN',
  'NEED_ESCALATION'
]);

export const ESCALATION_DECISIONS = Object.freeze([
  'LOCAL_CONTINUE',
  'RETRY_CHEAP',
  'COLLECT_EVIDENCE',
  'USE_NORMAL_MODEL',
  'USE_STRONG_MODEL'
]);

// These are semantic decisions owned by the Jev Decision Plane. They are
// deliberately finite: Jev may choose an outcome, but it may not invent a
// tool, command, permission or candidate.
export const ACTION_GATE_DECISIONS = Object.freeze([
  'ALLOW',
  'BLOCK',
  'REQUIRE_APPROVAL',
  'REQUEST_EVIDENCE'
]);

export const VERIFICATION_DECISIONS = Object.freeze([
  'PASS',
  'FAIL',
  'UNCERTAIN'
]);

export const DECISION_SOURCES = Object.freeze(['rule', 'jev']);

const MAX_TEXT = 800;
const MAX_LIST = 64;
const DEFAULT_MAX_STATE_CHARS = 16000;
const MIN_STATE_CHARS = 1000;
const MAX_STATE_CHARS = 32000;

const normalizeStateLimit = (value) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(MIN_STATE_CHARS, Math.min(MAX_STATE_CHARS, Math.trunc(number)))
    : DEFAULT_MAX_STATE_CHARS;
};

export const clamp01 = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
};

export const bounded = (value, max = MAX_TEXT) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max);

export const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex')}`;

const clone = (value) => structuredClone(value);

const normalizeList = (value, mapper = (item) => item) => (Array.isArray(value) ? value : [])
  .slice(0, MAX_LIST)
  .map(mapper)
  .filter(Boolean);

const normalizeEvidence = (item, index) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const type = bounded(item.type ?? item.evidenceType ?? 'runtime_state', 80) || 'runtime_state';
  const claim = bounded(item.claim ?? item.summary ?? item.message ?? item.status, 500);
  const source = bounded(item.source ?? item.sourceRef ?? item.eventId ?? `evidence-${index}`, 240);
  return {
    id: bounded(item.id ?? item.evidenceId ?? `evidence-${index + 1}`, 160),
    type,
    claim,
    source,
    confidence: clamp01(item.confidence, 0.5),
    ...(item.freshness === undefined ? {} : { freshness: clamp01(item.freshness, 0.5) }),
    relatedRequirementIds: normalizeList(item.relatedRequirementIds, (id) => bounded(id, 120))
  };
};

const normalizeRequirement = (item, index) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const status = bounded(item.status ?? 'unknown', 24).toLowerCase();
  return {
    id: bounded(item.id ?? `requirement-${index + 1}`, 160),
    description: bounded(item.description ?? item.claim ?? '', 500),
    status: ['unknown', 'supported', 'contradicted'].includes(status) ? status : 'unknown',
    evidenceIds: normalizeList(item.evidenceIds, (id) => bounded(id, 160))
  };
};

const normalizeAction = (action = {}) => ({
  kind: bounded(action.kind ?? action.actionKind ?? 'EXECUTE', 120),
  summary: bounded(action.summary ?? action.command ?? action.name ?? '', 600),
  ...(action.stepId ? { stepId: bounded(action.stepId, 160) } : {}),
  ...(action.attempt === undefined ? {} : { attempt: Number(action.attempt) || 0 }),
  ...(action.argumentsDigest ? { argumentsDigest: bounded(action.argumentsDigest, 120) } : {})
});

const normalizeObservation = (observation = {}) => ({
  status: bounded(observation.status ?? observation.result ?? observation.state ?? 'UNKNOWN', 40).toUpperCase(),
  ...(observation.ok === undefined ? {} : { ok: observation.ok === true }),
  ...(observation.exitCode === undefined ? {} : { exitCode: Number.isFinite(Number(observation.exitCode)) ? Number(observation.exitCode) : undefined }),
  summary: bounded(observation.summary ?? observation.message ?? '', 1000),
  failureCodes: normalizeList(observation.failureCodes, (code) => bounded(code, 120)),
  checks: normalizeList(observation.checks, (check, index) => ({
    id: bounded(check?.id ?? `check-${index + 1}`, 120),
    status: bounded(check?.status ?? 'UNKNOWN', 24).toUpperCase(),
    message: bounded(check?.message ?? check?.summary ?? '', 400),
    evidence: normalizeList(check?.evidence, (ref) => bounded(ref, 160))
  }))
});

export const createDecisionState = (input = {}, { maxStateChars = DEFAULT_MAX_STATE_CHARS } = {}) => {
  const stateLimit = normalizeStateLimit(maxStateChars);
  const state = {
    taskId: bounded(input.taskId ?? 'task-unknown', 240),
    goal: bounded(input.goal ?? '', 1200),
    currentStep: bounded(input.currentStep ?? '', 600),
    stepIndex: Number.isInteger(input.stepIndex) && input.stepIndex >= 0 ? input.stepIndex : 0,
    action: normalizeAction(input.action),
    ...(input.tool ? { tool: bounded(input.tool, 120) } : {}),
    ...(input.toolRequest ? { toolRequest: normalizeAction(input.toolRequest) } : {}),
    observation: normalizeObservation(input.observation),
    evidence: normalizeList(input.evidence, normalizeEvidence).filter(Boolean),
    requirements: normalizeList(input.requirements, normalizeRequirement).filter(Boolean),
    retryCount: Number.isInteger(input.retryCount) && input.retryCount >= 0 ? input.retryCount : 0,
    loopCount: Number.isInteger(input.loopCount) && input.loopCount >= 0 ? input.loopCount : 0,
    elapsedMs: Number.isFinite(Number(input.elapsedMs)) ? Math.max(0, Number(input.elapsedMs)) : 0,
    recentActions: normalizeList(input.recentActions, (item) => normalizeAction(item)),
    recentFailures: normalizeList(input.recentFailures, (item) => ({
      type: bounded(item?.type ?? item?.failureType ?? 'UNKNOWN', 40).toUpperCase(),
      code: bounded(item?.code ?? item?.errorCode ?? '', 120),
      summary: bounded(item?.summary ?? item?.message ?? '', 500)
    })),
    availableTests: normalizeList(input.availableTests, (item) => ({
      id: bounded(item?.id ?? '', 160),
      command: bounded(item?.command ?? '', 500),
      type: bounded(item?.type ?? 'targeted', 40).toLowerCase(),
      estimatedCost: Math.max(0, Number(item?.estimatedCost ?? 0) || 0),
      estimatedDurationMs: Math.max(0, Number(item?.estimatedDurationMs ?? 0) || 0),
      relatedFiles: normalizeList(item?.relatedFiles, (file) => bounded(file, 240)),
      relatedRequirements: normalizeList(item?.relatedRequirements, (id) => bounded(id, 160))
    })).filter((item) => item.id && item.command),
    executedTests: normalizeList(input.executedTests, (item) => ({
      id: bounded(item?.id ?? '', 160),
      status: bounded(item?.status ?? item?.result ?? 'UNKNOWN', 24).toUpperCase(),
      command: bounded(item?.command ?? '', 500),
      durationMs: Math.max(0, Number(item?.durationMs ?? 0) || 0)
    })).filter((item) => item.id || item.command),
    ...(input.costBudget === undefined ? {} : { costBudget: Math.max(0, Number(input.costBudget) || 0) }),
    ...(input.latencyBudgetMs === undefined ? {} : { latencyBudgetMs: Math.max(0, Number(input.latencyBudgetMs) || 0) }),
    ...(input.currentConfidence === undefined ? {} : { currentConfidence: clamp01(input.currentConfidence) }),
    ...(input.scenario ? { scenario: bounded(input.scenario, 80) } : {}),
    ...(input.skill ? { skill: bounded(input.skill, 120) } : {}),
    ...(input.agent ? { agent: bounded(input.agent, 120) } : {})
  };
  const serialized = JSON.stringify(state);
  if (serialized.length > stateLimit) {
    // Keep the state deterministic and small; the engine should never need the
    // full transcript to choose among finite actions.
    state.evidence = state.evidence.slice(-16);
    state.recentActions = state.recentActions.slice(-16);
    state.recentFailures = state.recentFailures.slice(-16);
    state.availableTests = state.availableTests.slice(0, 16);
    state.executedTests = state.executedTests.slice(-16);
    state.requirements = state.requirements.slice(0, 16);
    state.goal = state.goal.slice(0, 600);
    state.currentStep = state.currentStep.slice(0, 400);
  }
  if (JSON.stringify(state).length > stateLimit) {
    state.evidence = [];
    state.recentActions = [];
    state.recentFailures = [];
    state.availableTests = state.availableTests.slice(0, 4);
    state.executedTests = state.executedTests.slice(-4);
    state.requirements = state.requirements.slice(0, 4).map((item) => ({
      id: item.id.slice(0, 64),
      description: item.description.slice(0, 160),
      status: item.status,
      evidenceIds: item.evidenceIds.slice(0, 4)
    }));
    state.goal = state.goal.slice(0, 320);
    state.currentStep = state.currentStep.slice(0, 240);
    state.action = {
      ...state.action,
      summary: state.action.summary.slice(0, 320)
    };
    state.observation = {
      ...state.observation,
      summary: state.observation.summary.slice(0, 500),
      failureCodes: state.observation.failureCodes.slice(-8),
      checks: state.observation.checks.slice(-8)
    };
  }
  if (JSON.stringify(state).length > stateLimit) {
    // A very small operator limit still retains the control signals while
    // dropping optional context. This keeps the request bounded without
    // serializing a truncated, invalid JSON value.
    const minimal = {
      taskId: state.taskId.slice(0, 64),
      goal: state.goal.slice(0, 80),
      currentStep: state.currentStep.slice(0, 64),
      stepIndex: state.stepIndex,
      action: { kind: state.action.kind.slice(0, 32), summary: state.action.summary.slice(0, 80) },
      observation: {
        status: state.observation.status,
        ...(state.observation.ok === undefined ? {} : { ok: state.observation.ok }),
        summary: state.observation.summary.slice(0, 100),
        failureCodes: state.observation.failureCodes.slice(-2)
      },
      requirements: state.requirements.slice(0, 1).map((item) => ({
        id: item.id.slice(0, 32),
        status: item.status,
        description: item.description.slice(0, 40)
      })),
      retryCount: state.retryCount,
      loopCount: state.loopCount,
      ...(state.currentConfidence === undefined ? {} : { currentConfidence: state.currentConfidence })
    };
    Object.keys(state).forEach((key) => delete state[key]);
    Object.assign(state, minimal);
  }
  return clone(state);
};

export const decisionResult = ({
  decision,
  confidence = 0,
  scores,
  reasonCode,
  source = 'rule',
  latencyMs = 0,
  fallbackUsed = false,
  ...metadata
} = {}) => ({
  decision: bounded(decision ?? 'UNKNOWN', 120),
  confidence: clamp01(confidence),
  ...(scores && typeof scores === 'object' ? {
    scores: Object.fromEntries(Object.entries(scores)
      .filter(([key, value]) => typeof key === 'string' && Number.isFinite(Number(value)))
      .map(([key, value]) => [bounded(key, 120), clamp01(value)]))
  } : {}),
  ...(reasonCode ? { reasonCode: bounded(reasonCode, 160) } : {}),
  source: DECISION_SOURCES.includes(source) ? source : 'rule',
  latencyMs: Math.max(0, Number(latencyMs) || 0),
  fallbackUsed: fallbackUsed === true,
  ...metadata
});

export const optionScores = (choices, selected, confidence = 0) => Object.fromEntries(
  choices.map((choice) => [choice, choice === selected ? clamp01(confidence) : 0])
);
