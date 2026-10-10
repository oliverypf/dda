import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = 'C:/Users/User/hmCodex-local', clone = join(root, 'docs/artifacts/goal-verification-fix-20261008');
const manifest = JSON.parse(await readFile(join(root, 'docs/artifacts/agent-goal-runs/20261007T162508744Z-b72917fe/runtime-source-manifest.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
for (const item of manifest.files) if (hash(await readFile(join(root, 'runtime/src', item.path))) !== item.sha256) throw Error(`CURRENT_SOURCE_DIFFERS_FROM_COMPLETED_BATCH:${item.path}`);
const runtimeFiles = ['src/index.mjs', 'src/task-recovery-controller.mjs', 'src/decision/engine.mjs', 'src/decision/process-intent.mjs',
  'src/decision/verification-retry.mjs', 'src/decision/readonly-resume-observations.mjs', 'src/plugins/task-runner.mjs'];
for (const file of runtimeFiles) await writeFile(join(root, 'runtime', file), await readFile(join(clone, 'runtime', file)),
  file.endsWith('verification-retry.mjs') || file.endsWith('readonly-resume-observations.mjs') ? { flag: 'wx' } : undefined);
for (const file of ['goal-test-acceptance.mjs', 'goal-test-acceptance.test.mjs', 'goal-evidence-audit.test.mjs'])
  await writeFile(join(root, 'desktop/scripts', file), await readFile(join(clone, 'desktop/scripts', file)));
const tests = [
  ['GOAL_VERIFICATION_ONLY_FIX_2026-10-08.test.mjs', 'verification-only-recovery-runtime.test.mjs'],
  ['GOAL_READONLY_RESUME_OBSERVATIONS_2026-10-08.test.mjs', 'readonly-resume-observations.test.mjs'],
  ['GOAL_NODE_COMMAND_FIX_DRAFT_2026-10-08.test.mjs', 'node-command-normalization.test.mjs']
];
for (const [source, target] of tests) {
  let code = await readFile(join(root, 'docs/artifacts', source), 'utf8');
  code = code.replaceAll('./goal-verification-fix-20261008/runtime/src/', '../src/')
    .replaceAll("'../../runtime/test/helpers/listen-loopback.mjs'", "'./helpers/listen-loopback.mjs'")
    .replace("const stagedRuntime = 'C:/Users/User/hmCodex-local/docs/artifacts/goal-verification-fix-20261008/runtime';", "const stagedRuntime = new URL('..', import.meta.url);")
    .replace("from './GOAL_NODE_COMMAND_FIX_DRAFT_2026-10-08.mjs'", "from '../src/decision/process-intent.mjs'")
    .replace("import { nodeProcessIntent as original } from '../../runtime/src/decision/process-intent.mjs';\n", '')
    .replace("  assert.equal(original({ command: 'node --test --test-isolation=none' }), undefined, 'current production gap is reproduced independently');\n", '')
    .replace("from '../../runtime/src/safety-executor.mjs'", "from '../src/safety-executor.mjs'");
  if (code.includes('goal-verification-fix-20261008') || code.includes('GOAL_NODE_COMMAND_FIX_DRAFT_2026-10-08')) throw Error(`TEST_SOURCE_TRANSFORM_FAILED:${target}`);
  await writeFile(join(root, 'runtime/test', target), code, { flag: 'wx' });
}
let harness = await readFile(join(root, 'desktop/scripts/goal-evidence-harness.mjs'), 'utf8');
if (!harness.includes("const GRADING_PROTOCOL_VERSION = '2.0-NATIVE_FIXTURE_TEST_EXECUTION';")) throw Error('GRADING_PROTOCOL_NOT_EXPECTED');
harness = harness.replace("const GRADING_PROTOCOL_VERSION = '2.0-NATIVE_FIXTURE_TEST_EXECUTION';", "const GRADING_PROTOCOL_VERSION = '2.1-NATIVE_COMMAND_DIGEST_AND_FIXTURE_TEST';");
await writeFile(join(root, 'desktop/scripts/goal-evidence-harness.mjs'), harness);
console.log('Merged validated isolated fixes after confirmed completion of the 24-run frozen batch. Added 13 runtime cases and native command-digest grading.');
