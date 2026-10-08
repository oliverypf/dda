// Pair validity is independent of success. Failed and unactivated treatment
// runs stay in the assigned arm; missing measurements are never filled in.
export const summarizeJevAblation = report => {
  const conditions = ['hmcodex-jev-off', 'hmcodex-jev-on'];
  if (!Number.isInteger(report.repeat) || report.repeat < 1 || !report.taskSet?.length) throw Error('ABLATION_PLAN_MISSING');
  const pairs = new Map();
  for (const row of report.rows) {
    if (row.client !== 'hmcodex-runtime' || !conditions.includes(row.condition)) throw Error('ABLATION_CLIENT_MISMATCH');
    const key = `${row.iteration}/${row.taskId}`;
    const pair = pairs.get(key) ?? {};
    if (pair[row.condition]) throw Error('ABLATION_DUPLICATE_ARM');
    pair[row.condition] = row;
    pairs.set(key, pair);
    if (row.model !== report.model || row.runtimeSourceSha256 !== report.runtimeSourceSha256) throw Error('ABLATION_SOURCE_OR_MODEL_MISMATCH');
    const enabled = row.condition === conditions[1];
    if (row.decisionProvider?.mode !== (enabled ? 'LIVE_JEV' : 'OFF') || !enabled && row.decisionProvider.calls !== 0) throw Error('ABLATION_TREATMENT_MISMATCH');
  }
  const checks = [];
  for (let iteration = 1; iteration <= report.repeat; iteration++) for (const task of report.taskSet) {
    const pair = pairs.get(`${iteration}/${task.taskId}`);
    const off = pair?.[conditions[0]], on = pair?.[conditions[1]];
    if (!off || !on) throw Error('ABLATION_PAIR_MISSING');
    if (!off.initialDigest || off.initialDigest !== on.initialDigest) throw Error('ABLATION_INPUT_MISMATCH');
    checks.push({ iteration, taskId: task.taskId, initialDigest: off.initialDigest,
      offRunKey: off.runKey, onRunKey: on.runKey, offStatus: off.status, onStatus: on.status });
  }
  if (checks.length !== pairs.size) throw Error('ABLATION_UNPLANNED_PAIR');
  const on = report.rows.filter(row => row.condition === conditions[1]);
  const sum = key => on.every(row => Number.isFinite(row.decisionProvider[key]))
    ? on.reduce((n, row) => n + row.decisionProvider[key], 0) : null;
  return { method: 'One frozen source, one upstream model, identical paired task files, alternating off/on order.',
    pairs: checks, pairCount: checks.length, assignedOnRuns: on.length,
    activatedOnRuns: on.filter(row => row.decisionProvider.calls > 0).length,
    decision: { calls: sum('calls'), succeededCalls: sum('succeededCalls'), wallMs: sum('wallMs'),
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), estimatedApiCost: sum('estimatedCost'), actualCost: null },
    limitations: ['All failed and timed-out runs are included in their assigned condition.',
      'Decision API-price estimates and language-model subscription quota are separate quantities, not combined invoices.',
      'Small samples and provider/network timing variation limit causal attribution. Human savings and cash charges remain unverified.'] };
};
