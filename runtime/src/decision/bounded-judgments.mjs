// Bounded judgments that used to be fixed tables. Jev picks one id from the
// list; the rule id stays first so a missed answer falls back to today's rule.
// Jev cannot invent a role, a tool, or a plan shape outside these ids.

export const ROLE_SET_EXECUTOR = 'executor-only';
export const ROLE_SET_FULL = 'full-roles';

export const ROLE_SETS = Object.freeze({
  [ROLE_SET_EXECUTOR]: Object.freeze({ executor: 'default' }),
  [ROLE_SET_FULL]: Object.freeze({ planner: 'default', executor: 'default', verifier: 'rule' })
});

export const ruleRoleSetId = (taskClass) => taskClass === 'query' ? ROLE_SET_EXECUTOR : ROLE_SET_FULL;

export const roleSetCriteria = Object.freeze({
  [ROLE_SET_EXECUTOR]: 'One executor turn. No planner, verifier, or council. Use for a direct answer or a lookup that does not need a plan.',
  [ROLE_SET_FULL]: 'Planner, executor, and rule verifier. Use when the task needs a plan, workspace investigation, file changes, or checks.'
});

export const EXECUTION_PROFILE_LOOKUP = 'external-lookup';
export const EXECUTION_PROFILE_READONLY = 'workspace-readonly';
export const EXECUTION_PROFILE_FULL = 'full-executor';
export const EXECUTION_PROFILE_RESEARCH = 'mixed-source-readonly';

// The planner can name the evidence needed by a step. Legacy checkpoints also
// work: use explicit source references in their objective as a fallback.
export function stepExecutionProfile({ initial, step, goal, readOnly }) {
  if (!readOnly) return initial;
  const localCue = /(?:workspace|repository|local files?|\brepo\b|README\b|工作区|仓库|本地|源码|项目文件|[\w./-]+\.(?:md|rs|mjs|tsx?|json|ya?ml|csv|txt)\b)/iu;
  const webCue = /(?:https?:\/\/|web\s*(?:page|site|search)|\bonline\b|official\s+(?:docs?|documentation|source)|external\s+(?:source|reference)|网页|官网|联网|在线|外部(?:来源|资料)|官方(?:文档|网站))/iu;
  const sources = step.evidenceSources ?? [];
  const objective = step.summary ?? '';
  const local = sources.includes('workspace') || localCue.test(objective);
  const web = sources.includes('web') || webCue.test(objective);
  const mixedGoal = localCue.test(goal) && webCue.test(goal);
  if (local && web || mixedGoal && !local && !web) return EXECUTION_PROFILE_RESEARCH;
  if (web) return EXECUTION_PROFILE_LOOKUP;
  if (local && initial === EXECUTION_PROFILE_LOOKUP) return EXECUTION_PROFILE_READONLY;
  return initial;
}

export const EXECUTION_PROFILES = Object.freeze([
  EXECUTION_PROFILE_LOOKUP,
  EXECUTION_PROFILE_READONLY,
  EXECUTION_PROFILE_FULL
]);

export const ruleExecutionProfile = (taskClass) => taskClass === 'query'
  ? EXECUTION_PROFILE_LOOKUP
  : EXECUTION_PROFILE_FULL;

export const LOOKUP_TOOLS = Object.freeze(['web.search', 'web.fetch', 'network.request', 'user.clarify']);
export const LOOKUP_MAX_TOOL_ROUNDS = 6;
export const READONLY_WORKSPACE_TOOLS = Object.freeze([
  'workspace.list',
  'workspace.read',
  'workspace.focus',
  'workspace.inspect_binary',
  'kernel.workspace_list',
  'kernel.workspace_read',
  'kernel.workspace_focus',
  'kernel.workspace_inspect_binary',
  'user.clarify'
]);

export const executionProfileCriteria = Object.freeze({
  [EXECUTION_PROFILE_LOOKUP]: 'External fact lookup. Search the web and read relevant sources using web.search and web.fetch. The bounded lookup can switch sources before its final answer. No workspace or command tools.',
  [EXECUTION_PROFILE_READONLY]: 'Read the workspace to answer. List, read, and focus tools plus user.clarify. No writes, shell, or network.',
  [EXECUTION_PROFILE_FULL]: 'Normal executor tools. Writes and commands still pass the host approval and safety gates.'
});

export const SINGLE_PLAN_BOUNDED = 'bounded-step';
export const SINGLE_PLAN_MODEL = 'model-planner';

export const singleAgentPlanCriteria = Object.freeze({
  [SINGLE_PLAN_BOUNDED]: 'Do not call the planner model. Use one bounded execute step.',
  [SINGLE_PLAN_MODEL]: 'Call the planner model and execute its validated plan. Only legal when a planner model is already bound.'
});

export const normalizeExecutionProfile = (profile, taskClass) => (EXECUTION_PROFILES.includes(profile) || profile === EXECUTION_PROFILE_RESEARCH)
  ? profile
  : ruleExecutionProfile(taskClass);

export const executionToolAllowed = (profile, toolName, definition) => {
  if (profile === EXECUTION_PROFILE_RESEARCH) {
    return READONLY_WORKSPACE_TOOLS.includes(toolName) || LOOKUP_TOOLS.includes(toolName)
      || (definition?.readOnly === true && (toolName === 'browser.open' || toolName.startsWith('mcp.')));
  }
  if (profile === EXECUTION_PROFILE_LOOKUP) return LOOKUP_TOOLS.includes(toolName);
  if (profile === EXECUTION_PROFILE_READONLY) return READONLY_WORKSPACE_TOOLS.includes(toolName);
  return true;
};

export const preferFirst = (ids, preferred) => [preferred, ...ids.filter((id) => id !== preferred)];

export const choiceRequest = ({
  kind,
  summary,
  prompt,
  taskClass,
  preferredId,
  ids,
  criteria
}) => {
  const ordered = preferFirst(ids, preferredId);
  return {
    preferredId,
    ordered,
    request: {
      state: {
        goal: prompt,
        currentStep: kind,
        action: { kind, summary },
        observation: { status: 'PENDING', taskClass, ruleChoice: preferredId }
      },
      prompt: summary,
      criteria,
      candidates: ordered.map((id, index) => ({
        candidateId: id,
        modelId: id,
        status: 'SUCCEEDED',
        expectedCost: index,
        expectedLatencyMs: index
      }))
    }
  };
};

export const acceptedChoice = (result, ids) => result?.source === 'jev' && ids.includes(result.selectedCandidateId)
  ? result.selectedCandidateId
  : undefined;
