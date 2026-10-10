import { readFile, writeFile } from 'node:fs/promises';
const source = (await readFile('docs/artifacts/GOAL_ACTUAL_CHECKPOINT_UPGRADE_RETEST_2026-10-08.mjs', 'utf8'))
  .replaceAll('goal-actual-checkpoint-upgrade-retest-20261008', 'goal-actual-checkpoint-upgrade-final-20261008')
  .replaceAll('GOAL_ACTUAL_CHECKPOINT_UPGRADE_RETEST_2026-10-08.json', 'GOAL_ACTUAL_CHECKPOINT_UPGRADE_FINAL_2026-10-08.json');
await writeFile('docs/artifacts/GOAL_ACTUAL_CHECKPOINT_UPGRADE_FINAL_2026-10-08.mjs', source, { flag: 'wx' });
console.log('Prepared fresh live acceptance after confirmed recovery of the verification service.');
