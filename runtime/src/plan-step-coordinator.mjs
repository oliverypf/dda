import { createHash, randomUUID } from 'node:crypto';
import { restorePlannerPlan } from './agent-turns.mjs';
import {
  countDeterministicGreenJevUncertainReports,
  isDeterministicGreenJevEvidenceUncertain,
  isSoleHardDenyFailure,
  PLAN_CONTINUE_REPLAN_LIMIT,
  promoteDeterministicGreenJevUncertain
} from './task-recovery-controller.mjs';

const MAX_ATTEMPTS = 8;
const TERMINAL_STEP_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'BLOCKED', 'SKIPPED']);
const SUCCESS_STEP_STATUSES = new Set(['SUCCEEDED', 'SKIPPED']);
const RECOVERABLE_STATUSES = new Set(['CONTINUE', 'STALLED', 'UNCERTAIN', 'UNKNOWN']);
const STEP_STATUSES = new Set(['PENDING', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'SKIPPED']);

const clone = (value) => structuredClone(value);
const bounded = (value, max = 500) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max);
const digest = (value) => `sha256:${createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')}`;
const statusOf = (value) => bounded(value, 24).toUpperCase();
const errorCode = (error) => bounded(error?.code ?? error?.message ?? error, 120) || 'PLAN_STEP_FAILED';
const resumeEligible = (step) => ['FAILED', 'BLOCKED'].includes(step?.status)
  && step?.errorCode !== 'SIDE_EFFECT_OUTCOME_UNCERTAIN';
const uncertainSideEffect = (step) => step?.status === 'BLOCKED'
  && step?.errorCode === 'SIDE_EFFECT_OUTCOME_UNCERTAIN';

const normalizeReport = (report) => {
  if (report === true) return { status: 'PASS', summary: 'Step verifier passed' };
  if (report === false || report === undefined || report === null) return { status: 'UNKNOWN', summary: 'Step verifier returned no report' };
  const status = statusOf(report.status ?? report.state ?? report.result);
  return {
    ...clone(report),
    status: STEP_STATUSES.has(status) ? (status === 'SUCCEEDED' ? 'PASS' : status) : (status || 'UNKNOWN'),
    summary: bounded(report.summary ?? report.message, 1000),
    failureCodes: Array.isArray(report.failureCodes)
      ? report.failureCodes.map((value) => bounded(value, 120)).filter(Boolean).slice(0, 32)
      : []
  };
};

// Read workers collect observations concurrently. State-changing operations
// share one ordered gate; verification/recovery waits for both observations
// and then follows plan order, including when an executor throws.
class ReadBatch {
  #slots;
  #gate = Promise.resolve();
  constructor(stepIds) {
    this.#slots = stepIds.map(stepId => ({ stepId, arrived: Promise.withResolvers(), done: Promise.withResolvers() }));
  }
  async beforeVerification(stepId) {
    const index = this.#slots.findIndex(slot => slot.stepId === stepId);
    this.#slots[index].arrived.resolve();
    await Promise.all(this.#slots.map(slot => slot.arrived.promise));
    await Promise.all(this.#slots.slice(0, index).map(slot => slot.done.promise));
  }
  finish(stepId) {
    const slot = this.#slots.find(entry => entry.stepId === stepId);
    slot.arrived.resolve();
    slot.done.resolve();
  }
  serialize(operation) {
    const next = this.#gate.then(operation, operation);
    this.#gate = next.catch(() => {});
    return next;
  }
}

const stepKey = (step) => `${step.stepId}:${step.attempt ?? 0}:${step.status}`;

/**
 * Durable scheduler for a validated planner DAG.
 *
 * The coordinator owns only step lifecycle and checkpoints. It never invokes
 * tools itself; callers supply execute/verify callbacks that remain behind
 * the existing TaskRunner and safety gates.
 */
export class PlanStepCoordinator {
  #coordinator;
  #plan;
  #now;
  #idFactory;
  #onStateChange;
  #reconcileStep;
  #resumeFailed;
  #initialized = false;
  #updates = Promise.resolve();

  constructor({ coordinator, plan, now = Date.now, idFactory = randomUUID, onStateChange, reconcileStep, resumeFailed = false } = {}) {
    if (!coordinator || typeof coordinator.setPlanStateAndFlush !== 'function') {
      throw new Error('PLAN_COORDINATOR_REQUIRED');
    }
    const restored = restorePlannerPlan(plan);
    if (!restored || !Array.isArray(restored.steps) || restored.steps.length < 1) {
      throw new Error('PLAN_INVALID');
    }
    this.#coordinator = coordinator;
    this.#plan = restored;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#idFactory = typeof idFactory === 'function' ? idFactory : randomUUID;
    this.#onStateChange = typeof onStateChange === 'function' ? onStateChange : undefined;
    if (reconcileStep !== undefined && typeof reconcileStep !== 'function') throw new Error('PLAN_RECONCILER_INVALID');
    this.#reconcileStep = reconcileStep;
    this.#resumeFailed = resumeFailed === true;
  }

  get plan() { return clone(this.#plan); }
  get initialized() { return this.#initialized; }

  async initialize() {
    if (this.#initialized) return this.plan;
    const persisted = this.#coordinator.planState;
    if (persisted && persisted.planDigest === this.#plan.planDigest) {
      const restored = restorePlannerPlan(persisted);
      if (restored) {
        this.#plan = {
          ...this.#plan,
          ...restored,
          steps: restored.steps.map((step, index) => ({
            ...this.#plan.steps[index],
            ...step,
            ...(this.#resumeFailed && resumeEligible(step)
              ? { status: 'READY', errorCode: 'EXPLICIT_RESUME_RETRY' }
              : {})
          }))
        };
      }
    }
    const uncertain = this.#plan.steps.filter(uncertainSideEffect);
    for (const running of this.#plan.steps.filter(step => step.status === 'RUNNING')) {
      await this.#reconcileInterrupted(running);
    }
    // A thread checkpoint may be loaded into a fresh run store during an
    // explicit resume. Failed or blocked steps are retryable only because the
    // caller opted into resume. A step already persisted as
    // SIDE_EFFECT_OUTCOME_UNCERTAIN is not blindly retried: the same proof
    // rule runs again, and only a positive retry/completion result clears it.
    if (this.#resumeFailed) {
      for (const step of uncertain) await this.#reconcileInterrupted(step, { preserveUncertain: true });
      this.#plan = {
        ...this.#plan,
        steps: this.#plan.steps.map((step) => resumeEligible(step)
          ? { ...step, status: 'READY', errorCode: 'EXPLICIT_RESUME_RETRY' }
          : step)
      };
    }
    this.#initialized = true;
    await this.#persist('PLAN_INITIALIZED');
    return this.plan;
  }

  /** Return a deterministic snapshot of the next executable step. */
  nextReady() {
    const ready = this.#plan.steps.find((step) => step.status === 'READY' && this.#dependenciesSatisfied(step));
    if (ready) return clone(ready);
    const pending = this.#plan.steps.find((step) => step.status === 'PENDING' && this.#dependenciesSatisfied(step));
    return pending ? clone(pending) : undefined;
  }

  async run({ executeStep, verifyStep, diagnoseStep, parallelReads = false, maxAttempts = 3, signal, continueReplan, onVerificationPromoted } = {}) {
    if (typeof executeStep !== 'function' || typeof verifyStep !== 'function') throw new Error('PLAN_STEP_CALLBACKS_REQUIRED');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) throw new Error('PLAN_STEP_ATTEMPT_LIMIT_INVALID');
    if (onVerificationPromoted !== undefined && typeof onVerificationPromoted !== 'function') {
      throw new Error('PLAN_VERIFICATION_PROMOTED_CALLBACK_INVALID');
    }
    if (continueReplan !== undefined) {
      if (!continueReplan || typeof continueReplan !== 'object') throw new Error('PLAN_CONTINUE_REPLAN_INVALID');
      if (continueReplan.getWriteCounts !== undefined && typeof continueReplan.getWriteCounts !== 'function') {
        throw new Error('PLAN_CONTINUE_REPLAN_INVALID');
      }
      if (continueReplan.onPlanContinueReplan !== undefined && typeof continueReplan.onPlanContinueReplan !== 'function') {
        throw new Error('PLAN_CONTINUE_REPLAN_INVALID');
      }
      if (continueReplan.isEligible !== undefined && typeof continueReplan.isEligible !== 'function') {
        throw new Error('PLAN_CONTINUE_REPLAN_INVALID');
      }
    }
    await this.initialize();
    const runReady = async (step, results, readBatch) => {
      if (step.status === 'PENDING') await this.#update(step.stepId, { status: 'READY', errorCode: undefined });
      let current = this.#plan.steps.find((item) => item.stepId === step.stepId) ?? step;
      let completed = false;
      let planContinuationsUsed = 0;
      let effectiveMaxAttempts = maxAttempts;
      const firstAttempt = Math.max(0, Number.isInteger(current.attempt) ? current.attempt : 0);
      for (let runAttempt = 1; runAttempt <= effectiveMaxAttempts; runAttempt += 1) {
        const attempt = firstAttempt + runAttempt;
        if (signal?.aborted) throw Object.assign(new Error('PLAN_CANCELLED'), { code: 'PLAN_CANCELLED' });
        await this.#update(step.stepId, {
          status: 'RUNNING',
          attempt,
          errorCode: undefined
        });
        current = this.#plan.steps.find((item) => item.stepId === step.stepId) ?? current;
        let result;
        let report;
        try {
          result = await executeStep({ step: clone(current), attempt, priorResults: clone(results), signal, ...(readBatch ? { readBatch } : {}) });
          await readBatch?.beforeVerification(step.stepId);
          if (signal?.aborted) throw Object.assign(new Error('PLAN_CANCELLED'), { code: 'PLAN_CANCELLED' });
          report = normalizeReport(await verifyStep({ step: clone(current), attempt, result: clone(result), priorResults: clone(results), signal }));
        } catch (error) {
          await this.#update(step.stepId, {
            status: signal?.aborted ? 'BLOCKED' : 'FAILED',
            attempt,
            errorCode: signal?.aborted ? 'PLAN_CANCELLED' : errorCode(error)
          });
          await this.#propagateBlocked();
          throw error;
        }
        const resultDigest = result?.outputDigest ?? result?.resultDigest ?? (result === undefined ? undefined : digest(JSON.stringify(result)));
        const actionDigest = result?.actionDigest ?? result?.argumentsDigest;
        const record = {
          stepId: step.stepId,
          attempt,
          result: clone(result),
          report: clone(report)
        };
        results.push(record);
        if (report.status === 'PASS') {
          const userAnswer = typeof result?.userAnswer === 'string' ? result.userAnswer.trim() : '';
          await this.#update(step.stepId, {
            status: 'SUCCEEDED',
            attempt,
            ...(typeof actionDigest === 'string' ? { actionDigest } : {}),
            ...(typeof resultDigest === 'string' ? { outputDigest: resultDigest } : {}),
            ...(userAnswer ? { userAnswer } : {})
          });
          completed = true;
          break;
        }
        // CONTINUE / CONTINUE_EXECUTION keeps the same task running, including
        // when nothing has been written yet. A sole safety or lease deny does not.
        let planContinueJustFired = false;
        if (
          continueReplan
          && planContinuationsUsed < PLAN_CONTINUE_REPLAN_LIMIT
          && report.status === 'CONTINUE'
          && statusOf(report.nextAction) === 'CONTINUE_EXECUTION'
        ) {
          const counts = typeof continueReplan.getWriteCounts === 'function'
            ? (continueReplan.getWriteCounts({ step: clone(current), attempt, result: clone(result), report: clone(report) }) ?? {})
            : {};
          const eligible = typeof continueReplan.isEligible === 'function'
            ? continueReplan.isEligible({
              status: report.status,
              nextAction: report.nextAction,
              writesApplied: counts.writesApplied ?? 0,
              successfulWrites: counts.successfulWrites ?? 0,
              failureCodes: report.failureCodes,
              alreadyReplanned: planContinuationsUsed >= PLAN_CONTINUE_REPLAN_LIMIT,
              continuationsUsed: planContinuationsUsed
            })
            : (
              planContinuationsUsed < PLAN_CONTINUE_REPLAN_LIMIT
              && !isSoleHardDenyFailure(report.failureCodes)
            );
          if (eligible) {
            planContinuationsUsed += 1;
            planContinueJustFired = true;
            const writesApplied = Number(counts.writesApplied ?? counts.successfulWrites ?? 0) || 0;
            await continueReplan.onPlanContinueReplan?.({
              writesApplied,
              failureCodes: [...(report.failureCodes ?? [])],
              status: 'CONTINUE',
              nextAction: 'CONTINUE_EXECUTION',
              stepId: step.stepId,
              attempt
            });
            effectiveMaxAttempts = Math.max(effectiveMaxAttempts, runAttempt + 1);
            if (effectiveMaxAttempts > MAX_ATTEMPTS) effectiveMaxAttempts = MAX_ATTEMPTS;
          }
        }
        if (
          (RECOVERABLE_STATUSES.has(report.status) && runAttempt < effectiveMaxAttempts)
          || planContinueJustFired
        ) {
          let diagnosis;
          if (typeof diagnoseStep === 'function') {
            diagnosis = await diagnoseStep({ step: clone(current), attempt, report: clone(report), result: clone(result), priorResults: clone(results) });
          }
          await this.#update(step.stepId, {
            status: 'READY',
            attempt,
            errorCode: planContinueJustFired
              ? 'PLAN_CONTINUE_REPLAN'
              : (report.failureCodes?.[0] ?? statusOf(report.status)),
            ...(diagnosis === undefined ? {} : { diagnosisDigest: digest(JSON.stringify(diagnosis)) })
          });
          continue;
        }
        // freeze-harness-deterministic-green-jev-uncertain-r1 + tip-path-r1:
        // terminal path only (retries exhausted). Final report that is
        // evidence-only deterministic-green UNCERTAIN → PASS.
        // tip-path: do NOT require stepReports ≥ 2 — live tip uses
        // planCoordinator.run({ maxAttempts: 1 }), so inner miss/post-miss
        // recovery shapes never accumulate in coordinator results. ≥2 path
        // (#85) still works when maxAttempts ≥ 2.
        {
          const stepReports = results
            .filter((entry) => entry.stepId === step.stepId)
            .map((entry) => entry.report);
          const sameShapeCount = countDeterministicGreenJevUncertainReports(stepReports);
          if (
            report.status === 'UNCERTAIN'
            && isDeterministicGreenJevEvidenceUncertain(report)
          ) {
            const priorStatus = report.status;
            const tipPath = sameShapeCount < 2;
            const promoted = promoteDeterministicGreenJevUncertain(report, {
              tipPath
            });
            record.report = clone(promoted);
            report = promoted;
            // Keep the executeStep payload aligned with the coordinator's
            // terminal report. Downstream aggregation receives this payload
            // through result.verification, while report remains the durable
            // coordinator result used by the plan scheduler.
            if (record.result && typeof record.result === 'object') {
              record.result.verification = clone(promoted);
              if ('ok' in record.result) record.result.ok = true;
            }
            await this.#update(step.stepId, {
              status: 'SUCCEEDED',
              attempt,
              ...(typeof actionDigest === 'string' ? { actionDigest } : {}),
              ...(typeof resultDigest === 'string' ? { outputDigest: resultDigest } : {})
            });
            await onVerificationPromoted?.({
              stepId: step.stepId,
              attempt,
              report: clone(promoted),
              priorStatus,
              reason: tipPath ? 'tip-path' : 'dgu'
            });
            completed = true;
            break;
          }
        }
        await this.#update(step.stepId, {
          status: report.status === 'ABSTAIN' || report.status === 'UNKNOWN' ? 'BLOCKED' : 'FAILED',
          attempt,
          ...(typeof actionDigest === 'string' ? { actionDigest } : {}),
          ...(typeof resultDigest === 'string' ? { outputDigest: resultDigest } : {}),
          errorCode: report.failureCodes?.[0] ?? (statusOf(report.status) || 'STEP_VERIFICATION_FAILED')
        });
        await this.#propagateBlocked();
        completed = false;
        break;
      }
      return completed;
    };
    const results = [];
    while (true) {
      if (signal?.aborted) {
        const current = this.#plan.steps.find((step) => step.status === 'RUNNING' || step.status === 'READY');
        if (current) await this.#update(current.stepId, { status: 'BLOCKED', errorCode: 'PLAN_CANCELLED' });
        throw Object.assign(new Error('PLAN_CANCELLED'), { code: 'PLAN_CANCELLED' });
      }
      await this.#propagateBlocked();
      const step = this.nextReady();
      if (!step) {
        const failed = this.#plan.steps.find((item) => item.status === 'FAILED' || item.status === 'BLOCKED');
        if (failed) {
          const failedRecord = [...results].reverse().find((entry) => entry.stepId === failed.stepId);
          return {
            ok: false,
            plan: this.plan,
            results,
            failedStepId: failed.stepId,
            report: failedRecord?.report ?? { status: failed.status, failureCodes: [failed.errorCode ?? 'STEP_FAILED'] },
            errorCode: failed.errorCode
          };
        }
        if (this.#plan.steps.every((item) => TERMINAL_STEP_STATUSES.has(item.status))) {
          return { ok: true, plan: this.plan, results };
        }
        throw new Error('PLAN_NO_PROGRESS');
      }
      const readyReads = [step];
      if (parallelReads && step.actionKind === 'READ') {
        const following = this.#plan.steps.slice(this.#plan.steps.findIndex(item => item.stepId === step.stepId) + 1);
        const next = following.find(item => ['READY', 'PENDING'].includes(item.status) && this.#dependenciesSatisfied(item));
        if (next?.actionKind === 'READ') readyReads.push(next);
      }
      const batch = readyReads.length > 1 ? new ReadBatch(readyReads.map(item => item.stepId)) : undefined;
      const previousCount = results.length;
      const outcomes = await Promise.allSettled(readyReads.map(async item => {
        const records = results.slice();
        try {
          const completed = await runReady(item, records, batch);
          return { completed, records: records.slice(previousCount) };
        } finally {
          batch?.finish(item.stepId);
        }
      }));
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') results.push(...outcome.value.records);
      }
      const error = outcomes.find(outcome => outcome.status === 'rejected');
      if (error) throw error.reason;
      const failedIndex = outcomes.findIndex(outcome => !outcome.value.completed);
      if (failedIndex >= 0) {
        await this.#propagateBlocked();
        const failed = this.#plan.steps.find(item => item.stepId === readyReads[failedIndex].stepId);
        const failedRecord = results.findLast(entry => entry.stepId === failed.stepId);
        return { ok: false, plan: this.plan, results, failedStepId: failed.stepId,
          report: failedRecord?.report ?? { status: failed.status, failureCodes: [failed.errorCode ?? 'STEP_FAILED'] },
          errorCode: failed.errorCode, step: failed };
      }
    }
  }

  async #reconcileInterrupted(step, { preserveUncertain = false } = {}) {
    const reconciliation = this.#reconcileStep
      ? await this.#reconcileStep({ step: clone(step), plan: this.plan })
      : undefined;
    const reconciledStatus = statusOf(reconciliation?.status);
    // Never replay an interrupted side effect merely because the host
    // restarted. The adapter must positively prove retry or completion.
    const proved = reconciledStatus === 'SUCCEEDED' || reconciledStatus === 'RETRY' || reconciledStatus === 'READY';
    // An already-blocked uncertain step stays blocked unless reconciliation
    // positively proves retry or completion. A failed or unknown answer must
    // not fall through to the explicit-resume retry of ordinary failures.
    if (preserveUncertain && !proved) return;
    const patch = reconciledStatus === 'SUCCEEDED'
      ? { status: 'SUCCEEDED', outputDigest: reconciliation.outputDigest }
      : reconciledStatus === 'RETRY' || reconciledStatus === 'READY'
        ? { status: 'READY', errorCode: 'RECONCILED_SAFE_TO_RETRY' }
        : reconciledStatus === 'FAILED'
          ? { status: 'FAILED', errorCode: reconciliation.errorCode ?? 'RECONCILED_FAILED' }
          : { status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' };
    this.#plan = {
      ...this.#plan,
      steps: this.#plan.steps.map((item) => item.stepId === step.stepId ? { ...item, ...patch } : item)
    };
  }

  #dependenciesSatisfied(step) {
    const byId = new Map(this.#plan.steps.map((item) => [item.stepId, item]));
    return step.dependencies.every((dependency) => SUCCESS_STEP_STATUSES.has(byId.get(dependency)?.status));
  }

  async #propagateBlocked() {
    for (const step of this.#plan.steps) {
      if (TERMINAL_STEP_STATUSES.has(step.status)) continue;
      const dependencies = step.dependencies.map((id) => this.#plan.steps.find((item) => item.stepId === id));
      if (dependencies.some((dependency) => dependency && ['FAILED', 'BLOCKED'].includes(dependency.status))) {
        await this.#update(step.stepId, { status: 'BLOCKED', errorCode: 'DEPENDENCY_FAILED' });
      }
    }
  }

  #update(stepId, patch = {}) {
    const write = () => this.#commitStep(stepId, patch);
    this.#updates = this.#updates.then(write, write);
    return this.#updates;
  }

  async #commitStep(stepId, patch) {
    const target = this.#plan.steps.find((step) => step.stepId === stepId);
    if (!target) throw new Error('PLAN_STEP_NOT_FOUND');
    const status = patch.status === undefined ? target.status : statusOf(patch.status);
    if (!STEP_STATUSES.has(status)) throw new Error('PLAN_STEP_STATUS_INVALID');
    const nextSteps = this.#plan.steps.map((step) => {
      if (step.stepId !== stepId) return step;
      const next = { ...step, status };
      for (const key of ['attempt', 'actionDigest', 'outputDigest', 'errorCode']) {
        if (patch[key] !== undefined) next[key] = patch[key];
        else if (patch[key] === undefined && key === 'errorCode' && Object.hasOwn(patch, key)) delete next[key];
      }
      if (typeof patch.userAnswer === 'string') {
        const userAnswer = patch.userAnswer.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim().slice(0, 4000);
        if (userAnswer) next.userAnswer = userAnswer;
      }
      if (patch.diagnosisDigest !== undefined) next.diagnosisDigest = bounded(patch.diagnosisDigest, 120);
      return next;
    });
    const { currentStepId: priorCursor, ...planWithoutCursor } = this.#plan;
    const running = nextSteps.filter(step => step.status === 'RUNNING');
    const currentStepId = running[0]?.stepId;
    this.#plan = {
      ...planWithoutCursor,
      steps: nextSteps,
      ...(currentStepId ? { currentStepId } : {}),
      pendingActions: running.map(step => `execute step ${step.stepId}`),
      updatedAtMs: this.#now()
    };
    await this.#persist(stepKey(this.#plan.steps.find((step) => step.stepId === stepId)));
  }

  async #persist(reason) {
    const state = {
      planId: this.#plan.planId,
      planDigest: this.#plan.planDigest,
      steps: this.#plan.steps,
      ...(this.#plan.currentStepId ? { currentStepId: this.#plan.currentStepId } : {}),
      ...(this.#plan.pendingActions ? { pendingActions: this.#plan.pendingActions } : {}),
      updatedAtMs: this.#plan.updatedAtMs
    };
    await this.#coordinator.setPlanStateAndFlush(state, {
      commandId: `plan-state-${this.#idFactory()}`,
      operationId: `plan-${this.#plan.planId}`,
      reason
    });
    await this.#onStateChange?.({ reason, plan: this.plan, currentStepId: this.#plan.currentStepId });
  }
}

export const createPlanStepCoordinator = (options) => new PlanStepCoordinator(options);
export const planStepStatuses = Object.freeze([...STEP_STATUSES]);
export const planStepDigest = digest;
