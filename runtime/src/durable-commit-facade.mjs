import { createHash } from 'node:crypto';
const clone = (value) => structuredClone(value);

const committed = (result, phase, expectedCommandId) => {
  if (!result || result.receipt?.status !== 'COMMITTED') {
    const error = new Error('DURABLE_COMMIT_REQUIRED');
    error.phase = phase;
    throw error;
  }
  const event = result.event;
  if (!event?.eventId || !Array.isArray(result.receipt.eventIds) || !result.receipt.eventIds.includes(event.eventId)
    || (expectedCommandId !== undefined && result.receipt.commandId !== expectedCommandId)) {
    const error = new Error('DURABLE_COMMIT_REQUIRED');
    error.phase = phase;
    throw error;
  }
  return result;
};

/**
 * Enforces the safety ordering around an external effect. The effect is never
 * entered until its intent has a durable COMMITTED receipt.
 */
export const createDurableCommitFacade = ({ eventStore, now = () => Date.now() } = {}) => {
  if (!eventStore || typeof eventStore.append !== 'function') throw new Error('DURABLE_EVENT_STORE_REQUIRED');
  return Object.freeze({
    async commitBeforeEffect({ runId, aggregateType = 'TaskRun', aggregateId = runId, intentKind = 'EffectIntent', intentPayload = {}, effect, successKind = 'EffectCompleted', failureKind = 'EffectFailed', commandId } = {}) {
      if (typeof runId !== 'string' || !runId.trim() || typeof effect !== 'function') throw new Error('DURABLE_EFFECT_INPUT_INVALID');
      const appended = await eventStore.append({
        runId, aggregateType, aggregateId, kind: intentKind, payload: clone(intentPayload), commandId
      });
      // An existing intent may already have executed, even if its outcome was
      // lost. Recovery must reconcile it rather than invoking the effect again.
      if (appended?.idempotent) {
        const error = new Error('DURABLE_EFFECT_RECOVERY_REQUIRED');
        error.phase = 'intent';
        error.intentEventId = appended.event?.eventId ?? appended.eventIds?.[0];
        throw error;
      }
      const intent = committed(appended, 'intent', commandId);
      let value;
      try {
        value = await effect({ intent: clone(intent.event), receipt: clone(intent.receipt) });
      } catch (cause) {
        let outcome;
        try {
          outcome = committed(await eventStore.append({
            runId, aggregateType, aggregateId, kind: failureKind,
            commandId: intent.event.eventId + ':failure-outcome',
            payload: { intentEventId: intent.event.eventId, failedAtMs: now(), errorCode: String(cause?.code ?? cause?.name ?? 'EFFECT_FAILED').slice(0, 120) }
          }), 'failure-outcome', intent.event.eventId + ':failure-outcome');
        } catch (outcomeError) {
          outcomeError.cause = cause;
          outcomeError.intentEventId = intent.event.eventId;
          throw outcomeError;
        }
        cause.outcome = outcome;
        throw cause;
      }
      const outcome = committed(await eventStore.append({
        runId, aggregateType, aggregateId, kind: successKind,
        commandId: intent.event.eventId + ':success-outcome',
        payload: { intentEventId: intent.event.eventId, completedAtMs: now(), resultDigest: resultDigest(value) }
      }), 'success-outcome', intent.event.eventId + ':success-outcome');
      return { value, intent, outcome };
    }
  });
};

const resultDigest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value === undefined ? null : value), 'utf8').digest('hex')}`;
