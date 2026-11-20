import { EXECUTION_MODES } from './runtime-safety-monitor.mjs';
import { TASK_CLASSES } from './rule-router.mjs';

const boundedPrompt = (prompt) => typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= 100_000;

export class TaskSafetyPrecheck {
  evaluate({ prompt, taskClass = 'unknown', mode = 'CONTROLLED', workspaceRoot = '', workspaceDeferred = false } = {}) {
    const checks = [
      {
        id: 'prompt.valid',
        status: boundedPrompt(prompt) ? 'PASS' : 'FAIL',
        reason: boundedPrompt(prompt) ? 'PROMPT_ACCEPTED' : 'PROMPT_EMPTY_OR_TOO_LARGE'
      },
      {
        id: 'task_class.known',
        status: TASK_CLASSES.includes(taskClass) ? 'PASS' : 'FAIL',
        reason: TASK_CLASSES.includes(taskClass) ? 'TASK_CLASS_ACCEPTED' : 'TASK_CLASS_INVALID'
      },
      {
        id: 'execution_mode.valid',
        status: Object.values(EXECUTION_MODES).includes(mode) ? 'PASS' : 'FAIL',
        reason: Object.values(EXECUTION_MODES).includes(mode) ? 'EXECUTION_MODE_ACCEPTED' : 'EXECUTION_MODE_INVALID'
      },
      {
        id: 'controlled.workspace',
        status: workspaceDeferred || (typeof workspaceRoot === 'string' && workspaceRoot.trim()) ? 'PASS' : 'FAIL',
        reason: workspaceDeferred ? 'PROJECT_TOOLS_REQUIRE_WORKSPACE_CLAIM' : typeof workspaceRoot === 'string' && workspaceRoot.trim()
          ? 'WORKSPACE_SCOPE_AVAILABLE'
          : 'CONTROLLED_WORKSPACE_REQUIRED'
      }
    ];
    const failed = checks.find((check) => check.status === 'FAIL');
    return Object.freeze({
      status: failed ? 'BLOCKED' : 'ALLOWED',
      reason: failed?.reason ?? 'BASELINE_SAFETY_ALLOWED',
      taskClass,
      mode,
      constraints: Object.freeze({
        workspaceScoped: Boolean(workspaceRoot),
        sideEffectsRequireApproval: true,
        networkAllowed: false
      }),
      checks: Object.freeze(checks.map((check) => Object.freeze(check)))
    });
  }
}

export const createTaskSafetyPrecheck = (options) => new TaskSafetyPrecheck(options);
