const DEFAULT_ROUTES = Object.freeze({
  inspect: { planner: 'default', executor: 'default', verifier: 'rule' },
  modify: { planner: 'default', executor: 'default', verifier: 'rule' },
  test: { planner: 'default', executor: 'default', verifier: 'rule' },
  unknown: { planner: 'default', executor: 'default', verifier: 'rule' }
});

const CLASSIFIERS = Object.freeze([
  ['test', /\b(test|build|compile)\b/u, ['测试', '构建', '编译']],
  ['modify', /\b(write|edit|modify|patch|fix)\b/u, ['写入', '修改', '修复', '编辑', '改动', '改']],
  ['inspect', /\b(read|inspect|review|check|understand|overview|analyze)\b/u, ['分析', '检查', '查看', '读取', '理解', '了解', '概览', '梳理', '盘点', '项目理解', '项目概览']]
]);

// Small pre-verb window: "do not ever modify" is 3 tokens before the verb.
// Chinese uses the same gap in characters after a clause-local negator.
const NEGATION_WINDOW_WORDS = 3;
const NEGATION_PHRASES = Object.freeze(['do not', "don't", 'dont', 'never', 'no', 'without']);
const ZH_NEGATORS = Object.freeze(['没有需要', '不可以', '不要', '别', '勿']);
const ZH_CLAUSE_BREAK = /[,，。；;！!？?\n、]/u;
const ZH_MODIFY_PATTERN = /修改|改动|编辑|写入|修复|改/u;

const normalizePrompt = (prompt) => String(prompt ?? '').toLowerCase().replaceAll('\u2019', "'");

const tokenizeBefore = (text, index, wordCount) => text
  .slice(0, index)
  .trimEnd()
  .split(/\s+/u)
  .map((token) => token.replace(/^[^a-z0-9']+|[^a-z0-9']+$/gu, ''))
  .filter(Boolean)
  .slice(-wordCount);

const windowContainsNegation = (tokens) => {
  for (let start = 0; start < tokens.length; start += 1) {
    for (let end = start + 1; end <= tokens.length; end += 1) {
      if (NEGATION_PHRASES.includes(tokens.slice(start, end).join(' '))) return true;
    }
  }
  return false;
};

const hasUnnegatedMatch = (text, pattern) => {
  const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(matcher)) {
    if (!windowContainsNegation(tokenizeBefore(text, match.index, NEGATION_WINDOW_WORDS))) return true;
  }
  return false;
};

const clauseBefore = (text, index) => {
  const parts = text.slice(0, index).split(ZH_CLAUSE_BREAK);
  return (parts[parts.length - 1] ?? '').replace(/\s+$/u, '');
};

const chineseWindowContainsNegation = (text, index) => {
  const prefix = clauseBefore(text, index);
  for (const negator of ZH_NEGATORS) {
    const at = prefix.lastIndexOf(negator);
    if (at === -1) continue;
    if (prefix.slice(at + negator.length).replace(/\s+/gu, '').length <= NEGATION_WINDOW_WORDS) return true;
  }
  return false;
};

const hasUnnegatedChineseModify = (text) => {
  const matcher = new RegExp(ZH_MODIFY_PATTERN.source, `${ZH_MODIFY_PATTERN.flags}g`);
  for (const match of text.matchAll(matcher)) {
    if (!chineseWindowContainsNegation(text, match.index)) return true;
  }
  return false;
};

export const classifyTask = (prompt) => {
  const text = normalizePrompt(prompt);
  for (const [taskClass, pattern, zh] of CLASSIFIERS) {
    if (hasUnnegatedMatch(text, pattern)) return taskClass;
    if (taskClass === 'modify') {
      if (hasUnnegatedChineseModify(text)) return taskClass;
      continue;
    }
    if (zh.some((word) => text.includes(word))) return taskClass;
  }
  return 'unknown';
};

export class RuleRouter {
  #routes;
  constructor({ routes = DEFAULT_ROUTES } = {}) { this.#routes = structuredClone(routes); }
  resolve({ prompt, taskClass: requestedTaskClass, mode = 'READ_ONLY', allowedRoles = ['planner', 'executor', 'verifier'] } = {}) {
    const taskClass = typeof requestedTaskClass === 'string' && requestedTaskClass.trim()
      ? requestedTaskClass.trim()
      : classifyTask(prompt);
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
