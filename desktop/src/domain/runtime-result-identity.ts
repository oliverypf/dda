export function resolveRuntimeResultIdentity(activeRunId: string | undefined, resultRunId: string | undefined, deletedRunIds: ReadonlySet<string>): { runId?: string; deleted: boolean } {
  if (activeRunId && resultRunId && activeRunId !== resultRunId) throw new Error('RUNTIME_RUN_ID_MISMATCH');
  const runId = resultRunId ?? activeRunId;
  return { runId, deleted: runId !== undefined && deletedRunIds.has(runId) };
}
