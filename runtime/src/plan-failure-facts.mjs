// Reconstruct only facts belonging to the failed step. A history page may
// begin mid-step, so wait for a known step boundary before attributing calls.
export function planFailureFacts(events, runId, stepId, plan) {
  if (!stepId || stepId === 'unknown') return undefined;
  const step = plan?.steps?.find(item => item.stepId === stepId);
  let activeStep;
  let steps = [];
  let blockedTool;
  const commands = new Map();
  for (const event of events) {
    if (event.runId !== runId) continue;
    const p = event.payload?.payload ?? event.payload ?? {};
    if (event.kind === 'PlanStepStateChanged') {
      activeStep = p.currentStepId;
      if (Array.isArray(p.steps)) steps = p.steps;
    } else if (activeStep === stepId && !blockedTool) {
      if (event.kind === 'ToolCallRequested' && p.id && typeof p.command === 'string') {
        commands.set(p.id, p.command.slice(0, 128));
      } else if (event.kind === 'ToolActionNotExecuted' && p.invocationAttempted === false && p.errorCode === 'TOOL_OUTSIDE_EXECUTION_SCOPE') {
        blockedTool = { name: p.name, errorCode: p.errorCode,
          ...(commands.has(p.id) ? { command: commands.get(p.id) } : {}) };
      }
    }
  }
  const blockedStepIds = (plan?.steps ?? steps)
    .filter(item => item.status === 'BLOCKED' && item.errorCode === 'DEPENDENCY_FAILED')
    .map(item => item.stepId).slice(0, 16);
  return {
    ...(step?.actionKind ? { actionKind: step.actionKind } : {}),
    ...(blockedTool ? { blockedTool } : {}),
    blockedStepIds
  };
}
