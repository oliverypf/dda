import { readonlyRegistryObservation } from './registry-observation.mjs';
const unwrap = event => event?.payload?.payload ?? event?.payload;
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
const readonly = new Set(['workspace.read', 'workspace.list', 'workspace.focus']);
const path = value => typeof value === 'string' && /^[A-Za-z0-9_.\\/ -]{1,160}$/u.test(value)
  && !value.replaceAll('\\', '/').startsWith('/') && !value.replaceAll('\\', '/').split('/').includes('..') ? value : undefined;

// Reuse only actual host read observations from a verified checkpoint lineage.
// These bounded facts prove an earlier attempt, never authorize a new action
// or prove the current contents of a file. Do not import model summaries.
export const readonlyResumeObservations = ({ events = [], sourceRunId, checkpointDigest, threadId, promptDigest, mode } = {}) => {
  if (mode !== 'READ_ONLY' || !sourceRunId || !threadId || !digest(checkpointDigest) || !digest(promptDigest)) return [];
  const lineage = [], visited = new Set();
  let runId = sourceRunId, expectedCheckpoint = checkpointDigest;
  while (runId) {
    if (visited.has(runId) || visited.size >= 8) return [];
    visited.add(runId);
    const source = events.filter(event => event.runId === runId);
    const created = source.filter(event => event.kind === 'TaskRunCreated');
    const creation = unwrap(created[0]);
    if (created.length !== 1 || creation?.requestedMode !== 'READ_ONLY' || creation.promptDigest !== promptDigest) return [];
    const checkpoint = source.some(event => event.kind === 'ThreadCheckpointCommitted' && unwrap(event)?.threadId === threadId
      && unwrap(event)?.checkpointDigest === expectedCheckpoint && unwrap(event)?.checkpoint?.runId === runId);
    if (!checkpoint) return [];
    if (source.some(event => event.kind === 'ToolInvocationCompleted' && Number.isFinite(unwrap(event)?.durationMs)
      && !readonly.has(unwrap(event)?.name))) return [];
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
