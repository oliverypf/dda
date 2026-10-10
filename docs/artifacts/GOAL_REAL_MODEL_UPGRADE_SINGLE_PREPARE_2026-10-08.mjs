import { readFile, writeFile } from 'node:fs/promises';
let source = await readFile('docs/artifacts/GOAL_REAL_MODEL_UPGRADE_2026-10-08.mjs', 'utf8');
source = source.replaceAll('goal-real-model-upgrade-20261008', 'goal-real-model-upgrade-single-20261008')
  .replaceAll('GOAL_REAL_MODEL_UPGRADE_2026-10-08.json', 'GOAL_REAL_MODEL_UPGRADE_SINGLE_2026-10-08.json')
  .replace("'--agent-mode', 'multi'", "'--agent-mode', 'single'")
  .replace("let events = []; try { events = parseLines(await readFile(trajectory, 'utf8')); } catch { }", `
  const eventResult = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'harness-events', 'list',
    '--trajectory-store', trajectory, '--harness-event-store', join(runRoot, 'harness.db'), '--run-id', payload?.runId ?? '', '--limit', '500'],
    { cwd: join(root, 'runtime'), timeoutMs: 30000 });
  const events = parseLines(eventResult.stdout).at(-1)?.events ?? [];
  await writeFile(join(runRoot, 'durable-events.json'), JSON.stringify(events, null, 2));`)
  .replace("const decisions = events.filter(event => event.kind === 'DecisionCompleted').map(event => event.payload?.payload ?? event.payload);", `
  const decisionMap = new Map();
  for (const event of events.filter(event => event.kind === 'DecisionTraceEvent')) {
    const decision = event.payload?.decisionSnapshot;
    if (decision?.status === 'COMMITTED') decisionMap.set(decision.decisionId, decision);
  }
  const decisions = [...decisionMap.values()].map(decision => ({ decisionId: decision.decisionId, decisionType: decision.decisionType,
    selectedOptionId: decision.selectedOptionId, reasonCodes: decision.reasonCodes }));`)
  .replace("actualJevUsed: jevContext.requests.some(request => request.status === 200 && request.response?.answers),", `actualJevUsed: jevContext.requests.some(request => request.status === 200 && request.response?.answers),
    jevSelectedStrongModel: decisions.some(decision => decision.decisionType === 'SELECT_SAFE_MODEL_FALLBACK'
      && decision.selectedOptionId === 'strong-model' && decision.reasonCodes?.includes('JEV_DECISION')),`);
if (source.includes("'--agent-mode', 'multi'") || !source.includes('jevSelectedStrongModel:') || !source.includes('const eventResult =')) throw Error('SINGLE_PROBE_PREPARE_FAILED');
await writeFile('docs/artifacts/GOAL_REAL_MODEL_UPGRADE_SINGLE_2026-10-08.mjs', source, { flag: 'wx' });
console.log('Prepared single-executor recovery experiment with SQLite durable evidence and Jev model-selection checks.');
