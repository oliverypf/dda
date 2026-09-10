import { createHash, randomUUID } from 'node:crypto';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const SCHEMA_VERSION = '1.0';
const MAX_REPORTS = 2048;
const MAX_OUTCOMES = 8192;
const SENSITIVE_TEXT = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|bearer|private\s+key)\s*[:=]/i;
const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const bounded = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').trim().slice(0, max);
const statusOf = (value) => ['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(String(value).toUpperCase()) ? String(value).toUpperCase() : 'UNKNOWN';
const DATASET_KINDS = new Set(['DEV', 'REGRESSION', 'HOLDOUT', 'SAFETY_REDTEAM', 'LIVE_SHADOW', 'CANARY']);
const normalizeDatasetKind = (value) => {
  const kind = typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : 'DEV';
  if (!DATASET_KINDS.has(kind)) throw new Error('EVOLUTION_DATASET_KIND_INVALID');
  return kind;
};
const normalizeDatasetVersion = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : '1.0';

const outcomeMetrics = (items = []) => {
  const metrics = { sampleCount: 0, successCount: 0, partialCount: 0, failureCount: 0, unknownCount: 0, safetyIncidentCount: 0, costMean: null, latencyMeanMs: null };
  let costSum = 0; let costCount = 0; let latencySum = 0; let latencyCount = 0;
  for (const item of items) {
    metrics.sampleCount += 1;
    const status = statusOf(item?.status ?? item?.outcome);
    if (status === 'SUCCEEDED') metrics.successCount += 1;
    else if (status === 'PARTIAL') metrics.partialCount += 1;
    else if (status === 'FAILED' || status === 'CANCELLED') metrics.failureCount += 1;
    else metrics.unknownCount += 1;
    if (item?.safetyIncident === true || item?.unauthorizedSideEffect === true || item?.secretLeak === true) metrics.safetyIncidentCount += 1;
    if (Number.isFinite(item?.cost)) { costSum += item.cost; costCount += 1; }
    if (Number.isFinite(item?.latencyMs)) { latencySum += item.latencyMs; latencyCount += 1; }
  }
  metrics.successRate = metrics.sampleCount ? metrics.successCount / metrics.sampleCount : 0;
  metrics.failureRate = metrics.sampleCount ? metrics.failureCount / metrics.sampleCount : 0;
  metrics.costMean = costCount ? costSum / costCount : null;
  metrics.latencyMeanMs = latencyCount ? latencySum / latencyCount : null;
  return metrics;
};

const evaluateMetrics = (baseline, candidate, {
  minSuccessDelta = 0,
  maxCostMultiplier = 2,
  maxLatencyMultiplier = 2.5,
  maxSafetyIncidents = 0
} = {}) => {
  const costOkay = baseline.costMean === null || candidate.costMean === null || baseline.costMean === 0
    ? true : candidate.costMean <= baseline.costMean * maxCostMultiplier;
  const latencyOkay = baseline.latencyMeanMs === null || candidate.latencyMeanMs === null || baseline.latencyMeanMs === 0
    ? true : candidate.latencyMeanMs <= baseline.latencyMeanMs * maxLatencyMultiplier;
  const safetyOkay = candidate.safetyIncidentCount <= Math.max(maxSafetyIncidents, baseline.safetyIncidentCount);
  const qualityOkay = candidate.successRate >= baseline.successRate + minSuccessDelta;
  return {
    passed: qualityOkay && costOkay && latencyOkay && safetyOkay,
    qualityOkay,
    costOkay,
    latencyOkay,
    safetyOkay,
    reasonCodes: [
      ...(qualityOkay ? [] : ['QUALITY_BELOW_BASELINE']),
      ...(costOkay ? [] : ['COST_OVER_BUDGET']),
      ...(latencyOkay ? [] : ['LATENCY_OVER_BUDGET']),
      ...(safetyOkay ? [] : ['SAFETY_REGRESSION'])
    ]
  };
};

const reportDigest = (report) => digest({
  reportId: report.reportId,
  proposalId: report.proposalId,
  stage: report.stage,
  datasetDigest: report.datasetDigest,
  baseline: report.baseline,
  candidate: report.candidate,
  decision: report.decision,
  creditBlame: report.creditBlame
});

const outcomeBase = (outcome) => ({
  outcomeId: outcome.outcomeId,
  runId: outcome.runId,
  ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {}),
  ...(outcome.deploymentProposalIds ? { deploymentProposalIds: outcome.deploymentProposalIds } : {}),
  taskClass: outcome.taskClass,
  provider: outcome.provider,
  protocol: outcome.protocol,
  model: outcome.model,
  ...(outcome.modelVersion ? { modelVersion: outcome.modelVersion } : {}),
  ...(outcome.pluginVersion ? { pluginVersion: outcome.pluginVersion } : {}),
  status: outcome.status,
  ...(outcome.verified === undefined ? {} : { verified: outcome.verified === true }),
  ...(outcome.quality === undefined ? {} : { quality: outcome.quality }),
  ...(outcome.safety === undefined ? {} : { safety: outcome.safety }),
  ...(outcome.cost === undefined ? {} : { cost: outcome.cost }),
  ...(outcome.latencyMs === undefined ? {} : { latencyMs: outcome.latencyMs }),
  ...(outcome.safetyIncident === true ? { safetyIncident: true } : {}),
  ...(outcome.sourceEventId ? { sourceEventId: outcome.sourceEventId } : {}),
  recordedAtMs: outcome.recordedAtMs
});

const outcomeRecordDigest = (outcome) => digest(outcomeBase(outcome));

const safeOutcomeText = (value, max) => {
  const text = bounded(value, max);
  return text || 'unknown';
};

const safeDerivedText = (value, max) => {
  const text = safeOutcomeText(value, max);
  return SENSITIVE_TEXT.test(text) ? '[REDACTED]' : text;
};

const safeMetric = (value, min = 0, max = 1) => {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : undefined;
};

const validateOutcome = (outcome) => {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) ||
      typeof outcome.outcomeId !== 'string' || typeof outcome.runId !== 'string' ||
      typeof outcome.taskClass !== 'string' || typeof outcome.provider !== 'string' ||
      typeof outcome.protocol !== 'string' || typeof outcome.model !== 'string' ||
      (outcome.verified !== undefined && typeof outcome.verified !== 'boolean') ||
      (outcome.deploymentProposalIds !== undefined && (!Array.isArray(outcome.deploymentProposalIds)
        || outcome.deploymentProposalIds.length > 1000
        || outcome.deploymentProposalIds.some((id) => typeof id !== 'string' || !id))) ||
      !Number.isFinite(outcome.recordedAtMs) ||
      outcome.outcomeDigest !== outcomeRecordDigest(outcome)) return false;
  return true;
};

const normalizeCohortFilters = (filters = {}) => {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('EVOLUTION_COHORT_FILTERS_INVALID');
  const result = {};
  for (const key of ['runId', 'proposalId', 'taskClass', 'provider', 'protocol', 'model']) {
    if (filters[key] !== undefined) result[key] = safeOutcomeText(filters[key], key === 'model' ? 160 : 240);
  }
  for (const key of ['fromMs', 'toMs']) {
    if (filters[key] === undefined) continue;
    const value = Number(filters[key]);
    if (!Number.isInteger(value) || value < 0) throw new Error('EVOLUTION_COHORT_TIME_INVALID');
    result[key] = value;
  }
  if (result.fromMs !== undefined && result.toMs !== undefined && result.toMs < result.fromMs) {
    throw new Error('EVOLUTION_COHORT_TIME_INVALID');
  }
  const limit = filters.limit === undefined ? 256 : Number(filters.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 4096) throw new Error('EVOLUTION_COHORT_LIMIT_INVALID');
  result.limit = limit;
  return result;
};

export class EvolutionEvaluator {
  #registry;
  #storagePath;
  #reports = new Map();
  #outcomes = new Map();
  #queue = Promise.resolve();
  #loaded = false;
  #now;
  #idFactory;
  #verificationToken;
  #eventStore;
  #control;

  constructor({ registry, storagePath, now = Date.now, idFactory = randomUUID, verificationToken, eventStore, control } = {}) {
    if (!registry || typeof registry.get !== 'function' || typeof registry.transition !== 'function') throw new Error('EVOLUTION_REGISTRY_REQUIRED');
    this.#registry = registry;
    this.#storagePath = storagePath;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#idFactory = typeof idFactory === 'function' ? idFactory : randomUUID;
    this.#verificationToken = verificationToken ?? randomUUID();
    this.#eventStore = eventStore;
    this.#control = control;
  }

  async load() {
    if (this.#loaded) return;
    if (!this.#storagePath && this.#eventStore?.list) {
      let events;
      try { events = await this.#eventStore.list({ aggregateType: 'EvolutionEvaluation' }); }
      catch { throw new Error('EVOLUTION_EVALUATION_READ_FAILED'); }
      for (const event of events) {
        if (event.kind === 'EvolutionOutcomeRecorded' && validateOutcome(event.payload)) {
          this.#outcomes.set(event.payload.outcomeId, clone(event.payload));
        } else if (event.kind === 'EvolutionEvaluationRecorded') {
          const report = event.payload;
          if (report?.reportId && report.reportDigest === reportDigest(report)) {
            this.#reports.set(report.reportId, clone(report));
          }
        }
      }
      this.#loaded = true;
      return;
    }
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try { parsed = await readPersistentJsonFile(this.#storagePath); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('EVOLUTION_EVALUATION_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.reports) || parsed.reports.length > MAX_REPORTS ||
        (parsed.outcomes !== undefined && (!Array.isArray(parsed.outcomes) || parsed.outcomes.length > MAX_OUTCOMES))) throw new Error('EVOLUTION_EVALUATION_INVALID');
    const reportIds = new Set();
    for (const report of parsed.reports) {
      if (!report?.reportId || report.reportDigest !== reportDigest(report)) throw new Error('EVOLUTION_EVALUATION_INVALID');
      if (reportIds.has(report.reportId)) throw new Error('EVOLUTION_EVALUATION_INVALID');
      reportIds.add(report.reportId);
      this.#reports.set(report.reportId, clone(report));
    }
    const outcomeIds = new Set();
    for (const outcome of parsed.outcomes ?? []) {
      if (!validateOutcome(outcome)) throw new Error('EVOLUTION_EVALUATION_INVALID');
      if (outcomeIds.has(outcome.outcomeId)) throw new Error('EVOLUTION_EVALUATION_INVALID');
      outcomeIds.add(outcome.outcomeId);
      this.#outcomes.set(outcome.outcomeId, clone(outcome));
    }
    this.#loaded = true;
  }

  /** Persist a redacted online outcome for later offline evaluation. This is
   * data collection only: it never changes proposal or plugin state. */
  async recordOutcome({ runId, proposalId, deploymentProposalIds, taskClass, provider, protocol, model, modelVersion, pluginVersion, status, verified = false, verificationToken, quality, safety, cost, latencyMs, safetyIncident, sourceEventId } = {}) {
    await this.load();
    await this.#assertControlEnabled('OUTCOME_RECORD');
    if (deploymentProposalIds !== undefined && (!Array.isArray(deploymentProposalIds)
      || deploymentProposalIds.length > 1000
      || deploymentProposalIds.some((id) => typeof id !== 'string' || !this.#registry.get(id))
      || verificationToken !== this.#verificationToken)) throw new Error('EVOLUTION_DEPLOYMENT_BINDING_INVALID');
    const outcome = {
      outcomeId: `outcome-${this.#idFactory()}`,
      runId: safeOutcomeText(runId, 200),
      ...(proposalId ? { proposalId: safeOutcomeText(proposalId, 240) } : {}),
      ...(deploymentProposalIds?.length ? { deploymentProposalIds: [...new Set(deploymentProposalIds)].sort() } : {}),
      taskClass: safeOutcomeText(taskClass, 80),
      provider: safeOutcomeText(provider, 80),
      protocol: safeOutcomeText(protocol, 80),
      model: safeOutcomeText(model, 160),
      ...(modelVersion ? { modelVersion: safeOutcomeText(modelVersion, 120) } : {}),
      ...(pluginVersion ? { pluginVersion: safeOutcomeText(pluginVersion, 120) } : {}),
      status: statusOf(status),
      // Only the task runtime can mark an outcome verified. The token is
      // instance-bound and is never persisted or returned to callers.
      verified: verified === true && verificationToken === this.#verificationToken,
      ...(safeMetric(quality) === undefined ? {} : { quality: safeMetric(quality) }),
      ...(safeMetric(safety) === undefined ? {} : { safety: safeMetric(safety) }),
      ...(safeMetric(cost, 0, Number.MAX_SAFE_INTEGER) === undefined ? {} : { cost: safeMetric(cost, 0, Number.MAX_SAFE_INTEGER) }),
      ...(safeMetric(latencyMs, 0, Number.MAX_SAFE_INTEGER) === undefined ? {} : { latencyMs: safeMetric(latencyMs, 0, Number.MAX_SAFE_INTEGER) }),
      ...(safetyIncident === true ? { safetyIncident: true } : {}),
      ...(sourceEventId ? { sourceEventId: safeOutcomeText(sourceEventId, 240) } : {}),
      recordedAtMs: this.#now()
    };
    outcome.outcomeDigest = outcomeRecordDigest(outcome);
    if (this.#outcomes.size >= MAX_OUTCOMES) this.#outcomes.delete(this.#outcomes.keys().next().value);
    const prior = this.#outcomes.get(outcome.outcomeId);
    if (prior && prior.outcomeDigest !== outcome.outcomeDigest) throw new Error('EVOLUTION_OUTCOME_ID_CONFLICT');
    if (this.#eventStore?.append) await this.#commitEvaluationEvent('EvolutionOutcomeRecorded', outcome.runId, outcome.outcomeId, clone(outcome));
    this.#outcomes.set(outcome.outcomeId, outcome);
    this.#schedulePersist();
    return clone(outcome);
  }

  /**
   * Derive a bounded evolution candidate from one verified online outcome.
   * This records an observation only: the proposal remains PROPOSED and must
   * pass the evaluator's replay/shadow/canary gates before it can be ACTIVE.
   * No prompt, model output, reasoning, or credential is copied into the
   * candidate.
   */
  async proposeFromOutcome({ outcomeId } = {}) {
    await this.load();
    await this.#assertControlEnabled('PROPOSAL');
    if (typeof outcomeId !== 'string' || !outcomeId.trim()) throw new Error('EVOLUTION_OUTCOME_ID_REQUIRED');
    const outcome = this.#outcomes.get(outcomeId);
    if (!outcome) throw new Error('EVOLUTION_OUTCOME_NOT_FOUND');
    if (outcome.verified !== true || outcome.status !== 'SUCCEEDED' || outcome.safetyIncident === true ||
        (Number.isFinite(outcome.safety) && outcome.safety <= 0)) {
      throw new Error('EVOLUTION_OUTCOME_NOT_VERIFIED');
    }
    const sourceOutcomeIds = [outcome.outcomeId];
    const sourceDatasetDigest = digest(sourceOutcomeIds);
    const existing = this.#registry.list().find((proposal) =>
      proposal?.candidateType === 'OUTCOME_DERIVED' &&
      proposal?.sourceDatasetDigest === sourceDatasetDigest
    );
    if (existing) return { created: false, proposal: clone(existing) };

    const proposal = await this.#registry.propose({
      candidateId: `outcome-${outcome.outcomeId}`,
      candidateType: 'OUTCOME_DERIVED',
      sourceOutcomeIds,
      sourceDatasetDigest,
      taskClass: safeDerivedText(outcome.taskClass, 80),
      route: {
        provider: safeDerivedText(outcome.provider, 80),
        protocol: safeDerivedText(outcome.protocol, 80),
        model: safeDerivedText(outcome.model, 160)
      },
      baselineMetrics: outcomeMetrics([outcome]),
      evidence: {
        verified: true,
        safetyIncidentCount: 0
      }
    });
    return { created: true, proposal: clone(proposal) };
  }

  async replay({ proposalId, fixtures = [], evaluator, baseline = undefined, options = {}, stage = 'OFFLINE_REPLAY', datasetKind = 'DEV', datasetVersion = '1.0' } = {}) {
    await this.load();
    await this.#assertControlEnabled('REPLAY');
    const normalizedDatasetKind = normalizeDatasetKind(datasetKind);
    const normalizedDatasetVersion = normalizeDatasetVersion(datasetVersion);
    const proposal = this.#registry.get(proposalId);
    if (!proposal) throw new Error('EVOLUTION_NOT_FOUND');
    if (!Array.isArray(fixtures) || fixtures.length < 1 || fixtures.length > 4096) throw new Error('EVOLUTION_FIXTURES_INVALID');
    if (evaluator !== undefined && typeof evaluator !== 'function') throw new Error('EVOLUTION_EVALUATOR_INVALID');
    const candidateResults = [];
    const baselineResults = [];
    for (const fixture of fixtures) {
      const result = evaluator ? await evaluator({ fixture: clone(fixture), proposal: clone(proposal) }) : fixture?.candidate;
      const base = fixture?.baseline;
      candidateResults.push(result ?? { status: 'UNKNOWN' });
      baselineResults.push(base ?? { status: 'UNKNOWN' });
    }
    const baselineMetrics = baseline ?? outcomeMetrics(baselineResults);
    const candidateMetrics = outcomeMetrics(candidateResults);
    const decision = evaluateMetrics(baselineMetrics, candidateMetrics, options);
    const report = {
      reportId: `evaluation-${this.#idFactory()}`,
      proposalId,
      stage: bounded(stage, 40),
      datasetKind: normalizedDatasetKind,
      datasetVersion: normalizedDatasetVersion,
      datasetDigest: digest({
        datasetKind: normalizedDatasetKind,
        datasetVersion: normalizedDatasetVersion,
        cases: fixtures.map((fixture) => fixture?.caseId ?? fixture?.id ?? fixture)
      }),
      baseline: clone(baselineMetrics),
      candidate: clone(candidateMetrics),
      decision,
      evaluatedAtMs: this.#now()
    };
    report.reportDigest = reportDigest(report);
    if (this.#eventStore?.append) await this.#commitEvaluationEvent('EvolutionEvaluationRecorded', 'evolution-evaluation:' + report.proposalId, report.reportId, clone(report));
    this.#reports.set(report.reportId, report);
    this.#schedulePersist();
    return clone(report);
  }

  async shadow({ proposalId, fixtures, evaluator, baseline, options, datasetKind = 'DEV', datasetVersion = '1.0' } = {}) {
    await this.#assertControlEnabled('SHADOW');
    const proposal = this.#registry.get(proposalId);
    if (!proposal || proposal.status !== 'PROPOSED') throw new Error('EVOLUTION_SHADOW_STATE_INVALID');
    await this.#registry.transition(proposalId, 'VALIDATING', { stage: 'OFFLINE_REPLAY' });
    const report = await this.replay({ proposalId, fixtures, evaluator, baseline, options, stage: 'SHADOW', datasetKind, datasetVersion });
    if (!report.decision.passed) {
      await this.#registry.transition(proposalId, 'REJECTED', { reportId: report.reportId, reasonCodes: report.decision.reasonCodes });
      return { report, status: 'REJECTED' };
    }
    await this.#registry.transition(proposalId, 'SHADOW', { reportId: report.reportId });
    return { report, status: 'SHADOW' };
  }

  async canary(proposalId, { eligibleTrafficPercent = 5, fixtures, evaluator, baseline, options, datasetKind = 'DEV', datasetVersion = '1.0' } = {}) {
    await this.#assertControlEnabled('CANARY');
    if (!Number.isFinite(eligibleTrafficPercent) || eligibleTrafficPercent < 0 || eligibleTrafficPercent > 5) throw new Error('EVOLUTION_CANARY_LIMIT_INVALID');
    const proposal = this.#registry.get(proposalId);
    if (!proposal || proposal.status !== 'SHADOW') throw new Error('EVOLUTION_CANARY_STATE_INVALID');
    const report = fixtures ? await this.replay({ proposalId, fixtures, evaluator, baseline, options, stage: 'CANARY', datasetKind, datasetVersion }) : this.latest(proposalId, 'SHADOW');
    if (!report?.decision?.passed) throw new Error('EVOLUTION_CANARY_REJECTED');
    const transitioned = await this.#registry.transition(proposalId, 'CANARY', { reportId: report.reportId, eligibleTrafficPercent });
    return { record: transitioned, report: clone(report) };
  }

  async promote(proposalId, { fixtures, evaluator, baseline, options, datasetKind = 'DEV', datasetVersion = '1.0', requireHoldout = false } = {}) {
    await this.#assertControlEnabled('PROMOTION');
    const proposal = this.#registry.get(proposalId);
    if (!proposal || proposal.status !== 'CANARY') throw new Error('EVOLUTION_PROMOTION_STATE_INVALID');
    let report = fixtures
      ? await this.replay({ proposalId, fixtures, evaluator, baseline, options, stage: 'PROMOTION', datasetKind, datasetVersion })
      : (this.latest(proposalId, 'CANARY') ?? this.latest(proposalId, 'SHADOW'));
    if (requireHoldout) {
      const holdout = report?.datasetKind === 'HOLDOUT' && report.decision?.passed === true
        ? report
        : [...this.#reports.values()]
          .filter((item) => item?.proposalId === proposalId && item?.datasetKind === 'HOLDOUT' && item?.decision?.passed === true)
          .sort((left, right) => (right.evaluatedAtMs ?? 0) - (left.evaluatedAtMs ?? 0))[0];
      if (!holdout) throw new Error('EVOLUTION_HOLDOUT_REQUIRED');
      report = holdout;
    }
    if (!report?.decision?.passed || !report.decision.safetyOkay) throw new Error('EVOLUTION_PROMOTION_REJECTED');
    return { record: await this.#registry.transition(proposalId, 'ACTIVE', { reportId: report.reportId }), report: clone(report) };
  }

  /**
   * Inspect redacted online outcomes for a canary/active proposal. Monitoring
   * can roll a candidate back on a proven safety or metric regression, but it
   * never promotes a proposal and never consumes raw task content.
   */
  async monitor({ proposalId, minSamples = 3, maxSafetyIncidents = 0, options = {}, expectedVersion, expectedPackageDigest } = {}) {
    await this.load();
    await this.#assertControlEnabled('ONLINE_MONITOR');
    if (typeof proposalId !== 'string' || !proposalId.trim()) throw new Error('EVOLUTION_PROPOSAL_ID_REQUIRED');
    const minimum = Number(minSamples);
    if (!Number.isInteger(minimum) || minimum < 1 || minimum > 1024) throw new Error('EVOLUTION_MONITOR_MIN_SAMPLES_INVALID');
    const safetyLimit = Number(maxSafetyIncidents);
    if (!Number.isInteger(safetyLimit) || safetyLimit < 0 || safetyLimit > 32) throw new Error('EVOLUTION_MONITOR_SAFETY_LIMIT_INVALID');
    const proposal = this.#registry.get(proposalId);
    if (!proposal || !['CANARY', 'ACTIVE'].includes(proposal.status)) throw new Error('EVOLUTION_MONITOR_STATE_INVALID');
    const outcomes = this.listOutcomes({ proposalId });
    const candidate = outcomeMetrics(outcomes);
    // Use the report that authorized this deployment, not a later replay or
    // monitor report whose baseline may describe a different experiment.
    const deploymentReport = this.#reports.get(proposal.lastTransition?.metadata?.reportId);
    const deploymentBaseline = deploymentReport?.proposalId === proposalId
      && ['SHADOW', 'CANARY', 'PROMOTION'].includes(deploymentReport.stage)
      && deploymentReport.decision?.passed === true
      ? deploymentReport.baseline : undefined;
    const baselineSource = deploymentBaseline ?? proposal.baselineMetrics;
    const baseline = baselineSource && typeof baselineSource === 'object'
      ? clone(baselineSource)
      : outcomeMetrics([]);
    const evidenceSufficient = candidate.sampleCount >= minimum;
    const versionDrift = (expectedVersion !== undefined || expectedPackageDigest !== undefined) && (
      (expectedVersion !== undefined && safeOutcomeText(expectedVersion, 120) !== safeOutcomeText(proposal.version, 120)) ||
      (expectedPackageDigest !== undefined && safeOutcomeText(expectedPackageDigest, 200) !== safeOutcomeText(proposal.packageDigest, 200))
    );
    const metricDecision = baselineSource
      ? evaluateMetrics(baseline, candidate, options)
      : {
          passed: true,
          qualityOkay: true,
          costOkay: true,
          latencyOkay: true,
          safetyOkay: candidate.safetyIncidentCount <= safetyLimit,
          reasonCodes: []
        };
    const safetyOkay = candidate.safetyIncidentCount <= safetyLimit;
    const reasonCodes = [
      ...(!evidenceSufficient ? ['INSUFFICIENT_EVIDENCE'] : []),
      ...(versionDrift ? ['VERSION_DRIFT'] : []),
      ...(!safetyOkay ? ['SAFETY_REGRESSION'] : []),
      ...(metricDecision.qualityOkay ? [] : ['QUALITY_BELOW_BASELINE']),
      ...(metricDecision.costOkay ? [] : ['COST_OVER_BUDGET']),
      ...(metricDecision.latencyOkay ? [] : ['LATENCY_OVER_BUDGET'])
    ];
    const decision = {
      ...metricDecision,
      safetyOkay,
      evidenceSufficient,
      passed: evidenceSufficient && !versionDrift && safetyOkay && metricDecision.qualityOkay && metricDecision.costOkay && metricDecision.latencyOkay,
      reasonCodes: [...new Set(reasonCodes)]
    };
    const report = {
      reportId: `evaluation-${this.#idFactory()}`,
      proposalId,
      stage: 'ONLINE_MONITOR',
      datasetDigest: digest(outcomes.map((outcome) => outcome.outcomeId)),
      baseline,
      candidate,
      decision,
      evaluatedAtMs: this.#now()
    };
    report.reportDigest = reportDigest(report);
    this.#reports.set(report.reportId, report);
    this.#schedulePersist();
    // Safety incidents are a stop condition independent of the statistical
    // sample floor used for quality, cost and latency comparisons.
    if (!safetyOkay || versionDrift || (evidenceSufficient && !decision.passed)) {
      const rolledBack = await this.#registry.transition(proposalId, 'ROLLED_BACK', {
        reportId: report.reportId,
        reason: 'ONLINE_MONITOR_REGRESSION',
        reasonCodes: decision.reasonCodes
      });
      return { status: 'ROLLED_BACK', proposal: clone(rolledBack), report: clone(report), outcomes: candidate };
    }
    return {
      status: evidenceSufficient ? 'HEALTHY' : 'INSUFFICIENT_EVIDENCE',
      proposal: clone(this.#registry.get(proposalId)),
      report: clone(report),
      outcomes: candidate
    };
  }

  controlState() {
    return this.#control?.state?.() ?? { enabled: true, changedAtMs: 0 };
  }

  async #assertControlEnabled(operation) {
    if (!this.#control?.assertEnabled) return;
    await this.#control.assertEnabled(operation);
  }

  async rollback(proposalId, reason = 'EVALUATION_REGRESSION') {
    const proposal = this.#registry.get(proposalId);
    if (!proposal || !['CANARY', 'ACTIVE'].includes(proposal.status)) throw new Error('EVOLUTION_ROLLBACK_STATE_INVALID');
    return this.#registry.transition(proposalId, 'ROLLED_BACK', { reason: bounded(reason, 160) });
  }

  latest(proposalId, stage) {
    return [...this.#reports.values()]
      .filter((report) => report.proposalId === proposalId && (!stage || report.stage === stage))
      .sort((left, right) => right.evaluatedAtMs - left.evaluatedAtMs)[0];
  }

  /**
   * Verify the redacted proof that a plugin may use when it is promoted to
   * ACTIVE. This remains synchronous so PluginGovernance can validate a
   * transition before mutating its own state; reports must already be loaded.
   */
  verifyPluginPromotion({ reportId, reportDigest, pluginId, packageDigest } = {}) {
    if (typeof reportId !== 'string' || typeof reportDigest !== 'string') return false;
    const report = this.#reports.get(reportId);
    if (!report || report.reportDigest !== reportDigest) return false;
    if (!['CANARY', 'PROMOTION'].includes(report.stage) || report.decision?.passed !== true || report.decision?.safetyOkay !== true) return false;
    const proposal = this.#registry.get(report.proposalId);
    if (!proposal || !['CANARY', 'ACTIVE'].includes(proposal.status)) return false;
    const candidatePluginId = proposal.pluginId ?? proposal.candidatePluginId ?? proposal.candidateId;
    if (typeof pluginId === 'string' && candidatePluginId !== pluginId) return false;
    if (typeof packageDigest === 'string' && proposal.packageDigest !== packageDigest) return false;
    return true;
  }

  list(proposalId) { return [...this.#reports.values()].filter((report) => !proposalId || report.proposalId === proposalId).map(clone); }
  listOutcomes({ runId, proposalId } = {}) {
    return [...this.#outcomes.values()]
      .filter((outcome) => (!runId || outcome.runId === runId) && (!proposalId || outcome.proposalId === proposalId || outcome.deploymentProposalIds?.includes(proposalId)))
      .map(clone);
  }
  /**
   * Build a stable, redacted baseline cohort from recorded online outcomes.
   * Cohorts are read-only and never alter proposal/plugin lifecycle state.
   */
  cohort(filters = {}) {
    const normalized = normalizeCohortFilters(filters);
    const outcomes = [...this.#outcomes.values()]
      .filter((outcome) => Object.entries(normalized).every(([key, value]) => {
        if (key === 'limit') return true;
        if (key === 'fromMs') return outcome.recordedAtMs >= value;
        if (key === 'toMs') return outcome.recordedAtMs <= value;
        if (key === 'proposalId') return outcome.proposalId === value || outcome.deploymentProposalIds?.includes(value);
        return outcome[key] === value;
      }))
      .sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.outcomeId.localeCompare(right.outcomeId))
      .slice(-normalized.limit)
      .map(clone);
    const outcomeIds = outcomes.map((outcome) => outcome.outcomeId);
    const cohortBase = { filters: normalized, outcomeIds };
    return {
      cohortId: `cohort-${digest(cohortBase).slice('sha256:'.length, 24)}`,
      filters: normalized,
      datasetDigest: digest(outcomeIds),
      metrics: outcomeMetrics(outcomes),
      outcomeIds,
      outcomes
    };
  }

  /** Convert a redacted online cohort into replay fixtures with a baseline. */
  fixturesFromOutcomes(filters = {}) {
    return this.cohort(filters).outcomes.map((outcome) => ({
      caseId: `live-${outcome.outcomeId}`,
      baseline: clone(outcome),
      taskClass: outcome.taskClass,
      provider: outcome.provider,
      protocol: outcome.protocol,
      model: outcome.model
    }));
  }
  async flush() { await this.#queue; }

  async #commitEvaluationEvent(kind, runId, aggregateId, payload) {
    await this.#eventStore.append({ runId: String(runId || 'evolution-evaluation').slice(0, 240), aggregateType: 'EvolutionEvaluation', aggregateId: String(aggregateId).slice(0, 240), kind, payload, sensitivity: 'INTERNAL' });
  }

  #schedulePersist() {
    if (!this.#storagePath) return;
    const write = async () => persistJsonFile(this.#storagePath, {
      schemaVersion: SCHEMA_VERSION,
      reports: this.list(),
      outcomes: this.listOutcomes()
    }, {
      merge: (existing, incoming) => {
        const reports = mergeRecordsById(existing, incoming, { collection: 'reports', id: 'reportId' }).reports;
        const outcomes = mergeRecordsById(existing, incoming, { collection: 'outcomes', id: 'outcomeId' }).outcomes;
        return { ...incoming, reports, outcomes };
      }
    });
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }
}

export const createEvolutionEvaluator = (options) => new EvolutionEvaluator(options);
export const evaluateEvolutionMetrics = evaluateMetrics;
export const evolutionReportDigest = reportDigest;
export const replayOutcomeMetrics = outcomeMetrics;
export const normalizeEvolutionCohortFilters = normalizeCohortFilters;
