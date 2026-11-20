const SCRATCH_COMMAND = /\.codex-tmp/i;
const SKILL_KEY = /^(?:workflow:cmd:|workflow:skip:|workflow:timeout:|project:files:)/;
const SKILL_STATEMENT = /^(?:项目命令经验|本轮经验|构建时限经验|项目改动经验)/;

/**
 * Project procedures become skills. Tool and safety rules stay memories.
 * One-off scratch commands are kept out of both.
 */
export const experiencePlacement = (item = {}) => {
  const key = String(item.key ?? '');
  const statement = String(item.statement ?? '');
  const kind = String(item.kind ?? '').toUpperCase();
  if (SCRATCH_COMMAND.test(key) || SCRATCH_COMMAND.test(statement)) return 'skip';
  if (kind === 'SKILL' || SKILL_KEY.test(key) || SKILL_STATEMENT.test(statement)) return 'skill';
  if (kind === 'MEMORY' || kind === 'TASK_OUTCOME') return 'memory';
  return 'memory';
};

const ACTIVITY_STATEMENT = [
  /^Verified task outcome: class=[^;]+; verifier=PASS; outputDigest=sha256:[a-f0-9]{64}$/,
  /^Verified run used .+; workspace entries=\d+; toolCalls=\d+\.$/
];
const EFFECTIVE_STATUS = new Set(['PROPOSED', 'VERIFIED', 'ACTIVE']);

/** Skills and memories are used as soon as they are recorded. Review is optional. */
export const experienceTakesEffect = (item = {}) => {
  if (!EFFECTIVE_STATUS.has(String(item.status ?? ''))) return false;
  const statement = String(item.statement ?? '');
  if (ACTIVITY_STATEMENT.some((pattern) => pattern.test(statement))) return false;
  if (String(item.kind ?? '').toUpperCase() === 'TASK_OUTCOME') return false;
  return experiencePlacement(item) !== 'skip';
};
