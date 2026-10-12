import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Async-local journal bit (F5 / I11).
 *
 * Kernel / cell dispatchers enter this store BEFORE invokeTool so the shared
 * lease callbacks (onLeaseStarted / onLeaseConsumed / onLeaseFailed) can see
 * whether the current operation belongs to a journaled path. Discrete
 * file.write (bit unset) keeps today's lease path and never touches the journal.
 */
export const JOURNAL_BITS = Object.freeze({
  KERNEL: 'kernel',
  CELL: 'cell'
});

const storage = new AsyncLocalStorage();

export const getJournalAls = () => storage.getStore() ?? null;

export const runWithJournalAls = (context, fn) => {
  if (!context || (context.bit !== JOURNAL_BITS.KERNEL && context.bit !== JOURNAL_BITS.CELL)) {
    throw new TypeError('JOURNAL_ALS_CONTEXT_INVALID');
  }
  if (typeof context.effectId !== 'string' || !context.effectId) {
    throw new TypeError('JOURNAL_ALS_EFFECT_ID_REQUIRED');
  }
  return storage.run(Object.freeze({ ...context }), fn);
};
