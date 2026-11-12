import type { ThreadReadModel } from './models';

export type ThreadRecoveryBlock = NonNullable<ThreadReadModel['recoveryBlock']>;

// A recovery block is only reported for a checkpoint that still contains a
// persisted BLOCKED/SIDE_EFFECT_OUTCOME_UNCERTAIN step. The runtime summary
// field is authoritative; the checkpoint fallback keeps older runtimes honest
// when they did not yet emit recoveryBlock. A failed state or resume label
// alone never produces a block.
const checkpointBlock = (plan: unknown): ThreadRecoveryBlock | undefined => {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return undefined;
  const candidate = plan as { steps?: unknown; plan?: unknown };
  const steps = Array.isArray(candidate.steps) ? candidate.steps
    : Array.isArray(candidate.plan) ? candidate.plan : undefined;
  if (!steps) return undefined;
  const stepIds: string[] = [];
  let blocked = false;
  for (const step of steps) {
    const record = step as { status?: unknown; errorCode?: unknown; stepId?: unknown } | undefined;
    if (record?.status !== 'BLOCKED' || record?.errorCode !== 'SIDE_EFFECT_OUTCOME_UNCERTAIN') continue;
    blocked = true;
    const stepId = typeof record.stepId === 'string' && record.stepId && record.stepId.length <= 160 ? record.stepId : undefined;
    if (stepId && !stepIds.includes(stepId) && stepIds.length < 128) stepIds.push(stepId);
  }
  return blocked && stepIds.length ? { reasonCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN', stepIds } : undefined;
};

export const threadRecoveryBlock = (thread: ThreadReadModel | undefined): ThreadRecoveryBlock | undefined => {
  const summary = thread?.recoveryBlock;
  if (summary?.reasonCode === 'SIDE_EFFECT_OUTCOME_UNCERTAIN' && Array.isArray(summary.stepIds) && summary.stepIds.length > 0) {
    return summary;
  }
  return checkpointBlock(thread?.checkpoint?.plan);
};
