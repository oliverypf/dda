import { readFile, writeFile } from 'node:fs/promises';
let source = await readFile('docs/artifacts/GOAL_ACTUAL_CHECKPOINT_UPGRADE_2026-10-08.mjs', 'utf8');
source = source.replaceAll('goal-actual-checkpoint-upgrade-20261008', 'goal-actual-checkpoint-upgrade-retest-20261008')
  .replaceAll('GOAL_ACTUAL_CHECKPOINT_UPGRADE_2026-10-08.json', 'GOAL_ACTUAL_CHECKPOINT_UPGRADE_RETEST_2026-10-08.json')
  .replace("join(root, 'docs/artifacts/goal-verification-fix-20261008/runtime')", "join(root, 'runtime')")
  .replace('currentWorkspaceBuild: false', 'currentWorkspaceBuild: true')
  .replace("resumedSameThread: second?.payload?.threadId === thread?.id && Boolean(thread?.id),", "resumedSameThread: Boolean(thread?.id) && second?.events.some(event => event.kind === 'ThreadCheckpointCommitted' && (event.payload?.payload ?? event.payload)?.threadId === thread.id),")
  .replace("checkpointRestored: second?.events.some(event => event.kind === 'PlannerTurnCompleted' && (event.payload?.payload ?? event.payload)?.source === 'THREAD_CHECKPOINT')\n      || second?.events.some(event => JSON.stringify(event.payload).includes('THREAD_CHECKPOINT')),", "checkpointRestored: second?.events.some(event => event.kind === 'TaskRunCreated' && (event.payload?.payload ?? event.payload)?.sourceRunId === first.payload?.runId),");
if (source.includes('goal-verification-fix-20261008/runtime') || !source.includes("checkpointRestored: second?.events.some(event => event.kind === 'TaskRunCreated'")) throw Error('RETEST_TRANSFORM_FAILED');
await writeFile('docs/artifacts/GOAL_ACTUAL_CHECKPOINT_UPGRADE_RETEST_2026-10-08.mjs', source, { flag: 'wx' });
console.log('Prepared fresh two-phase real checkpoint/explicit model-upgrade acceptance against current runtime.');
