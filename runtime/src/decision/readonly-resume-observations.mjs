import { readonlyRegistryObservation } from './registry-observation.mjs';
const unwrap = event => event?.payload?.payload ?? event?.payload;
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const readonly = new Set(['workspace.read', 'workspace.list', 'workspace.focus']);
const path = value => typeof value === 'string' && /^[A-Za-z0-9_.\\/ -]{1,160}$/u.test(value)
  && !value.replaceAll('\\', '/').startsWith('/') && !value.replaceAll('\\', '/').split('/').includes('..') ? value : undefined;

// Mode names and planner READ labels are not proof. Require an actual host
// observation and refuse any effect/intent/lease evidence, including attempts
// interrupted before a tool completion was persisted.
export const hasOnlyObservationEvidence = (events = []) => {
  if (!Array.isArray(events) || !events.some(event => readonlyRegistryObservation([event]))) return false;
  return !events.some(event => {
    if (/^(?:Action|ExecutionState|PolicyLease|Lease|TaskFileWritten|TaskWriteEffect)/u.test(event?.kind ?? '')) return true;
    const value = unwrap(event);
    if (typeof value?.errorCode === 'string' && /UNCERTAIN|SCOPE_VIOLATION/u.test(value.errorCode)) return true;
    return event?.kind === 'ToolInvocationCompleted' && !readonly.has(value?.name);
  });
};

// Reuse only actual host read observations from a verified checkpoint lineage.
// These bounded facts prove an earlier attempt, never authorize a new action
// or prove the current contents of a file. Do not import model summaries.
export const readonlyResumeObservations = ({ events = [], sourceRunId, checkpointDigest, threadId, promptDigest, mode } = {}) => {
  if (mode !== 'CONTROLLED' || !sourceRunId || !threadId || !digest(checkpointDigest) || !digest(promptDigest)) return [];
  const lineage = [], visited = new Set();
  let runId = sourceRunId, expectedCheckpoint = checkpointDigest;
  while (runId) {
    if (visited.has(runId) || visited.size >= 8) return [];
    visited.add(runId);
    const source = events.filter(event => event.runId === runId);
    const created = source.filter(event => event.kind === 'TaskRunCreated');
    const creation = unwrap(created[0]);
    // READ_ONLY is accepted only as historical evidence, never as a new mode.
    if (created.length !== 1 || !['READ_ONLY', 'CONTROLLED'].includes(creation?.requestedMode) || !digest(creation.promptDigest)) return [];
    const checkpoint = source.some(event => event.kind === 'ThreadCheckpointCommitted' && unwrap(event)?.threadId === threadId
      && unwrap(event)?.checkpointDigest === expectedCheckpoint && unwrap(event)?.checkpoint?.runId === runId);
    if (!checkpoint) return [];
    if (!hasOnlyObservationEvidence(source)) return [];
    lineage.unshift(source);
    runId = creation.sourceRunId;
    expectedCheckpoint = creation.sourceCheckpointDigest;
    if (runId && !digest(expectedCheckpoint)) return [];
  }
  return lineage.flatMap(source => source.filter(event => event.kind === 'ToolInvocationCompleted' && readonlyRegistryObservation([event]))
    .flatMap(event => {
      const value = unwrap(event);
      if (!digest(value.inputDigest)) return [];
      const errorCode = typeof value.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,96}$/u.test(value.errorCode) ? value.errorCode : undefined;
      return [{ id: event.eventId, name: value.name, state: value.ok ? 'SUCCEEDED' : 'FAILED', argumentsDigest: value.inputDigest,
        ...(digest(value.outputDigest) ? { outputDigest: value.outputDigest } : {}),
        ...(errorCode ? { errorCode } : {}), ...(errorCode === 'WORKSPACE_NOT_FOUND' && path(value.message) ? { path: path(value.message) } : {}),
        sourceRunId: event.runId, sourceEventId: event.eventId }];
    })).slice(-256);
};
