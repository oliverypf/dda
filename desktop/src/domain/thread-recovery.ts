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

const CONTROL_WORD = /^(?:继续|重试|continue|retry)$/iu;
const RECOVERY_PROMPT_MARK = '结果无法从运行记录确认';

// The user cannot see whether an interrupted command landed. The next run
// must inspect the workspace itself and finish the original task. The old
// plan is not resumed, so an unconfirmed write or command is not replayed.
export const uncertainOutcomeRecoveryPrompt = (
  thread: ThreadReadModel | undefined,
  userText?: string
): string | undefined => {
  const block = threadRecoveryBlock(thread);
  if (!block) return undefined;
  const typed = String(userText ?? '').trim();
  if (typed.includes(RECOVERY_PROMPT_MARK)) return typed;
  const substantive = typed && !CONTROL_WORD.test(typed) ? typed : '';
  const title = thread?.title?.trim() ?? '';
  const generic = !title || /^(?:dda task|new thread|未命名会话)$/iu.test(title) || /^Thread\s+[a-f\d]{8,}$/iu.test(title);
  const goal = substantive || (generic ? '' : title);
  return [
    goal ? `继续完成这个任务：${goal}` : '继续完成当前任务。',
    `上次执行在这些步骤中断，结果无法从运行记录确认：${block.stepIds.join('、')}。`,
    '请自己检查工作区里的当前文件、命令输出和构建产物，判断这些步骤实际做到了哪一步。',
    '不要重放结果不明的写入或命令；只有检查表明它没有生效时，才补做缺少的部分。',
    '然后从当前文件状态把原任务做完。'
  ].join('\n');
};

export const isUncertainSideEffectFailure = (payload: {
  errorCode?: unknown;
  code?: unknown;
  stepErrorCode?: unknown;
  failureCodes?: unknown;
} | undefined): boolean => {
  if (!payload) return false;
  const listed = Array.isArray(payload.failureCodes) ? payload.failureCodes : [];
  return [payload.errorCode, payload.code, payload.stepErrorCode, ...listed]
    .some((code) => code === 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
};
