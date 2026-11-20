import { normalizePlannerPlan } from './agent-turns.mjs';

// An interrupted command whose outcome is not in the record must not be
// replayed. That used to fail the whole run and leave the task stuck.
// Resume instead keeps the original task going from the files as they are.
export const uncertainBlockedStepIds = (plan) => {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const ids = [];
  for (const step of steps) {
    if (step?.status !== 'BLOCKED' || step?.errorCode !== 'SIDE_EFFECT_OUTCOME_UNCERTAIN') continue;
    if (typeof step.stepId !== 'string' || !step.stepId || ids.includes(step.stepId) || ids.length >= 32) continue;
    ids.push(step.stepId);
  }
  return ids;
};

export const continuationPlanForUncertainResume = ({ runId, stepIds = [], prompt = '' } = {}) => {
  const listed = stepIds.filter((id) => typeof id === 'string' && id).slice(0, 32).join('、');
  const summary = [
    '继续完成原来的任务。',
    listed
      ? `这些步骤在中途中断，结果不能从运行记录确认：${listed}。`
      : '上一步在中途中断，结果不能从运行记录确认。',
    '先检查工作区里的当前文件、命令输出和构建产物，判断实际做到了哪一步。',
    '不要重放结果不明的写入或命令；只有检查表明它没有生效时，才补做缺少的部分。',
    '然后把原任务做完。'
  ].join('');
  return normalizePlannerPlan({
    planId: `continue-${String(runId ?? 'task').replace(/[^A-Za-z0-9_.:-]/gu, '').slice(0, 80) || 'task'}`,
    steps: [{
      stepId: 'continue-task',
      summary,
      actionKind: 'EXECUTE',
      dependencies: []
    }]
  }, { sourceText: String(prompt ?? '') });
};
