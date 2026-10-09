const PRE_REGISTRY_REFUSALS = new Set(['TOOL_NOT_ALLOWED_IN_MODE', 'TOOL_DUPLICATE_REQUEST',
  'TOOL_ACTION_REQUIRES_EVIDENCE', 'TOOL_ACTION_BLOCKED_BY_JEV']);
const relativeMessage = value => typeof value === 'string' && /^[A-Za-z0-9_.\/ -]{1,160}$/u.test(value)
  && !value.startsWith('/') && !value.split('/').includes('..') ? value : '';

// Only durable registry callbacks carry durationMs. Proposal/refusal events
// must not become executed observations. Registry completion says nothing
// about a process exit status, a successful test or a fulfilled user goal.
export const readonlyRegistryObservation = (events = []) => {
  const event = events.findLast(item => {
    const data = item?.payload?.payload ?? item?.payload;
    return item?.kind === 'ToolInvocationCompleted' && item.eventId && typeof data?.ok === 'boolean'
      && Number.isFinite(data.durationMs) && data.durationMs >= 0
      && data.invocationAttempted !== false && !PRE_REGISTRY_REFUSALS.has(data.errorCode);
  });
  const data = event?.payload?.payload ?? event?.payload;
  if (!['workspace.read', 'workspace.list', 'workspace.focus'].includes(data?.name)) return undefined;
  const code = typeof data.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,96}$/u.test(data.errorCode) ? data.errorCode : undefined;
  const path = relativeMessage(data.message);
  return { status: data.ok ? 'SUCCEEDED' : 'FAILED', ok: data.ok,
    summary: data.ok ? `The previous actual ${data.name} registry invocation completed successfully. The current proposed action has not executed.`
      : `The previous actual ${data.name} registry invocation completed and returned ${code ?? 'an error'}${path ? `: ${path}` : ''}. That error has already been observed. The current proposed action has not executed.`,
    failureCodes: !data.ok && code ? [code] : [],
    checks: [{ id: 'previous-registry-invocation-observed', status: 'PASS',
      message: 'The host recorded a completed actual registry invocation, not a deferred proposal. This proves the observation, not successful task completion.',
      evidence: [event.eventId] }] };
};
