const unwrap = event => event?.payload?.payload ?? event?.payload;
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const safePath = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && !/[:\u0000-\u001f\u007f]/.test(value) && !/^[\\/]/.test(value)
  && !value.replaceAll('\\', '/').split('/').some(part => part === '..' || part === '.');
const key = path => process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path.replaceAll('\\', '/');

// Restore actual successful writes only from the selected checkpoint lineage.
// These facts cannot authorize another write or upgrade its verification.
export async function resumeWrittenFiles({ events = [], sourceRunId, checkpointDigest, threadId, promptDigest, workspace, mode } = {}) {
  if (mode !== 'CONTROLLED' || !sourceRunId || !digest(checkpointDigest)) return [];
  const runs = [], visited = new Set();
  let runId = sourceRunId, expectedCheckpoint = checkpointDigest;
  while (runId) {
    if (visited.has(runId) || visited.size >= 8) throw new Error('RECOVERY_LINEAGE_INVALID');
    visited.add(runId);
    const source = events.filter(event => event.runId === runId);
    const created = source.filter(event => event.kind === 'TaskRunCreated');
    const creation = unwrap(created[0]);
    if (created.length !== 1 || creation?.requestedMode !== 'CONTROLLED' || creation.promptDigest !== promptDigest
      || !source.some(event => event.kind === 'ThreadCheckpointCommitted' && unwrap(event)?.threadId === threadId
        && unwrap(event)?.checkpointDigest === expectedCheckpoint && unwrap(event)?.checkpoint?.runId === runId)) {
      throw new Error('RECOVERY_LINEAGE_INVALID');
    }
    runs.unshift(source);
    runId = creation.sourceRunId;
    expectedCheckpoint = creation.sourceCheckpointDigest;
    if (runId && !digest(expectedCheckpoint)) throw new Error('RECOVERY_LINEAGE_INVALID');
  }
  const files = new Map();
  for (const event of runs.flat()) {
    if (event.kind !== 'TaskFileWritten') continue;
    const p = unwrap(event);
    if (!safePath(p?.path) || !digest(p?.contentDigest) || !digest(p?.outputDigest)
      || !['file.write', 'file.patch'].includes(p?.name)) throw new Error('RECOVERY_FILE_EVIDENCE_INVALID');
    files.set(key(p.path), { id: event.eventId, name: p.name, path: p.path, contentDigest: p.contentDigest,
      outputDigest: p.outputDigest, state: 'SUCCEEDED', sourceEventId: event.eventId });
  }
  if (files.size > 128) throw new Error('RECOVERY_FILE_LIMIT');
  for (const file of files.values()) {
    let current;
    try { current = await workspace.read(file.path, 1); }
    catch { throw new Error(`RECOVERY_WORKSPACE_CHANGED:${file.path}`); }
    if (current.digest !== file.contentDigest) throw new Error(`RECOVERY_WORKSPACE_CHANGED:${file.path}`);
  }
  return [...files.values()];
}
