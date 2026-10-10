import { createHash } from 'node:crypto';

// S2-12: multi-candidate fanout and selection (LLM as a Service).
//
// Fanout is a second layer on top of事前 routing. Callers express "solve this
// problem"; the invocation service decides how many physical model calls to
// make, scores them, and submits exactly one. Everything in this module is
// digest-only: raw prompts, raw model text and reasoning never leave it, so the
// candidate set can be projected into events, the read model and Support Bundle
// without widening the privacy boundary.
const SCHEMA_VERSION = '1.0';
const CANDIDATE_SET_MODE = 'CANDIDATE_SET';
const SELECT_CANDIDATE = 'SELECT_CANDIDATE';
const MAX_CANDIDATES = 16;
const MAX_CONCURRENCY = 8;
const MAX_REASON_CODES = 16;
const BUDGET_KEYS = Object.freeze(['maxCandidates', 'maxConcurrency', 'maxCost', 'maxTokens']);
// Risk-adaptive ceiling. A caller may ask for more candidates, but the policy
// clamps the effective fanout and records why, so cost growth is never implicit.
// Low risk stays single-candidate so an existing configuration never pays for
// fanout. An unclassified task ("no history for this task class") is exactly the
// case the design escalates, so MEDIUM may reach two candidates when the role
// binding explicitly asks for them.
const RISK_FANOUT_CEILING = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 2, CRITICAL: 3 });
const RISKS = Object.freeze(Object.keys(RISK_FANOUT_CEILING));
const CANDIDATE_STATES = Object.freeze(['SELECTED', 'NOT_EXECUTED', 'ELIMINATED']);

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};
const digest = (value) => `sha256:${createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`;
const boundedId = (value, field, max = 240) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`CANDIDATE_SET_INVALID_FIELD:${field}`);
  return value.trim();
};
const optionalId = (value, field, max = 240) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const finiteNumber = (value, min = 0) => (Number.isFinite(value) && value >= min ? Number(value) : undefined);
const boundedReasons = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim().slice(0, 80)).slice(0, MAX_REASON_CODES) : []);

const normalizeCandidateBinding = (input, index) => {
  if (!isRecord(input)) fail(`CANDIDATE_SET_BINDING_INVALID:${index}`);
  const modelId = boundedId(input.modelId ?? input.id, `candidateBindings[${index}].modelId`);
  const bindingId = boundedId(input.bindingId ?? modelId, `candidateBindings[${index}].bindingId`);
  const provider = optionalId(input.provider, `candidateBindings[${index}].provider`, 80);
  const role = optionalId(input.role, `candidateBindings[${index}].role`, 80);
  const expectedCost = finiteNumber(input.expectedCost);
  const expectedLatencyMs = finiteNumber(input.expectedLatencyMs);
  const expectedTokens = finiteNumber(input.expectedTokens);
  return {
    bindingId,
    modelId,
    ...(provider ? { provider } : {}),
    ...(role ? { role } : {}),
    ...(expectedCost !== undefined ? { expectedCost } : {}),
    ...(expectedLatencyMs !== undefined ? { expectedLatencyMs } : {}),
    ...(expectedTokens !== undefined ? { expectedTokens } : {})
  };
};

const normalizeFanoutBudget = (input) => {
  if (input === undefined) return { maxCandidates: MAX_CANDIDATES, maxConcurrency: 1 };
  if (!isRecord(input)) fail('CANDIDATE_SET_BUDGET_INVALID');
  for (const key of Object.keys(input)) {
    if (!BUDGET_KEYS.includes(key)) fail(`CANDIDATE_SET_BUDGET_INVALID:${key}`);
  }
  const budget = {};
  if (input.maxCandidates !== undefined) {
    if (!Number.isInteger(input.maxCandidates) || input.maxCandidates < 1 || input.maxCandidates > MAX_CANDIDATES) fail('CANDIDATE_SET_BUDGET_INVALID:maxCandidates');
    budget.maxCandidates = input.maxCandidates;
  } else budget.maxCandidates = MAX_CANDIDATES;
  if (input.maxConcurrency !== undefined) {
    if (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1 || input.maxConcurrency > MAX_CONCURRENCY) fail('CANDIDATE_SET_BUDGET_INVALID:maxConcurrency');
    budget.maxConcurrency = input.maxConcurrency;
  } else budget.maxConcurrency = 1;
  for (const key of ['maxCost', 'maxTokens']) {
    if (input[key] === undefined) continue;
    const value = finiteNumber(input[key]);
    if (value === undefined) fail(`CANDIDATE_SET_BUDGET_INVALID:${key}`);
    budget[key] = value;
  }
  return budget;
};

/** Normalize the `ModelSelector` `CANDIDATE_SET` contract. `fanout` defaults to
 * 1 so an existing single-candidate configuration keeps its exact behavior.
 */
export const normalizeCandidateSetSpec = (spec, { defaultFanout = 1 } = {}) => {
  if (!isRecord(spec)) fail('CANDIDATE_SET_SPEC_INVALID');
  if (spec.mode !== CANDIDATE_SET_MODE) fail('CANDIDATE_SET_MODE_INVALID');
  const rawBindings = spec.candidateBindings;
  if (!Array.isArray(rawBindings) || rawBindings.length < 1 || rawBindings.length > MAX_CANDIDATES) fail('CANDIDATE_SET_BINDINGS_INVALID');
  const candidateBindings = rawBindings.map(normalizeCandidateBinding);
  if (new Set(candidateBindings.map((binding) => binding.bindingId)).size !== candidateBindings.length) fail('CANDIDATE_SET_BINDING_DUPLICATE');
  const fanout = spec.fanout === undefined ? defaultFanout : spec.fanout;
  if (!Number.isInteger(fanout) || fanout < 1 || fanout > candidateBindings.length) fail('CANDIDATE_SET_FANOUT_INVALID');
  const fanoutBudget = normalizeFanoutBudget(spec.fanoutBudget);
  // A fanout above the budget is not an error: planning truncates it in
  // deterministic order and records why, so a budget can never be exceeded
  // silently and a caller is never forced to guess the effective limit.
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: CANDIDATE_SET_MODE,
    candidateBindings,
    fanout,
    selectionPolicyRef: optionalId(spec.selectionPolicyRef, 'selectionPolicyRef', 120) ?? 'candidate-selection.default',
    fanoutBudget
  };
};

/** Deterministic effective-fanout planning. The requested fanout is clamped by
 * the risk ceiling, the budget and the candidate pool, and every clamp records
 * why it happened.
 */
export const planCandidateFanout = ({ spec, risk = 'LOW', candidatePoolSize } = {}) => {
  const normalized = spec?.mode === CANDIDATE_SET_MODE ? spec : normalizeCandidateSetSpec(spec);
  const riskKey = RISKS.includes(risk) ? risk : 'LOW';
  const poolSize = Number.isInteger(candidatePoolSize) ? candidatePoolSize : normalized.candidateBindings.length;
  if (poolSize < 1 || poolSize > normalized.candidateBindings.length) fail('CANDIDATE_SET_POOL_INVALID');
  const ceiling = RISK_FANOUT_CEILING[riskKey];
  const requested = normalized.fanout;
  const effective = Math.max(1, Math.min(requested, ceiling, normalized.fanoutBudget.maxCandidates, poolSize));
  const reasons = [];
  if (effective < requested) {
    if (ceiling < requested) reasons.push('RISK_POLICY_CEILING');
    if (normalized.fanoutBudget.maxCandidates < requested) reasons.push('FANOUT_BUDGET_LIMIT');
    if (poolSize < requested) reasons.push('CANDIDATE_POOL_LIMIT');
  }
  // Truncation follows the declared binding order so the same spec always keeps
  // the same candidates.
  const selectedBindings = normalized.candidateBindings.slice(0, effective);
  return {
    risk: riskKey,
    requestedFanout: requested,
    fanout: effective,
    candidateBindings: selectedBindings,
    truncated: effective < requested,
    truncationReasons: boundedReasons(reasons),
    droppedBindingIds: normalized.candidateBindings.slice(effective).map((binding) => binding.bindingId),
    degradedToSingleCandidate: effective === 1,
    maxConcurrency: Math.min(normalized.fanoutBudget.maxConcurrency, effective)
  };
};

/** Candidate-level safety gate. A candidate that fails here never enters the
 * scoring set, so a score can never promote a rejected candidate back in.
 */
export class CandidateSafetyFilter {
  filter({ candidates = [], precheck, constraints = {} } = {}) {
    if (!Array.isArray(candidates)) fail('CANDIDATE_SET_POOL_INVALID');
    if (!isRecord(constraints)) fail('CANDIDATE_SET_CONSTRAINTS_INVALID');
    const admitted = [];
    const rejected = [];
    const precheckBlocked = Boolean(precheck) && precheck.status !== 'ALLOWED';
    const allowedModelIds = Array.isArray(constraints.allowedModelIds) ? new Set(constraints.allowedModelIds) : undefined;
    for (const candidate of candidates) {
      if (!isRecord(candidate) || typeof candidate.bindingId !== 'string' || !candidate.bindingId) fail('CANDIDATE_SET_POOL_INVALID');
      const reasons = [];
      if (precheckBlocked) reasons.push('TASK_PRECHECK_BLOCKED');
      if (allowedModelIds && !allowedModelIds.has(candidate.modelId)) reasons.push('CANDIDATE_MODEL_NOT_ALLOWED');
      if (constraints.requireEligible === true && candidate.eligible === false) reasons.push('CANDIDATE_NOT_ELIGIBLE');
      if (candidate.sideEffectCapable === true && constraints.allowSideEffectCandidates !== true) reasons.push('CANDIDATE_SIDE_EFFECT_FORBIDDEN');
      if (constraints.maxCost !== undefined) {
        const cost = finiteNumber(candidate.expectedCost);
        if (cost !== undefined && cost > constraints.maxCost) reasons.push('CANDIDATE_COST_EXCEEDS_BUDGET');
      }
      if (constraints.maxTokens !== undefined) {
        const tokens = finiteNumber(candidate.expectedTokens);
        if (tokens !== undefined && tokens > constraints.maxTokens) reasons.push('CANDIDATE_TOKEN_BUDGET_EXCEEDED');
      }
      const record = {
        bindingId: candidate.bindingId,
        modelId: candidate.modelId,
        ...(candidate.provider ? { provider: candidate.provider } : {}),
        ...(candidate.expectedCost !== undefined ? { expectedCost: candidate.expectedCost } : {}),
        ...(candidate.expectedLatencyMs !== undefined ? { expectedLatencyMs: candidate.expectedLatencyMs } : {}),
        ...(candidate.expectedTokens !== undefined ? { expectedTokens: candidate.expectedTokens } : {})
      };
      if (reasons.length) rejected.push({ ...record, reasons: boundedReasons(reasons) });
      else admitted.push(record);
    }
    return { admitted, rejected, blocked: admitted.length === 0, reason: admitted.length === 0 ? 'CANDIDATE_SET_EMPTY_AFTER_SAFETY' : 'CANDIDATE_SAFETY_FILTERED' };
  }
}

export const createCandidateSafetyFilter = () => new CandidateSafetyFilter();

const mapInvocationFailure = (error) => {
  const code = typeof error?.code === 'string' && error.code.trim()
    ? error.code.trim().slice(0, 96)
    : (typeof error?.message === 'string' && error.message.trim() ? error.message.trim().slice(0, 96) : 'CANDIDATE_INVOCATION_FAILED');
  return code;
};

/** Fan out one logical model call into N physical calls.
 *
 * The gateway owns concurrency, per-candidate timeout, dedupe and unified
 * error mapping. At least one successful candidate makes the logical call
 * successful; only a fully failed fanout reports failure. Raw candidate output
 * is reduced to a digest plus bounded metadata before it leaves this function.
 */
export const runCandidateFanout = async ({
  candidates = [],
  invoke,
  concurrency = 1,
  timeoutMs = 120_000,
  signal,
  onEvent
} = {}) => {
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES) fail('CANDIDATE_SET_POOL_INVALID');
  if (typeof invoke !== 'function') fail('CANDIDATE_FANOUT_INVOKE_REQUIRED');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) fail('CANDIDATE_SET_CONCURRENCY_INVALID');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) fail('CANDIDATE_FANOUT_TIMEOUT_INVALID');

  const deduped = [];
  const duplicates = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.bindingId)) {
      duplicates.push({ bindingId: candidate.bindingId, duplicateOf: candidate.bindingId });
      continue;
    }
    seen.add(candidate.bindingId);
    deduped.push(candidate);
  }

  const results = new Array(deduped.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < deduped.length) {
      const index = cursor;
      cursor += 1;
      const candidate = deduped[index];
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const startedAtMs = Date.now();
      let rejectAborted;
      const aborted = new Promise((resolve, reject) => {
        rejectAborted = () => reject(new Error(signal?.aborted ? 'CANDIDATE_CANCELLED' : 'CANDIDATE_TIMEOUT'));
        controller.signal.addEventListener('abort', rejectAborted, { once: true });
      });
      try {
        if (controller.signal.aborted) throw new Error('CANDIDATE_CANCELLED');
        const output = await Promise.race([invoke({ candidate, index, signal: controller.signal }), aborted]);
        if (controller.signal.aborted) throw new Error('CANDIDATE_CANCELLED');
        const outputDraftDigest = typeof output?.outputDraftDigest === 'string' && output.outputDraftDigest.trim()
          ? output.outputDraftDigest.trim().slice(0, 120)
          : digest(output?.text ?? '');
        results[index] = {
          candidateId: candidate.bindingId,
          bindingId: candidate.bindingId,
          modelId: candidate.modelId,
          status: 'SUCCEEDED',
          outputDraftDigest,
          outputChars: Number.isInteger(output?.outputChars) ? output.outputChars : String(output?.text ?? '').length,
          latencyMs: Date.now() - startedAtMs,
          ...(candidate.provider ? { provider: candidate.provider } : {}),
          ...(candidate.expectedCost !== undefined ? { expectedCost: candidate.expectedCost } : {}),
          ...(candidate.expectedTokens !== undefined ? { expectedTokens: candidate.expectedTokens } : {}),
          ...(Array.isArray(output?.hardFailureCodes) && output.hardFailureCodes.length ? { hardFailureCodes: boundedReasons(output.hardFailureCodes) } : {})
        };
        await onEvent?.({ kind: 'candidate.succeeded', candidateId: candidate.bindingId, outputDraftDigest, latencyMs: results[index].latencyMs });
      } catch (error) {
        const timedOut = controller.signal.aborted && !signal?.aborted;
        results[index] = {
          candidateId: candidate.bindingId,
          bindingId: candidate.bindingId,
          modelId: candidate.modelId,
          status: timedOut ? 'TIMED_OUT' : 'FAILED',
          errorCode: timedOut ? 'CANDIDATE_TIMEOUT' : (signal?.aborted ? 'CANDIDATE_CANCELLED' : mapInvocationFailure(error)),
          latencyMs: Date.now() - startedAtMs,
          ...(candidate.provider ? { provider: candidate.provider } : {}),
          ...(candidate.expectedCost !== undefined ? { expectedCost: candidate.expectedCost } : {}),
          ...(candidate.expectedTokens !== undefined ? { expectedTokens: candidate.expectedTokens } : {})
        };
        await onEvent?.({ kind: 'candidate.failed', candidateId: candidate.bindingId, errorCode: results[index].errorCode });
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', rejectAborted);
        signal?.removeEventListener?.('abort', onAbort);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, deduped.length) }, worker));

  const succeeded = results.filter((result) => result?.status === 'SUCCEEDED');
  const failed = results.filter((result) => result?.status !== 'SUCCEEDED');
  return {
    schemaVersion: SCHEMA_VERSION,
    status: succeeded.length ? 'SUCCEEDED' : 'FAILED',
    reason: succeeded.length ? 'CANDIDATE_FANOUT_PARTIAL_OR_FULL_SUCCESS' : 'CANDIDATE_FANOUT_ALL_FAILED',
    candidateCount: deduped.length,
    successCount: succeeded.length,
    failureCount: failed.length,
    duplicates,
    candidates: results.filter(Boolean),
    successes: succeeded,
    failures: failed
  };
};

const deterministicOrder = (candidates) => candidates.slice().sort((left, right) => {
  const leftCost = Number.isFinite(left.expectedCost) ? left.expectedCost : Number.POSITIVE_INFINITY;
  const rightCost = Number.isFinite(right.expectedCost) ? right.expectedCost : Number.POSITIVE_INFINITY;
  if (leftCost !== rightCost) return leftCost - rightCost;
  const leftLatency = Number.isFinite(left.latencyMs) ? left.latencyMs : Number.POSITIVE_INFINITY;
  const rightLatency = Number.isFinite(right.latencyMs) ? right.latencyMs : Number.POSITIVE_INFINITY;
  if (leftLatency !== rightLatency) return leftLatency - rightLatency;
  return left.candidateId.localeCompare(right.candidateId);
});

/** Two-stage candidate selection: deterministic hard elimination, then ordering.
 *
 * Ordering uses an independent judge when one is available. A judge that shares
 * a binding with a candidate may not score it (no self-evaluation), and a judge
 * verdict can never resurrect a deterministic hard failure. Without an
 * independent judge the policy degrades to deterministic cost/latency ordering
 * and records the degradation reason. Candidate self-reported confidence is
 * never used.
 */
export class CandidateSelectionPolicy {
  async select({ candidates = [], judge, policyRef = 'candidate-selection.default' } = {}) {
    if (!Array.isArray(candidates)) fail('CANDIDATE_SET_POOL_INVALID');
    const eliminated = [];
    const survivors = [];
    for (const candidate of candidates) {
      const reasons = boundedReasons([
        ...(Array.isArray(candidate.hardFailureCodes) ? candidate.hardFailureCodes : []),
        ...(candidate.status !== 'SUCCEEDED' ? ['CANDIDATE_NOT_SUCCEEDED'] : [])
      ]);
      if (reasons.length) eliminated.push({ candidateId: candidate.candidateId ?? candidate.bindingId, reasons });
      else survivors.push(candidate);
    }
    if (!survivors.length) {
      return {
        status: 'NO_ELIGIBLE_CANDIDATE',
        reason: 'CANDIDATE_SELECTION_NO_ELIGIBLE_CANDIDATE',
        policyRef,
        selectedCandidateId: undefined,
        ranking: [],
        eliminated,
        degraded: false,
        degradationReason: undefined
      };
    }
    const baseline = deterministicOrder(survivors).map((candidate) => candidate.candidateId ?? candidate.bindingId);
    if (!judge || typeof judge.score !== 'function') {
      return {
        status: 'SELECTED',
        reason: 'CANDIDATE_SELECTION_DETERMINISTIC_FALLBACK',
        policyRef,
        selectedCandidateId: baseline[0],
        ranking: baseline.map((candidateId, index) => ({ candidateId, source: 'DETERMINISTIC', rank: index + 1 })),
        eliminated,
        degraded: true,
        degradationReason: 'INDEPENDENT_JUDGE_UNAVAILABLE'
      };
    }
    const judgeBindingId = optionalId(judge.bindingId, 'judge.bindingId', 240);
    const sharesBinding = judgeBindingId !== undefined && survivors.some((candidate) => (candidate.bindingId ?? candidate.candidateId) === judgeBindingId);
    if (sharesBinding) {
      return {
        status: 'SELECTED',
        reason: 'CANDIDATE_SELECTION_DETERMINISTIC_FALLBACK',
        policyRef,
        selectedCandidateId: baseline[0],
        ranking: baseline.map((candidateId, index) => ({ candidateId, source: 'DETERMINISTIC', rank: index + 1 })),
        eliminated,
        degraded: true,
        degradationReason: 'JUDGE_SHARES_CANDIDATE_BINDING'
      };
    }
    const allowed = new Set(survivors.map((candidate) => candidate.candidateId ?? candidate.bindingId));
    let scored;
    try {
      scored = await judge.score({ candidates: survivors.map((candidate) => clone(candidate)), policyRef });
    } catch (error) {
      return {
        status: 'SELECTED',
        reason: 'CANDIDATE_SELECTION_DETERMINISTIC_FALLBACK',
        policyRef,
        selectedCandidateId: baseline[0],
        ranking: baseline.map((candidateId, index) => ({ candidateId, source: 'DETERMINISTIC', rank: index + 1 })),
        eliminated,
        degraded: true,
        degradationReason: `JUDGE_FAILED:${mapInvocationFailure(error)}`
      };
    }
    const entries = Array.isArray(scored) ? scored : [];
    if (entries.some((entry) => !isRecord(entry) || !allowed.has(entry.candidateId))) {
      return {
        status: 'SELECTED',
        reason: 'CANDIDATE_SELECTION_DETERMINISTIC_FALLBACK',
        policyRef,
        selectedCandidateId: baseline[0],
        ranking: baseline.map((candidateId, index) => ({ candidateId, source: 'DETERMINISTIC', rank: index + 1 })),
        eliminated,
        degraded: true,
        degradationReason: 'JUDGE_RETURNED_UNKNOWN_CANDIDATE'
      };
    }
    const byId = new Map(entries.map((entry) => [entry.candidateId, entry]));
    const ranked = survivors.slice().sort((left, right) => {
      const leftId = left.candidateId ?? left.bindingId;
      const rightId = right.candidateId ?? right.bindingId;
      const leftScore = Number.isFinite(byId.get(leftId)?.score) ? byId.get(leftId).score : Number.NEGATIVE_INFINITY;
      const rightScore = Number.isFinite(byId.get(rightId)?.score) ? byId.get(rightId).score : Number.NEGATIVE_INFINITY;
      if (leftScore !== rightScore) return rightScore - leftScore;
      return baseline.indexOf(leftId) - baseline.indexOf(rightId);
    });
    const ranking = ranked.map((candidate, index) => {
      const candidateId = candidate.candidateId ?? candidate.bindingId;
      const entry = byId.get(candidateId) ?? {};
      const components = isRecord(entry.components) ? clone(entry.components) : undefined;
      return {
        candidateId,
        source: 'JUDGE',
        rank: index + 1,
        ...(Number.isFinite(entry.score) ? { score: Math.min(1, Math.max(0, entry.score)) } : {}),
        ...(components ? { components } : {}),
        ...(entry.reasonCode ? { reasonCode: String(entry.reasonCode).slice(0, 80) } : {})
      };
    });
    const unscored = ranking.filter((entry) => entry.source === 'JUDGE' && entry.score === undefined).map((entry) => entry.candidateId);
    return {
      status: 'SELECTED',
      reason: unscored.length ? 'CANDIDATE_SELECTION_JUDGE_PARTIAL' : 'CANDIDATE_SELECTION_JUDGE_RANKED',
      policyRef,
      selectedCandidateId: ranking[0].candidateId,
      judgeBindingId,
      ranking,
      eliminated,
      degraded: false,
      degradationReason: undefined
    };
  }
}

export const createCandidateSelectionPolicy = () => new CandidateSelectionPolicy();

/** Map every candidate to a Decision Trace option for a `SELECT_CANDIDATE`
 * decision. Options carry digests and bounded scores only; the caller links the
 * selected option to the real outcome and marks the rest as not executed.
 */
export const buildCandidateSelectionDecision = ({
  candidates = [],
  selection,
  selectionPolicyRef,
  fanout,
  risk,
  truncation = {},
  evidenceRefs = [],
  evidenceByCandidate = {}
} = {}) => {
  if (!isRecord(selection)) fail('CANDIDATE_SELECTION_RESULT_REQUIRED');
  // Options reference decision-level evidence by id, so only ids that are
  // actually committed may appear on an option.
  const decisionEvidence = Array.isArray(evidenceRefs)
    ? evidenceRefs.filter((ref) => isRecord(ref) && typeof ref.evidenceId === 'string' && ref.evidenceId.trim()).slice(0, 64)
    : [];
  const evidenceIds = new Set(decisionEvidence.map((ref) => ref.evidenceId));
  const rankingById = new Map((selection.ranking ?? []).map((entry) => [entry.candidateId, entry]));
  const eliminatedById = new Map((selection.eliminated ?? []).map((entry) => [entry.candidateId, entry.reasons]));
  const options = candidates.map((candidate) => {
    const candidateId = candidate.candidateId ?? candidate.bindingId;
    const ranking = rankingById.get(candidateId);
    const reasons = eliminatedById.get(candidateId);
    const optionEvidence = (Array.isArray(evidenceByCandidate?.[candidateId]) ? evidenceByCandidate[candidateId] : [])
      .filter((ref) => typeof ref === 'string' && evidenceIds.has(ref))
      .slice(0, 16);
    return {
      optionId: candidateId,
      actionKind: 'model.candidate',
      summary: `candidate:${candidate.bindingId ?? candidateId}`,
      ...(optionEvidence.length ? { evidenceRefs: optionEvidence } : {}),
      ...(candidate.outputDraftDigest ? { outputDraftDigest: candidate.outputDraftDigest } : {}),
      ...(Number.isFinite(ranking?.score) ? { expectedQuality: Math.min(1, Math.max(0, ranking.score)) } : {}),
      ...(Number.isFinite(candidate.expectedCost) ? { expectedCost: candidate.expectedCost } : {}),
      ...(Number.isFinite(candidate.latencyMs) ? { expectedLatencyMs: candidate.latencyMs } : {}),
      ...(reasons?.length ? { rejectionReasonCodes: boundedReasons(reasons) } : {})
    };
  });
  const selectedCandidateId = selection.selectedCandidateId;
  const optionStates = Object.fromEntries(options.map((option) => [
    option.optionId,
    option.optionId === selectedCandidateId
      ? 'SELECTED'
      : (eliminatedById.has(option.optionId) ? 'ELIMINATED' : 'NOT_EXECUTED')
  ]));
  for (const state of Object.values(optionStates)) {
    if (!CANDIDATE_STATES.includes(state)) fail('CANDIDATE_SET_OPTION_STATE_INVALID');
  }
  return {
    decisionType: SELECT_CANDIDATE,
    decisionSnapshot: {
      decisionType: SELECT_CANDIDATE,
      ...(decisionEvidence.length ? { evidenceRefs: decisionEvidence.map((ref) => clone(ref)) } : {}),
      options,
      ...(selectedCandidateId ? { selectedOptionId: selectedCandidateId } : {}),
      selectionCriteria: ['deterministic_hard_elimination', 'independent_judge_ranking'],
      reasonCodes: boundedReasons([
        ...(selection.reason ? [selection.reason] : []),
        ...(selection.degraded && selection.degradationReason ? ['CANDIDATE_SELECTION_DEGRADED'] : []),
        ...(truncation.truncated ? ['CANDIDATE_SET_TRUNCATED'] : [])
      ]),
      ...(selectionPolicyRef ? { selectionPolicyRef: String(selectionPolicyRef).slice(0, 120) } : {})
    },
    fanout: {
      requestedFanout: truncation.requestedFanout ?? fanout,
      effectiveFanout: fanout,
      ...(risk ? { risk } : {}),
      truncated: truncation.truncated === true,
      truncationReasons: boundedReasons(truncation.truncationReasons),
      droppedBindingIds: Array.isArray(truncation.droppedBindingIds) ? truncation.droppedBindingIds.slice(0, MAX_CANDIDATES) : []
    },
    selection: {
      status: selection.status,
      reason: selection.reason,
      degraded: selection.degraded === true,
      ...(selection.degradationReason ? { degradationReason: selection.degradationReason } : {}),
      ...(selection.judgeBindingId ? { judgeBindingId: selection.judgeBindingId } : {}),
      ranking: (selection.ranking ?? []).map((entry) => clone(entry)),
      eliminated: (selection.eliminated ?? []).map((entry) => clone(entry))
    },
    optionStates
  };
};

export const CANDIDATE_FANOUT_CONSTANTS = Object.freeze({
  CANDIDATE_SET_MODE,
  SELECT_CANDIDATE,
  MAX_CANDIDATES,
  MAX_CONCURRENCY,
  RISK_FANOUT_CEILING,
  CANDIDATE_STATES
});
