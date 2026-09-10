const DEFAULT_ROUTES = Object.freeze({
  inspect: { planner: 'default', executor: 'default', verifier: 'rule' },
  modify: { planner: 'default', executor: 'default', verifier: 'rule' },
  test: { planner: 'default', executor: 'default', verifier: 'rule' },
  unknown: { planner: 'default', executor: 'default', verifier: 'rule' }
});

export const classifyTask = (prompt) => {
  const text = String(prompt ?? '').toLowerCase();
  if (/\b(test|build|compile)\b/u.test(text) || ['测试', '构建', '编译'].some((word) => text.includes(word))) return 'test';
  if (/\b(write|edit|modify|patch|fix)\b/u.test(text) || ['写入', '修改', '修复'].some((word) => text.includes(word))) return 'modify';
  if (/\b(read|inspect|review|check|understand|overview|analyze)\b/u.test(text) || ['分析', '检查', '查看', '读取', '理解', '了解', '概览', '梳理', '盘点', '项目理解', '项目概览'].some((word) => text.includes(word))) return 'inspect';
  return 'unknown';
};

export class RuleRouter {
  #routes;
  constructor({ routes = DEFAULT_ROUTES } = {}) { this.#routes = structuredClone(routes); }
  resolve({ prompt, mode = 'READ_ONLY', allowedRoles = ['planner', 'executor', 'verifier'] } = {}) {
    const taskClass = classifyTask(prompt);
    const route = this.#routes[taskClass] ?? this.#routes.unknown ?? {};
    if (!['READ_ONLY', 'CONTROLLED'].includes(mode)) {
      return { taskClass, status: 'BLOCKED', reason: 'INVALID_EXECUTION_MODE', roles: {} };
    }
    if (!Array.isArray(allowedRoles) || allowedRoles.some((role) => typeof role !== 'string' || !role.trim())) {
      return { taskClass, status: 'BLOCKED', reason: 'INVALID_ALLOWED_ROLES', roles: {} };
    }
    const routeObject = route && typeof route === 'object' && !Array.isArray(route) ? route : {};
    const roles = Object.fromEntries(Object.entries(routeObject).filter(([role]) => allowedRoles.includes(role)));
    if (mode === 'READ_ONLY' && taskClass === 'modify') {
      return { taskClass, status: 'BLOCKED', reason: 'READ_ONLY_MODE', roles };
    }
    return { taskClass, status: 'SELECTED', reason: 'STATIC_RULE', roles };
  }
}

export const createRuleRouter = (options) => new RuleRouter(options);
