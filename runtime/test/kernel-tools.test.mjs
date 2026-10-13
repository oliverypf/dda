import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachResidentKernel, registerResidentKernelTools } from '../src/kernel/kernel-tools.mjs';
import { createToolRegistry, registerReadonlyWorkspaceTools } from '../src/tool-registry.mjs';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';

const KERNEL_TOOL_NAMES = [
  'kernel.workspace_list', 'kernel.workspace_read', 'kernel.workspace_focus',
  'kernel.session_get', 'kernel.session_list', 'kernel.session_set',
  'kernel.session_delete', 'kernel.host_request'
];

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'kernel-tools-'));
  await writeFile(join(root, 'README.md'), '# hello\nworld\n');
  return root;
};

const registryWithFallback = (root) => {
  const registry = createToolRegistry({ allowSideEffects: true });
  registerReadonlyWorkspaceTools(registry, new ReadonlyWorkspace(root));
  return registry;
};

test('falls back to discrete tools when the feature is disabled', async () => {
  const root = await workspace();
  const registry = registryWithFallback(root);
  const handle = await attachResidentKernel({
    registry, workspaceRoot: root, sessionId: 's', env: {}, platform: 'linux'
  });
  assert.equal(handle.attached, false);
  assert.equal(handle.availability.reason, 'DISABLED');
  const names = registry.list().map((tool) => tool.name);
  assert.ok(names.includes('workspace.read'));
  assert.equal(names.some((name) => name.startsWith('kernel.')), false);
  await handle.stop();
});

test('falls back on a non-Linux platform instead of failing', async () => {
  const root = await workspace();
  const registry = registryWithFallback(root);
  const handle = await attachResidentKernel({
    registry, workspaceRoot: root, sessionId: 's',
    env: { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'linux-cli' },
    platform: 'darwin',
    nodeVersion: 'v24.0.0'
  });
  assert.equal(handle.attached, false);
  assert.equal(handle.availability.reason, 'NON_LINUX_PLATFORM');
  assert.equal(registry.list().some((tool) => tool.name.startsWith('kernel.')), false);
  await handle.stop();
});

test('registers the kernel surface alongside the read-only fallback when available', async () => {
  const root = await workspace();
  const registry = registryWithFallback(root);
  const storagePath = join(root, '.state.json');
  const handle = await attachResidentKernel({
    registry, workspaceRoot: root, sessionId: 'sess', sessionStatePath: storagePath,
    env: { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'linux-cli' },
    platform: 'linux',
    nodeVersion: 'v24.0.0'
  });
  try {
    assert.equal(handle.attached, true);
    const names = registry.list().map((tool) => tool.name);
    for (const kernelTool of KERNEL_TOOL_NAMES) assert.ok(names.includes(kernelTool), kernelTool);
    // Discrete read-only workspace tools remain as a fallback surface.
    assert.ok(names.includes('workspace.read'));
    assert.ok(names.includes('workspace.focus'));

    const read = await registry.invoke('kernel.workspace_read', { path: 'README.md', maxChars: 7 });
    assert.equal(read.content, '# hello');
    await registry.invoke('kernel.session_set', { key: 'k', value: [1, 2, 3] });
    assert.deepEqual((await registry.invoke('kernel.session_get', { key: 'k' })).value, [1, 2, 3]);

    // Every kernel tool is read-only at the registry boundary.
    for (const tool of registry.list().filter((entry) => entry.name.startsWith('kernel.'))) {
      assert.equal(tool.readOnly, true, tool.name);
    }
  } finally {
    await handle.stop();
  }
});

test('surfaces the side-effect refusal through the tool error code', async () => {
  const root = await workspace();
  const registry = registryWithFallback(root);
  const handle = await attachResidentKernel({
    registry, workspaceRoot: root, sessionId: 'sess2',
    env: { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'linux-cli' },
    platform: 'linux',
    nodeVersion: 'v24.0.0'
  });
  try {
    await assert.rejects(
      registry.invoke('kernel.host_request', { kind: 'shell' }),
      (error) => error.code === 'KERNEL_SIDE_EFFECT_REFUSED'
    );
  } finally {
    await handle.stop();
  }
});

test('registerResidentKernelTools validates its arguments', () => {
  assert.throws(() => registerResidentKernelTools(null, { request() {} }), /KERNEL_TOOLS_REGISTRY_REQUIRED/);
  assert.throws(() => registerResidentKernelTools(createToolRegistry(), {}), /KERNEL_TOOLS_KERNEL_REQUIRED/);
});
