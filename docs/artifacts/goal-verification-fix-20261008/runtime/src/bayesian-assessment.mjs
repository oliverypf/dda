import { createHash } from 'node:crypto';

const POSTERIOR_VERSION = 'beta-bernoulli-v1';
const METRICS = Object.freeze(['objectiveSuccess', 'verifierPass', 'userSatisfaction']);
const VALID_OUTCOMES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED']);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const clone = (value) => structuredClone(value);
const canonical = (value) => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Lanczos plus a continued fraction is enough for bounded Beta posteriors and
// avoids a dependency or a provider-specific statistics implementation.
const logGamma = (value) => {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.984369578019572e-6, 1.5056327351493116e-7
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.9999999999998099;
  const shifted = value - 1;
  for (let index = 0; index < coefficients.length; index += 1) x += coefficients[index] / (shifted + index + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
};
const betaContinuedFraction = (a, b, x) => {
  const maxIterations = 200;
  const epsilon = 3e-12;
  const tiny = 1e-30;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let index = 1; index <= maxIterations; index += 1) {
    const m = index;
    let numerator = (m * (b - m) * x) / ((qam + 2 * m) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    numerator = -((a + m) * (qab + m) * x) / ((a + 2 * m) * (qap + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
};
const regularizedBeta = (x, a, b) => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - logGamma(a) - logGamma(b) + logGamma(a + b));
  if (x < (a + 1) / (a + b + 2)) return factor * betaContinuedFraction(a, b, x) / a;
  return 1 - factor * betaContinuedFraction(b, a, 1 - x) / b;
};
const betaQuantile = (probability, alpha, beta) => {
  let low = 0;
  let high = 1;
  for (let index = 0; index < 64; index += 1) {
    const middle = (low + high) / 2;
    if (regularizedBeta(middle, alpha, beta) < probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
};

const normalizePrior = ({ alpha = 1, beta = 1 } = {}) => {
  if (!Number.isFinite(alpha) || !Number.isFinite(beta) || alpha <= 0 || beta <= 0 || alpha > 1e6 || beta > 1e6) throw new Error('BAYESIAN_PRIOR_INVALID');
  return { alpha, beta };
};
const posterior = ({ successCount, failureCount, prior }) => {
  const alpha = prior.alpha + successCount;
  const beta = prior.beta + failureCount;
  return {
    alpha,
    beta,
    mean: alpha / (alpha + beta),
    lowerCredibleBound: betaQuantile(0.05, alpha, beta),
    upperCredibleBound: betaQuantile(0.95, alpha, beta),
    effectiveSampleCount: successCount + failureCount,
    priorOnly: successCount + failureCount === 0,
    posteriorVersion: POSTERIOR_VERSION
  };
};

const groupKeyFor = (sample) => {
  const scenarioKey = sample.scenarioKey ?? sample.scenario?.scenarioKey;
  const candidateKey = sample.candidateKey ?? sample.modelIdentity?.candidateKey;
  const policyVersion = sample.policyVersion ?? sample.modelIdentity?.policyVersion ?? 'runtime-safety-1';
  const modelRegistryDigest = sample.modelRegistryDigest ?? sample.modelIdentity?.modelRegistryDigest;
  if (typeof scenarioKey !== 'string' || !DIGEST.test(scenarioKey) || typeof candidateKey !== 'string' || !candidateKey.trim() || typeof modelRegistryDigest !== 'string' || !DIGEST.test(modelRegistryDigest)) throw new Error('BAYESIAN_COHORT_KEY_INVALID');
  return { scenarioKey, candidateKey, policyVersion: String(policyVersion).slice(0, 120), modelRegistryDigest };
};
const sampleKey = (sample, index) => String(sample.independenceKey ?? sample.outcomeId ?? sample.feedbackId ?? sample.runId ?? `sample-${index}`);
const metricObservation = (sample, metric) => {
  const dimensions = sample.dimensions ?? sample;
  if (!dimensions) return undefined;
  if (dimensions.safetyIncident === true && metric !== 'userSatisfaction') return false;
  if (metric === 'userSatisfaction') {
    if (Number.isFinite(dimensions.userSatisfaction)) return dimensions.userSatisfaction >= 0.75;
    if (Number.isInteger(dimensions.rating)) return dimensions.rating >= 4;
    if (typeof dimensions.usable === 'boolean') return dimensions.usable;
    return undefined;
  }
  if (typeof dimensions[metric] !== 'boolean') return undefined;
  return dimensions[metric];
};

export const assessBayesian = ({ samples = [], prior = { alpha: 1, beta: 1 }, now = Date.now } = {}) => {
  if (!Array.isArray(samples) || samples.length > 100_000) throw new Error('BAYESIAN_SAMPLE_LIMIT');
  const normalizedPrior = normalizePrior(prior);
  const groups = new Map();
  const excludedOutcomeCounts = {};
  const seen = new Set();
  for (const [index, sample] of samples.entries()) {
    if (!sample || typeof sample !== 'object') throw new Error('BAYESIAN_SAMPLE_INVALID');
    if (sample.outcomeStatus !== undefined) {
      const outcomeStatus = String(sample.outcomeStatus).toUpperCase();
      if (!VALID_OUTCOMES.has(outcomeStatus)) {
        excludedOutcomeCounts[outcomeStatus] = (excludedOutcomeCounts[outcomeStatus] ?? 0) + 1;
        continue;
      }
    }
    const cohort = groupKeyFor(sample);
    const key = digest(cohort) + ':' + sampleKey(sample, index);
    if (seen.has(key)) continue;
    seen.add(key);
    const groupKey = digest(cohort);
    if (!groups.has(groupKey)) groups.set(groupKey, { ...cohort, groupKey, samples: [], evidenceRefs: new Set(), safetyIncidentCount: 0 });
    const group = groups.get(groupKey);
    group.samples.push(sample);
    if (sample.safetyIncident === true || sample.dimensions?.safetyIncident === true) group.safetyIncidentCount += 1;
    for (const ref of sample.evidenceRefs ?? []) if (typeof ref === 'string') group.evidenceRefs.add(ref);
  }
  const assessments = [];
  for (const group of groups.values()) {
    const metrics = {};
    for (const metric of METRICS) {
      let successCount = 0;
      let failureCount = 0;
      for (const sample of group.samples) {
        const observation = metricObservation(sample, metric);
        if (observation === true) successCount += 1;
        else if (observation === false) failureCount += 1;
      }
      metrics[metric] = {
        ...posterior({ successCount, failureCount, prior: normalizedPrior }),
        evidenceRefs: [...group.evidenceRefs].sort().slice(0, 64),
        uncertaintyCodes: [
          ...(successCount + failureCount === 0 ? ['PRIOR_ONLY'] : []),
          ...(group.safetyIncidentCount > 0 ? ['SAFETY_INCIDENT_PRESENT'] : [])
        ]
      };
    }
    assessments.push({
      schemaVersion: '1.0',
      posteriorVersion: POSTERIOR_VERSION,
      ...cohortWithoutSamples(group),
      metrics,
      sampleCount: group.samples.length,
      independentSampleCount: group.samples.length,
      safetyIncidentCount: group.safetyIncidentCount,
      evidenceWindowDigest: digest(group.samples.map((sample) => sampleKey(sample, 0)).sort()),
      computedAtMs: Number.isFinite(now()) ? Math.max(0, Math.trunc(now())) : 0
    });
  }
  return { schemaVersion: '1.0', posteriorVersion: POSTERIOR_VERSION, datasetDigest: digest(samples.map((sample, index) => sampleKey(sample, index)).sort()), excludedOutcomeCounts, assessments: assessments.sort((left, right) => left.groupKey.localeCompare(right.groupKey)) };
};

const cohortWithoutSamples = (group) => {
  const { samples: _samples, evidenceRefs: _evidenceRefs, safetyIncidentCount: _safetyIncidentCount, ...cohort } = group;
  return cohort;
};

export const rankSafeCandidates = ({ candidates = [], assessments = [], satisfactionWeight = 0.2, uncertaintyPenalty = 0.1, costPenalty = 0, latencyPenalty = 0 } = {}) => {
  if (!Array.isArray(candidates)) throw new Error('BAYESIAN_CANDIDATES_INVALID');
  const byGroup = new Map(assessments.map((assessment) => [assessment.groupKey, assessment]));
  const rejected = candidates.filter((candidate) => candidate?.safetyAllowed !== true).map((candidate) => clone(candidate));
  const eligible = candidates.filter((candidate) => candidate?.safetyAllowed === true).map((candidate) => {
    const cohort = groupKeyFor(candidate);
    return { candidate, cohort, assessment: byGroup.get(digest(cohort)) };
  });
  const blockedByAssessment = eligible.filter(({ assessment }) => assessment?.safetyIncidentCount > 0)
    .map(({ candidate }) => ({ ...clone(candidate), rejectionReason: 'SAFETY_INCIDENT_PRESENT' }));
  rejected.push(...blockedByAssessment);
  const ranked = eligible.filter(({ assessment }) => assessment?.safetyIncidentCount !== undefined ? assessment.safetyIncidentCount === 0 : true).map(({ candidate, cohort, assessment }) => {
    const objective = assessment?.metrics?.objectiveSuccess ?? posterior({ successCount: 0, failureCount: 0, prior: { alpha: 1, beta: 1 } });
    const satisfaction = assessment?.metrics?.userSatisfaction ?? posterior({ successCount: 0, failureCount: 0, prior: { alpha: 1, beta: 1 } });
    const score = objective.lowerCredibleBound + satisfactionWeight * satisfaction.mean
      - uncertaintyPenalty * (1 - objective.effectiveSampleCount / (objective.effectiveSampleCount + 4))
      - costPenalty * Number(candidate.cost ?? 0)
      - latencyPenalty * Number(candidate.latency ?? 0);
    return { ...clone(candidate), groupKey: digest(cohort), score, priorOnly: objective.priorOnly, assessment: assessment ? clone(assessment) : undefined };
  }).sort((left, right) => right.score - left.score || String(left.candidateKey ?? '').localeCompare(String(right.candidateKey ?? '')));
  return { ranked, rejected, safetyFilterApplied: true, canChangePermissions: false, canCreateApproval: false, canCreateLease: false };
};

export { METRICS, POSTERIOR_VERSION, digest as bayesianDigest };
