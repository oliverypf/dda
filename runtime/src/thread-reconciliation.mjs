import { createThreadStore } from './thread-store.mjs';
import { createTaskRunCoordinator } from './task-run-coordinator.mjs';
import { defaultOwnerAlive } from './role-session-manager.mjs';
import { readPersistentJsonFile, persistJsonFile } from './persistent-json-store.mjs';

export async function reconcileInterruptedThreads({ threadPath, eventStore, roleSessions, ownerAlive = defaultOwnerAlive }) {
  if (!eventStore) return 0;
  // ThreadStore supports legacy JSON-only reads. Recovery may act only on
  // runs belonging to this event store, even if a caller supplied an old cache.
  const threads = createThreadStore({ storagePath: threadPath, eventStore });
  const records = new Map((await threads.list()).map(thread => [thread.id, thread]));
  const candidates = new Map();
  const consider = thread => {
    if (thread.state === 'RUNNING' && thread.activeRunId) candidates.set(thread.activeRunId, thread);
  };
  const cache = threadPath && await readPersistentJsonFile(threadPath);
  for (const thread of cache?.threads ?? []) consider(thread);
  for (const thread of records.values()) consider(thread);
  const corrections = new Map();
  let recovered = 0;
  for (const [runId, candidate] of candidates) {
    const current = records.get(candidate.id);
    if (!current) continue;
    const checkpoint = current.checkpoint?.runId === runId ? current.checkpoint : undefined;
    const contexts = roleSessions.list(runId);
    // OWNER_PROCESS_LOST is recorded after an OS liveness check. It remains
    // valid if Windows subsequently reuses the PID for an unrelated process.
    const lost = checkpoint?.ownerPid ? !ownerAlive(checkpoint.ownerPid)
      : contexts.length && contexts.every(context =>
        (context.state === 'FAILED' && context.reason === 'OWNER_PROCESS_LOST')
        || (Number.isSafeInteger(context.ownerPid) && context.ownerPid > 0 && !ownerAlive(context.ownerPid)));
    if (!lost) continue;
    const events = await eventStore.list({ runId, kinds: ['TaskRunCreated', 'ThreadCheckpointCommitted'] });
    if (!events.some(event => event.payload?.threadId === candidate.id)) {
      // An archived run can already be idle in the live projection. Refresh
      // that stale display row only if this database owns its thread.
      if (current.state !== 'RUNNING' || current.activeRunId !== runId) {
        const created = await eventStore.list({ aggregateType: 'Thread', aggregateId: current.id, kinds: ['ThreadCreated'] });
        if (created.some(event => event.payload?.threadId === current.id)) {
          corrections.set(runId, current);
          recovered++;
        }
      }
      continue;
    }
    const run = createTaskRunCoordinator({ runId, eventStore });
    await run.load();
    if (!run.terminal) await run.transitionAndFlush('FAILED', { reason: 'OWNER_PROCESS_LOST' });
    if (current.state === 'RUNNING' && current.activeRunId === runId) {
      await threads.setState(current.id, run.state === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED',
        { runId, expectedRunId: runId, reason: run.state === 'SUCCEEDED' ? 'RUN_COMPLETED' : 'OWNER_PROCESS_LOST' });
    } else {
      corrections.set(runId, current);
    }
    recovered++;
  }
  if (threadPath && corrections.size) {
    await persistJsonFile(threadPath, cache, { merge: existing => ({
      ...existing, threads: existing.threads.map(thread => {
        const current = corrections.get(thread.activeRunId);
        return current && thread.id === current.id && thread.state === 'RUNNING'
          ? { ...thread, state: current.state, activeRunId: current.activeRunId, stateReason: current.stateReason,
              checkpoint: current.checkpoint } : thread;
      })
    }) });
  }
  return recovered;
}
