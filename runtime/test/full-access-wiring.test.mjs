import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { FULL_ACCESS_PATH_GUIDANCE } from '../src/access-mode-instructions.mjs';
import { createRuleVerifier } from '../src/rule-verifier.mjs';

const dirs = async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'full-access-wiring-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'external.txt'), 'external-content');
  await writeFile(join(project, 'local.txt'), 'local-content');
  return { base, project, outside };
};

test('ReadonlyWorkspace honors a live FULL_ACCESS callback and revokes dynamically', async (t) => {
  const { outside, project } = await dirs(t);
  const mode = { value: 'REQUIRE_APPROVAL' };
  const ws = new ReadonlyWorkspace(project, { getAccessMode: () => mode.value });
  await assert.rejects(() => ws.read(join(outside, 'external.txt')), /WORKSPACE_|SAFETY_/);
  mode.value = 'FULL_ACCESS';
  const read = await ws.read(join(outside, 'external.txt'));
  assert.equal(read.content.includes('external-content'), true);
  const list = await ws.list(outside);
  assert.ok(list.entries.some((e) => e.path.endsWith('external.txt')));
  mode.value = 'REQUIRE_APPROVAL';
  await assert.rejects(() => ws.read(join(outside, 'external.txt')), /WORKSPACE_|SAFETY_/);
});

test('rule verifier does not treat outside paths as a failed check', async (t) => {
  const { outside, project } = await dirs(t);
  const file = join(outside, 'external.txt');
  for (const actions of [
    [{ id: 'a1', state: 'SUCCEEDED', path: file }],
    [{ id: 'a1', state: 'SUCCEEDED', path: join(outside, 'other.txt') }]
  ]) {
    const report = createRuleVerifier().verify({
      output: 'wrote file',
      workspace: { granted: true, root: project, snapshotDigest: 'x' },
      actions,
      authorizedFilePaths: [file]
    });
    assert.equal(report.status, 'PASS');
    assert.equal(report.checks.find((check) => check.id === 'paths.scope'), undefined);
  }
});

test('task-runner reads an outside absolute path only under USER_FILESYSTEM', async (t) => {
  const { outside, project } = await dirs(t);
  const { Context } = await import('@deepseek-ai/cordis');
  const { ToolRegistry, toolRegistryPlugin, registerReadonlyWorkspaceTools } = await import('../src/tool-registry.mjs');
  const { cordisPlugin } = await import('../src/plugins/cordis-plugin.mjs');
  const { taskRunnerPlugin } = await import('../src/plugins/task-runner.mjs');
  const { FULL_ACCESS_SYSTEM_INSTRUCTION, WORKSPACE_SYSTEM_INSTRUCTION } = await import('../src/access-mode-instructions.mjs');
  const runOnce = async (filesystemAccess, mode) => {
    const registry = new ToolRegistry({ allowSideEffects: true });
    registerReadonlyWorkspaceTools(registry, new ReadonlyWorkspace(project, { getAccessMode: () => mode }));
    const root = new Context();
    t.after(() => root.fiber.dispose());
    const events = [];
    const requests = [];
    let round = 0;
    await root.plugin(toolRegistryPlugin(registry));
    await root.plugin(cordisPlugin((ctx) => ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'wiring',
      async *stream(request) {
        requests.push(request);
        round += 1;
        if (round === 1) {
          yield { type: 'tool-call', id: 'r1', name: 'workspace.read', arguments: JSON.stringify({ path: join(outside, 'external.txt') }) };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'text-delta', text: 'Observed external file.' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }), 'wiring-fixture'));
    await root.plugin(taskRunnerPlugin);
    const result = await root.taskRunner.run({
      prompt: 'read the file', mode: 'CONTROLLED',
      workspace: { granted: true, root: project, rootLabel: project, snapshotDigest: `sha256:${'ab'.repeat(32)}`, entries: [], sections: [] },
      filesystemAccess,
      onEvent: (event) => events.push(event)
    }).then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: e }));
    return { result, events, requests };
  };

  // FULL: outside read succeeds, model sees the real content + FULL text.
  const full = await runOnce('USER_FILESYSTEM', 'FULL_ACCESS');
  assert.equal(full.result.ok, true, 'FULL run completes');
  assert.equal(full.result.value.text, 'Observed external file.');
  const readResult = full.events.find((e) => e.kind === 'tool.result' && e.id === 'r1');
  assert.equal(readResult?.ok, true, 'outside read succeeded');
  // The tool-result message fed back to the model must carry the real file
  // content — that is the actual proof the outside read executed.
  assert.equal(JSON.stringify(full.requests[1]).includes('external-content'), true, 'real outside content reached the model');
  assert.equal(full.requests.length, 2);
  assert.equal(full.requests[0].system, FULL_ACCESS_SYSTEM_INSTRUCTION, 'exact FULL system instruction used');
  assert.match(full.requests[0].system, /evidence-driven agent/);

  // WORKSPACE: the outside read is denied at the guard.
  const denied = await runOnce('WORKSPACE', 'REQUIRE_APPROVAL');
  assert.equal(denied.requests[0]?.system, WORKSPACE_SYSTEM_INSTRUCTION, 'workspace mode keeps the narrower instruction');
  const deniedResult = denied.events.find((e) => e.kind === 'tool.result' && e.id === 'r1');
  assert.ok(deniedResult == null || deniedResult.ok === false || /WORKSPACE_|SAFETY_/.test(JSON.stringify(deniedResult)),
    'outside read denied under WORKSPACE mode');
  assert.ok(!JSON.stringify(denied.events).includes('external-content'), 'no outside content leaked');
});

test('missing non-write throws NOT_FOUND, EACCES never masquerades', async () => {
  const { resolveAuthorizedPath } = await import('../src/filesystem-access.mjs');
  const fakeLstat = (missingTarget) => async (p) => {
    if (p.endsWith(missingTarget)) { const e = new Error('no'); e.code = 'ENOENT'; throw e; }
    return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  };
  const missing = await resolveAuthorizedPath('nope.txt', {
    workspaceRoot: 'C:/proj', getAccessMode: () => 'FULL_ACCESS',
    lstatImpl: fakeLstat('nope.txt'),
    realpathImpl: async (p) => p,
    statImpl: async () => ({ isDirectory: () => true })
  }).then(() => 'ok', (e) => e);
  assert.equal(missing?.code, 'SAFETY_WORKSPACE_NOT_FOUND');
  const denied = await resolveAuthorizedPath('locked.dat', {
    workspaceRoot: 'C:/proj', getAccessMode: () => 'FULL_ACCESS',
    lstatImpl: async (p) => {
      if (p.endsWith('locked.dat')) { const e = new Error('denied'); e.code = 'EACCES'; throw e; }
      return { isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
    },
    realpathImpl: async (p) => p,
    statImpl: async () => ({ isDirectory: () => true })
  }).then(() => 'ok', (e) => e);
  assert.equal(denied?.code, 'EACCES', 'EACCES propagates, never masquerades as missing');
});

test('resident kernel worker reads outside only with enableUserFileAccess + live grant', async (t) => {
  if (process.platform !== 'win32') return;
  const { createResidentKernel } = await import('../src/kernel/resident-kernel.mjs');
  const { createSessionStateStore } = await import('../src/kernel/session-state.mjs');
  const base = await mkdtemp(join(tmpdir(), 'kernel-fa-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cfg = join(base, 'hmCodex');
  await mkdir(cfg, { recursive: true });
  const ws = join(base, 'ws'); const out = join(base, 'out');
  await mkdir(ws); await mkdir(out);
  await writeFile(join(out, 'k.txt'), 'kernel-outside');
  const policyPath = join(cfg, 'computer-access.json');
  const setMode = (m) => writeFile(policyPath, JSON.stringify({ version: 1, scope: 'USER_FILESYSTEM', mode: m, updatedAtMs: Date.now() }), 'utf8');
  await setMode('FULL_ACCESS');
  const env = { ...process.env, LOCALAPPDATA: base, APPDATA: base, DDA_PLATFORM: 'windows-cli' };
  const sessionStore = createSessionStateStore({ storagePath: join(base, 'session'), sessionId: `s-${Date.now()}` });
  const kernel = createResidentKernel({ workspaceRoot: ws, excludedPaths: [], enableUserFileAccess: true, sessionId: `s-${Date.now()}`, sessionStore, env });
  t.after(() => kernel.stop().catch(() => {}));
  try {
    await kernel.start();
    const read = await kernel.request('workspace.read', { path: join(out, 'k.txt') });
    assert.equal(JSON.stringify(read).includes('kernel-outside'), true);
    await setMode('REQUIRE_APPROVAL');
    const denied = await kernel.request('workspace.read', { path: join(out, 'k.txt') }).then(() => 'ok', (e) => e);
    assert.ok(denied !== 'ok' && /WORKSPACE_|SAFETY_|denied|forbidden/i.test(String(denied?.message ?? denied)));
  } catch (e) {
    // If the worker cannot start or the env blocks the policy read, report
    // the actual error rather than mocking it away.
    assert.fail(`kernel worker fixture: ${e instanceof Error ? e.message : e}`);
  }
});

test('dangerous requests remain dangerous in both modes', async () => {
  const { assessRequestRisk } = await import('../src/controlled-tools.mjs');
  // Dangerous ops are dangerous in both modes — no auto path exists.
  for (const request of [
    { command: 'rm', args: ['C:/outside/x'] },
    { command: 'powershell.exe', args: ['-enc', 'AA'] },
    { command: 'node.exe', args: ['-e', '1'] },
    { command: 'format', args: ['D:'] }
  ]) {
    for (const accessMode of ['REQUIRE_APPROVAL', 'FULL_ACCESS']) {
      const risk = assessRequestRisk({ capability: 'shell.execute', request, workspaceRoot: 'C:/proj', accessMode });
      assert.equal(risk.dangerous, true, `${request.command} must stay dangerous in ${accessMode}`);
    }
  }
});
