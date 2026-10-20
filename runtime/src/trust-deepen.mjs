// Trust deepen knife: α/β behavior posterior + Path-weighted blame + soft Trust(X) feed.
// Soft tighten only; never exempts hardDecision / lease; never demotes decision.
// Freeze: freeze-trust-deepen-r1.md
// Version lock: behavior-beta-v1 (do NOT change bayesian-assessment model/scenario API).

import { createHash } from 'node:crypto';

export const BEHAVIOR_POSTERIOR_VERSION = 'behavior-beta-v1';
export const CAUSAL_EQUAL_SHARE = 'CAUSAL_EQUAL_SHARE';
export const CAUSAL_PATH_WEIGHTED = 'CAUSAL_PATH_WEIGHTED';

/** Asymmetric update weights (freeze §1.1). Injectable via opts.asymmetric. */
export const BEHAVIOR_ASYMMETRIC = Object.freeze({
  wSuccess: 0.25, // slow build
  wFailure: 1.0   // fast drop
});

export const DEFAULT_BEHAVIOR_PRIOR = Object.freeze({ alpha: 1, beta: 1 });

/** evidenceCount threshold before Trust(X) injection (freeze §1.3). */
export const TRUST_DEEPEN_MIN_EVIDENCE = 3;

const SAFE_STATUSES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNKNOWN']);

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';

const digest = (value) =>
  `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;

export function isTrustDeepenEnabled(env = process.env) {
  return env?.DDA_TRUST_DEEPEN !== '0';
}

/**
 * Build behavior key: behavior:{entityType}:{entityId}[:{capabilityId}]
 */
export function behaviorPosteriorKey({ entityType = 'executor', entityId, capabilityId } = {}) {
  const et = typeof entityType === 'string' && entityType.trim() ? entityType.trim() : 'executor';
  const id = typeof entityId === 'string' && entityId.trim() ? entityId.trim() : 'executor';
  const cap = typeof capabilityId === 'string' && capabilityId.trim() && capabilityId !== '*'
    ? capabilityId.trim()
    : null;
  return cap ? `behavior:${et}:${id}:${cap}` : `behavior:${et}:${id}`;
}

/**
 * In-memory store for posteriors + source-id dedupe.
 * Persistable later via profile/harness-event; this knife keeps a plain map.
 */
export function createBehaviorPosteriorStore() {
  return {
    posteriors: new Map(),
    seenSources: new Set()
  };
}

function normalizePrior(prior) {
  const alpha = typeof prior?.alpha === 'number' && Number.isFinite(prior.alpha) && prior.alpha > 0
    ? prior.alpha
    : DEFAULT_BEHAVIOR_PRIOR.alpha;
  const beta = typeof prior?.beta === 'number' && Number.isFinite(prior.beta) && prior.beta > 0
    ? prior.beta
    : DEFAULT_BEHAVIOR_PRIOR.beta;
  return { alpha, beta };
}

function snapshotPosterior(entry) {
  if (!entry) return null;
  const alpha = entry.alpha;
  const beta = entry.beta;
  return {
    alpha,
    beta,
    mean: alpha / (alpha + beta),
    evidenceCount: entry.evidenceCount,
    version: BEHAVIOR_POSTERIOR_VERSION,
    key: entry.key
  };
}

/**
 * Resolve stored posterior for key, or null.
 */
export function resolveBehaviorPosterior(key, store) {
  if (typeof key !== 'string' || !key || !store?.posteriors) return null;
  return snapshotPosterior(store.posteriors.get(key));
}

/**
 * Update α/β behavior posterior (asymmetric: slow-build / fast-drop).
 * Idempotent on same sourceId / incidentId / outcomeId (digest dedupe).
 *
 * evidenceCount scheme (locked): integer count of accepted observations
 * after dedupe (not weighted sum). Threshold TRUST_DEEPEN_MIN_EVIDENCE=3.
 *
 * @returns {{ alpha, beta, mean, evidenceCount, version, key, skipped? }}
 */
export function updateBehaviorPosterior({
  key,
  success,
  weight,
  prior,
  asymmetric,
  sourceId,
  incidentId,
  outcomeId,
  store
} = {}) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('BEHAVIOR_KEY_REQUIRED');
  }
  const k = key.trim();
  const map = store?.posteriors ?? null;
  const seen = store?.seenSources ?? null;

  const existing = map?.get(k);
  const base = existing
    ? { alpha: existing.alpha, beta: existing.beta, evidenceCount: existing.evidenceCount }
    : { ...normalizePrior(prior), evidenceCount: 0 };

  const dedupeToken = sourceId ?? incidentId ?? outcomeId;
  if (dedupeToken != null && String(dedupeToken).trim() !== '' && seen) {
    const dedupeId = digest({
      key: k,
      source: String(dedupeToken).trim()
    });
    if (seen.has(dedupeId)) {
      return { ...snapshotPosterior({ ...base, key: k }), skipped: true };
    }
    seen.add(dedupeId);
  }

  const asym = {
    wSuccess: typeof asymmetric?.wSuccess === 'number' && Number.isFinite(asymmetric.wSuccess)
      ? asymmetric.wSuccess
      : BEHAVIOR_ASYMMETRIC.wSuccess,
    wFailure: typeof asymmetric?.wFailure === 'number' && Number.isFinite(asymmetric.wFailure)
      ? asymmetric.wFailure
      : BEHAVIOR_ASYMMETRIC.wFailure
  };

  const w = typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 1;
  let alpha = base.alpha;
  let beta = base.beta;
  if (success === true) {
    alpha += asym.wSuccess * w;
  } else {
    beta += asym.wFailure * w;
  }
  const evidenceCount = base.evidenceCount + 1;
  const entry = { key: k, alpha, beta, evidenceCount };
  if (map) map.set(k, entry);
  return snapshotPosterior(entry);
}

/**
 * Normalize path nodes from pathNodes array or pathAnalysis.
 * Nodes = path[].from/to deduped ordered, or effective; truncated ≤16.
 */
export function normalizePathNodes({ pathNodes, pathAnalysis } = {}) {
  if (Array.isArray(pathNodes) && pathNodes.length > 0) {
    const out = [];
    for (const n of pathNodes) {
      const s = typeof n === 'string' ? n.trim() : '';
      if (s && !out.includes(s)) out.push(s);
    }
    return out.slice(0, 16);
  }
  if (!pathAnalysis || typeof pathAnalysis !== 'object') return [];

  const out = [];
  const declared = Array.isArray(pathAnalysis.declared) ? pathAnalysis.declared : [];
  for (const d of declared) {
    const s = typeof d === 'string' ? d.trim() : '';
    if (s && !out.includes(s)) out.push(s);
  }
  const path = Array.isArray(pathAnalysis.path) ? pathAnalysis.path : [];
  for (const edge of path) {
    for (const side of [edge?.from, edge?.to]) {
      const s = typeof side === 'string' ? side.trim() : '';
      if (s && !out.includes(s)) out.push(s);
    }
  }
  if (out.length === 0 && Array.isArray(pathAnalysis.effective)) {
    for (const e of pathAnalysis.effective) {
      const s = typeof e === 'string' ? e.trim() : '';
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out.slice(0, 16);
}

function extractHighRiskSinks({ highRiskSinks, pathAnalysis } = {}) {
  if (Array.isArray(highRiskSinks) && highRiskSinks.length) {
    return highRiskSinks.map((s) => String(s)).filter(Boolean);
  }
  if (Array.isArray(pathAnalysis?.highRiskSinks)) {
    return pathAnalysis.highRiskSinks.map((s) => String(s)).filter(Boolean);
  }
  return [];
}

/**
 * Sink-heavier blame weights: last node + highRiskSink hits get 2×, then normalize.
 * Credit: equal weights (locked this knife).
 */
export function pathNodeWeights({ nodes, highRiskSinks = [], outcome = 'FAILED' } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  const status = String(outcome).toUpperCase();
  const success = status === 'SUCCEEDED';
  if (success) {
    const w = 1 / nodes.length;
    return nodes.map(() => w);
  }
  const sinkSet = new Set(highRiskSinks);
  const last = nodes[nodes.length - 1];
  const raw = nodes.map((n) => {
    let w = 1;
    if (n === last) w *= 2;
    if (sinkSet.has(n)) w *= 2;
    return w;
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

function decisionMatchKeys(decision) {
  const keys = [];
  for (const field of ['toolName', 'capabilityId', 'role', 'name', 'selectedOptionId']) {
    const v = decision?.[field];
    if (typeof v === 'string' && v.trim()) keys.push(v.trim());
  }
  // Nested claim / evidence hints
  const claim = decision?.claim;
  if (claim && typeof claim === 'object') {
    for (const field of ['toolName', 'capabilityId', 'tool', 'name']) {
      const v = claim[field];
      if (typeof v === 'string' && v.trim()) keys.push(v.trim());
    }
  }
  return keys;
}

function decisionMatchesNode(decision, node) {
  const keys = decisionMatchKeys(decision);
  return keys.some((k) => k === node || k.endsWith(`.${node}`) || node.endsWith(`.${k}`) || node.includes(k) || k.includes(node));
}

/**
 * Allocate credit/blame across COMMITTED decisions.
 * - No pathNodes / empty → CAUSAL_EQUAL_SHARE (regression lock)
 * - With path → CAUSAL_PATH_WEIGHTED, sink-heavier blame; credit equal
 * - Unmapped decisions share remainder equally (total remains 1)
 *
 * @returns {allocations[]}
 */
export function allocatePathWeighted({
  decisions = [],
  outcome = {},
  pathNodes,
  pathAnalysis,
  highRiskSinks
} = {}) {
  if (!Array.isArray(decisions) || !decisions.length) return [];
  const usable = decisions.filter(
    (d) => d?.status === 'COMMITTED' && typeof d.decisionId === 'string'
  );
  if (!usable.length) return [];

  const status = String(outcome.status ?? 'UNKNOWN').toUpperCase();
  if (!SAFE_STATUSES.has(status)) throw new Error('CREDIT_OUTCOME_INVALID');
  const success = status === 'SUCCEEDED';
  const evidenceRefs = Array.isArray(outcome.executionEventIds)
    ? outcome.executionEventIds.slice(0, 16)
    : [];

  const nodes = normalizePathNodes({ pathNodes, pathAnalysis });
  const sinks = extractHighRiskSinks({ highRiskSinks, pathAnalysis });

  // No path → equal share (freeze §1.2 #1)
  if (nodes.length === 0) {
    const weight = 1 / usable.length;
    return usable.map((decision) => ({
      decisionId: decision.decisionId,
      runId: decision.runId,
      role: decision.role,
      outcomeId: outcome.outcomeId,
      credit: success ? weight : 0,
      blame: success ? 0 : weight,
      evidenceRefs,
      allocationMethod: CAUSAL_EQUAL_SHARE
    }));
  }

  const nodeWeights = pathNodeWeights({ nodes, highRiskSinks: sinks, outcome: status });

  // Map nodes → matching decisions
  const nodeToDecisions = nodes.map((node) =>
    usable.filter((d) => decisionMatchesNode(d, node))
  );
  const mappedDecisionIds = new Set();
  for (const matched of nodeToDecisions) {
    for (const d of matched) mappedDecisionIds.add(d.decisionId);
  }
  const unmapped = usable.filter((d) => !mappedDecisionIds.has(d.decisionId));

  // Accumulate weight per decision from matched nodes
  const weightById = new Map(usable.map((d) => [d.decisionId, 0]));
  let mappedWeightSum = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const matched = nodeToDecisions[i];
    const nw = nodeWeights[i];
    if (!matched.length) {
      // Node with no decision match → remainder pool
      continue;
    }
    const share = nw / matched.length;
    for (const d of matched) {
      weightById.set(d.decisionId, weightById.get(d.decisionId) + share);
      mappedWeightSum += share;
    }
  }

  // Unmapped + unmatched-node remainder share equally
  const remainder = Math.max(0, 1 - mappedWeightSum);
  const remainderTargets = unmapped.length > 0
    ? unmapped
    : (mappedWeightSum < 1 - 1e-12 ? usable : []);
  if (remainder > 0 && remainderTargets.length > 0) {
    const share = remainder / remainderTargets.length;
    for (const d of remainderTargets) {
      weightById.set(d.decisionId, weightById.get(d.decisionId) + share);
    }
  } else if (remainder > 1e-12 && usable.length > 0) {
    // Fallback: dump remainder on last usable
    const last = usable[usable.length - 1];
    weightById.set(last.decisionId, weightById.get(last.decisionId) + remainder);
  }

  // Renormalize to sum=1 (floating point guard)
  let total = 0;
  for (const w of weightById.values()) total += w;
  if (total > 0 && Math.abs(total - 1) > 1e-9) {
    for (const [id, w] of weightById) weightById.set(id, w / total);
  }

  return usable.map((decision) => {
    const w = weightById.get(decision.decisionId) ?? 0;
    return {
      decisionId: decision.decisionId,
      runId: decision.runId,
      role: decision.role,
      outcomeId: outcome.outcomeId,
      credit: success ? w : 0,
      blame: success ? 0 : w,
      evidenceRefs,
      allocationMethod: CAUSAL_PATH_WEIGHTED
    };
  });
}

/**
 * Soft-feed behavior posterior into Trust(X). Elevate-only on R/E.
 * Never lowers R, never loosens decision, never changes A/S/C/O identity.
 * Reason codes stay TRUST_X_*; telemetry via trustDeepen: { mean, alpha, beta }.
 *
 * @returns {TrustX'}
 */
export function applyBehaviorPosteriorToTrust({ trust, posterior } = {}) {
  if (!trust || typeof trust !== 'object') return trust;
  if (!posterior || typeof posterior !== 'object') return trust;

  const evidenceCount = Number.isFinite(posterior.evidenceCount)
    ? posterior.evidenceCount
    : 0;
  if (evidenceCount < TRUST_DEEPEN_MIN_EVIDENCE) return trust;

  const mean = typeof posterior.mean === 'number' && Number.isFinite(posterior.mean)
    ? posterior.mean
    : null;
  if (mean == null) return trust;

  let R = typeof trust.R === 'number' && Number.isFinite(trust.R) ? trust.R : 0;
  let E = typeof trust.E === 'number' && Number.isFinite(trust.E) ? trust.E : 0;
  const prevR = R;

  if (mean < 0.2) {
    R = Math.max(R, 0.8);
  } else if (mean < 0.4) {
    R = Math.max(R, 0.4);
  } else if (mean >= 0.7) {
    E = Math.max(E, 0.5);
    // must NOT lower R
    R = prevR;
  }

  return {
    ...trust,
    R,
    E,
    // A/S/C/O / key / identity fields preserved via spread
    trustDeepen: {
      mean,
      alpha: posterior.alpha,
      beta: posterior.beta,
      evidenceCount
    }
  };
}

export { digest as trustDeepenDigest, canonical as trustDeepenCanonical };
