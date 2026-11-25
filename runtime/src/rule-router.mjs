export const TASK_CLASSES = Object.freeze(['inspect', 'modify', 'test', 'query', 'unknown']);

const DEFAULT_ROUTES = Object.freeze({
  inspect: { planner: 'default', executor: 'default', verifier: 'rule' },
  modify: { planner: 'default', executor: 'default', verifier: 'rule' },
  test: { planner: 'default', executor: 'default', verifier: 'rule' },
  // Rule fallback when Jev does not choose a role set. A lookup is one
  // executor turn: no planner, no verifier, no council.
  query: { executor: 'default' },
  unknown: { planner: 'default', executor: 'default', verifier: 'rule' }
});

export const requestsRepair = (prompt) => {
  const clauses = String(prompt ?? '').toLowerCase().replaceAll('\u2019', "'").split(/[，,。.;；!！?？:\n]+/u);
  return clauses.some(clause => {
    const text = clause.trim();
    if (/\bhow\s+to\b|如何|怎么修|上次的修复/u.test(text)) return false;
    return /(?:^|\b(?:please|and|then|to|you|must|should|can|kindly)\s+)(?:fix|repair|correct)\b/u.test(text)
      || ['修复', '修正', '修好', '修改实现'].some(word => text.includes(word));
  });
};

export class RuleRouter {
  #routes;
  constructor({ routes = DEFAULT_ROUTES } = {}) { this.#routes = structuredClone(routes); }
  resolve({ prompt, taskClass: requestedTaskClass, mode = 'CONTROLLED', allowedRoles = ['planner', 'executor', 'verifier'] } = {}) {
    const taskClass = typeof requestedTaskClass === 'string' && requestedTaskClass.trim()
      ? requestedTaskClass.trim()
      : 'unknown';
    const route = this.#routes[taskClass] ?? this.#routes.unknown ?? {};
    if (mode !== 'CONTROLLED') {
      return { taskClass, status: 'BLOCKED', reason: 'INVALID_EXECUTION_MODE', roles: {} };
    }
    if (!Array.isArray(allowedRoles) || allowedRoles.some((role) => typeof role !== 'string' || !role.trim())) {
      return { taskClass, status: 'BLOCKED', reason: 'INVALID_ALLOWED_ROLES', roles: {} };
    }
    const routeObject = route && typeof route === 'object' && !Array.isArray(route) ? route : {};
    const roles = Object.fromEntries(Object.entries(routeObject).filter(([role]) => allowedRoles.includes(role)));
    return { taskClass, status: 'SELECTED', reason: 'STATIC_RULE', roles };
  }
}

export const createRuleRouter = (options) => new RuleRouter(options);
