// Run after assembleHap: node entry/test/host/compiled-workbench-smoke.mjs [compiled Index.ts]
// Executes the business callbacks emitted by Hvigor. Rendering needs an ArkUI device.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileFunction } from 'node:vm';
import { loadArkTS } from './sdk-host.mjs';

const localRequire = createRequire(import.meta.url);
const ide = process.env.DEVECO_STUDIO_HOME ?? 'C:/Program Files/Huawei/DevEco Studio';
const ts = localRequire(join(ide, 'tools/hvigor/hvigor-ohos-plugin/node_modules/typescript'));
const file = process.argv[2] ?? 'entry/build/default/cache/default/default@CompileArkTS/esmodule/debug/entry/src/main/ets/pages/Index.ts';
const source = readFileSync(file, 'utf8');
assert(source.includes('executeManualCommand') && source.includes('stageStoredTurn'), 'Rebuild the current HAP before running this smoke test');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS } });
class ObservedValue {
  constructor(value) { this.value = value; }
  set(value) { this.value = value; }
  get() { return this.value; }
}
const image = { id: '833b60d8-0c57-4247-b4a7-7c0c474d56f8.png', name: '图.png', mime: 'image/png' };
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgBUAAAAASUVORK5CYII=';
const pageModule = specifier => {
  const name = specifier.match(/entry\/src\/main\/ets\/(.+)&$/)?.[1];
  if (['services/WorkbenchStore', 'models/CodexTypes', 'services/LocalImages',
    'services/LocalRoleOrchestrator', 'services/LocalCommandExecutor'].includes(name)) {
    return loadArkTS(name);
  }
  return {};
};
const Page = compileFunction(outputText + '\nreturn Index;', ['exports', 'require', 'ViewPU', 'registerNamedRoute',
  'ObservedPropertyObjectPU', 'ObservedPropertySimplePU'], { filename: file })({}, pageModule, class {}, () => {}, ObservedValue, ObservedValue);
const page = new Page(undefined, {});
const filesDir = await mkdtemp(join(tmpdir(), 'dda-page-'));
try {
  const { LocalWorkspace } = loadArkTS('services/LocalWorkspace');
  const { WorkbenchStore } = loadArkTS('services/WorkbenchStore');
  const { SessionEventKind } = loadArkTS('models/CodexTypes');
  const workspace = new LocalWorkspace({ filesDir });
  await workspace.initialize();
  await workspace.createFile('/my note', 'real local file');
  await mkdir(join(filesDir, 'chat-images'));
  await writeFile(join(filesDir, 'chat-images', image.id), Buffer.from(pixel, 'base64'));
  const store = new WorkbenchStore({ filesDir });
  const snapshots = [];
  let state;
  let resumed = 0;
  Object.assign(page, { workspace, pageActive: true, switching: false, hydrated: true, getUIContext: () => ({
    getHostContext: () => ({ filesDir }) }), store: { async save(snapshot) {
      await store.save(snapshot);
      snapshots.push(await store.load());
    } } });
  page.commandInput = 'cat "/my note"';
  await page.executeManualCommand();
  assert.equal(page.commandResult.stdout, 'real local file');
  assert.equal(page.model, '');
  page.model = 'task';
  page.messages = [{ id: 'prior', role: 'assistant', text: 'Earlier response' }];
  page.draftImages = [image];
  page.session = { currentThread: () => 'thread', selectThread() {}, async sendPrompt(prompt) {
    assert.equal(prompt, '');
    const task = snapshots.at(-1).current;
    assert.equal(task.runId, 'prepared-run');
    assert.equal(task.incomplete, true);
    assert.deepEqual(task.messages.at(-1).images, [image]);
  } };
  page.localTransport = { configure() {}, async latestCheckpoint() { return state; },
    prepareTurn(history, instructions, images) {
      assert.deepEqual(history.map(item => item.id), ['prior']);
      assert.deepEqual(images, ['data:image/png;base64,' + pixel]);
      return 'prepared-run';
    }, async verifyCheckpoint(thread, run, revision) {
      assert.deepEqual([thread, run, revision], ['thread', 'prepared-run', 3]);
      state = { ...state, pending: undefined, revision: 4 };
      return state;
    }, async resumeTurn(thread, prompt) { assert.deepEqual([thread, prompt], ['thread', '']); resumed++; } };
  await page.sendPrompt();
  const original = snapshots[0].current;
  state = { runId: 'prepared-run', revision: 3, role: 'executor-only', phase: 'execute', receipts: [],
    round: 1, pending: { tool: 'create_file', path: '/note', expectedHash: 'mock-digest' } };
  page.isBusy = false;
  await page.displayTask({ ...original, draft: 'unsent', queued: ['follow up'] });
  await page.sendPrompt(false, state);
  assert.equal(resumed, 0);
  await page.updateCheckpoint(state, true);
  assert.equal(resumed, 1);
  assert.equal(page.composer, 'unsent');
  assert.deepEqual(page.queued, ['follow up']);
  assert.equal(page.messages.filter(message => message.role === 'user').length, 1);
  page.handleSessionEvent({ kind: SessionEventKind.RoleActivity, id: 'role', text: '复核者正在检查执行结果' });
  assert.equal(page.messages.at(-1).title, '角色编排');
  state = { ...state, phase: 'done', round: 2, draft: 'Final answer' };
  await page.displayTask(original);
  assert.equal(page.messages.at(-1).text, 'Final answer');
  assert.equal(page.checkpointState, undefined);
  assert(!JSON.stringify(snapshots).includes('real local file'));
  console.log('Compiled page callbacks passed: manual command, durable submission, gated recovery, role activity and final-answer reconciliation.');
} finally {
  clearTimeout(page.saveTimer);
  await rm(filesDir, { recursive: true, force: true });
}
