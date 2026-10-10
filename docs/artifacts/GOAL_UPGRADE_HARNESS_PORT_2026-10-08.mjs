import { readFile, writeFile } from 'node:fs/promises';
let source = await readFile('docs/artifacts/GOAL_ACTUAL_CHECKPOINT_UPGRADE_FINAL_2026-10-08.mjs', 'utf8');
source = source.replaceAll("from '../../desktop/scripts/", "from './")
  .replace("import { join } from 'node:path';", "import { join, resolve, dirname } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { resolveUpgradeModels } from './goal-upgrade-models.mjs';")
  .replace("const root = 'C:/Users/User/hmCodex-local';", "const root = fileURLToPath(new URL('../../', import.meta.url));\nconst option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;\nconst liveConfig = option('--live-config');\nif (!liveConfig) throw Error('UPGRADE_LIVE_CONFIG_REQUIRED');\nconst output = resolve(option('--output', join(root, 'docs/artifacts/AGENT_GOAL_UPGRADE_VALIDATION.json')));\nawait mkdir(dirname(output), { recursive: true });")
  .replace("const runtimeRoot = join(root, 'runtime');", "const runtimeRoot = resolve(option('--runtime-root', join(root, 'runtime')));")
  .replace("const runRoot = join(root, 'docs/artifacts/goal-actual-checkpoint-upgrade-final-20261008');", "const runRoot = join(dirname(output), 'goal-upgrade-' + new Date().toISOString().replace(/[-:.]/gu, ''));")
  .replace("const upstream = JSON.parse(await readFile('C:/Users/User/AppData/Local/hmCodex/model-config.json', 'utf8'));", "const upstream = JSON.parse(await readFile(resolve(liveConfig), 'utf8'));\nconst { active, strong } = resolveUpgradeModels(upstream, { activeModel: option('--active-model'), strongModel: option('--strong-model') });\nconst pricing = async (config, path) => {\n  if (path) return JSON.parse(await readFile(resolve(path), 'utf8'));\n  const isGo = /opencode\\.ai\\/zen\\/go\\//u.test(config.endpoint ?? config.baseURL ?? '');\n  const file = config.model === 'mimo-v2.6-flash' ? 'goal-pricing-opencode-go-flash.json' : config.model === 'mimo-v2.6-pro' ? 'goal-pricing-opencode-go.json' : null;\n  return isGo && file ? JSON.parse(await readFile(join(root, 'desktop/scripts', file), 'utf8')) : {};\n};")
  .replace("const flash = await startGoalLiveGateway({ ...upstream, model: 'mimo-v2.6-flash' }, JSON.parse(await readFile(join(root, 'desktop/scripts/goal-pricing-opencode-go-flash.json'), 'utf8')));", "const flash = await startGoalLiveGateway(active, await pricing(active, option('--active-pricing-config')));")
  .replace("const pro = await startGoalLiveGateway({ ...upstream, model: 'mimo-v2.6-pro' }, JSON.parse(await readFile(join(root, 'desktop/scripts/goal-pricing-opencode-go.json'), 'utf8')));", "const pro = await startGoalLiveGateway(strong, await pricing(strong, option('--strong-pricing-config')));")
  .replace("const marker = 'GOAL_ACTUAL_CHECKPOINT_UPGRADE_20261008';", "const marker = 'GOAL_ACTUAL_CHECKPOINT_UPGRADE_' + Date.now().toString(16);")
  .replace("currentWorkspaceBuild: true", "currentWorkspaceBuild: runtimeRoot === join(root, 'runtime')")
  .replace("Actual registered", "Actual registered")
  .replace("await writeFile(join(root, 'docs/artifacts/GOAL_ACTUAL_CHECKPOINT_UPGRADE_FINAL_2026-10-08.json'), JSON.stringify(report, null, 2), { flag: 'wx' });", "await writeFile(output, JSON.stringify({ ...report, evidenceDirectory: runRoot }, null, 2), { flag: 'wx' });");
if (source.includes('C:/Users/User') || source.includes("model: 'mimo-v2.6-flash'") || source.includes('GOAL_ACTUAL_CHECKPOINT_UPGRADE_FINAL_2026-10-08.json')) throw Error('UPGRADE_PORT_RETAINED_MACHINE_SPECIFIC_CONFIGURATION');
const start = source.indexOf('const root =');
const imports = source.slice(0, start), body = source.slice(start);
source = imports + 'export const runGoalUpgradeHarness = async () => {\n' + body + '\n};\n'
  + "if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runGoalUpgradeHarness().catch(error => { console.error(error.message); process.exitCode = 1; });\n";
await writeFile('desktop/scripts/goal-upgrade-harness.mjs', source, { flag: 'wx' });
console.log('Ported validated real checkpoint/explicit upgrade workflow into reusable repository test entry.');
