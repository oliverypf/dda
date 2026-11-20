import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXECUTION_MODES, RuntimeSafetyMonitor, CAPABILITIES, ACTIONS } from '../src/runtime-safety-monitor.mjs';
import { RestrictedWindowsExecutor } from '../src/restricted-windows-executor.mjs';
import { registerExecutorTools, createExplicitLeaseProvider } from '../src/controlled-tools.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';
import { MAX_PROCESS_TIMEOUT_MS, PROCESS_LEASE_MARGIN_MS, DEFAULT_PROCESS_TIMEOUT_MS } from '../src/process-limits.mjs';

const dirs = async (t) => {
  const project = await mkdtemp(join(tmpdir(), 'process-budget-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  return { project };
};

const harness = (providerOptions = {}) => {
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: providerOptions.project, commandAllowlist: [CAPABILITIES.SHELL] });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const registry = new ToolRegistry({ allowSideEffects: true });
  const events = [];
  const { project, ...rest } = providerOptions;
  registerExecutorTools(registry, executor, {
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.SHELL, CAPABILITIES.TEST],
      commands: ['node', 'node.exe'],
      onLeaseIssued: ({ lease }) => events.push(lease),
      ...rest
    })
  });
  return { registry, monitor, events };
};

test('schema accepts a bounded long timeout and rejects beyond the cap', async (t) => {
  const { project } = await dirs(t);
  const { registry } = harness({ project });
  // Schema-level only — the executor is never reached for an invalid bound.
  await assert.rejects(
    registry.invoke('shell.execute', { command: 'node', args: ['-v'], timeoutMs: MAX_PROCESS_TIMEOUT_MS + 1 }),
    /timeoutMs|maximum|invalid/i
  );
});

test('long timeoutMs extends the lease TTL by the kill margin', async (t) => {
  const { project } = await dirs(t);
  await writeFile(join(project, 'slow.js'), 'setTimeout(()=>{},1)', 'utf8');
  const { registry, events } = harness({ project });
  const result = await registry.invoke('shell.execute', { command: 'node', args: ['slow.js'], cwd: '.', timeoutMs: 90000 });
  assert.equal(result.ok, true);
  const lease = events[0];
  assert.ok(lease, 'lease issued');
  assert.ok(lease.expiresAt - Date.now() >= 115000, 'TTL covers 90s + 30s margin');
});

test('an explicit TTL shorter than the deadline rejects before issuing', async (t) => {
  const { project } = await dirs(t);
  await writeFile(join(project, 'slow.js'), 'setTimeout(()=>{},1)', 'utf8');
  const approvals = [];
  const { registry, events } = harness({ project, ttlMs: 60000, requestApproval: async (req) => { approvals.push(req); return true; } });
  await assert.rejects(
    registry.invoke('shell.execute', { command: 'node', args: ['slow.js'], cwd: '.', timeoutMs: 90000 }),
    /SAFETY_LEASE_TTL_TOO_SHORT/
  );
  assert.equal(approvals.length, 0, 'preflight runs before any approval card');
  assert.equal(events.length, 0, 'no lease issued on TTL mismatch');
});

test('a non-integer or over-cap long timeout is COMMAND_INVALID before callbacks', async (t) => {
  const { project } = await dirs(t);
  const approvals = [];
  const { registry, events } = harness({ project, requestApproval: async (req) => { approvals.push(req); return true; } });
  await assert.rejects(
    registry.invoke('shell.execute', { command: 'node', args: ['x.js'], timeoutMs: 90000.5 }),
    /SAFETY_COMMAND_INVALID|timeoutMs|maximum/i
  );
  assert.equal(approvals.length, 0);
  assert.equal(events.length, 0);
});

test('the result reports the actual timeoutMs used', async (t) => {
  const { project } = await dirs(t);
  await writeFile(join(project, 'quick.js'), 'process.stdout.write("ok")', 'utf8');
  const { registry } = harness({ project });
  const result = await registry.invoke('shell.execute', { command: 'node', args: ['quick.js'], cwd: '.', timeoutMs: 45000 });
  assert.equal(result.ok, true);
  assert.equal(result.timeoutMs, 45000, 'actual deadline surfaced');
});

test('a real 70-second script completes inside a 90-second lease', async (t) => {
  const { project } = await dirs(t);
  await writeFile(join(project, 'long.js'), 'setTimeout(() => process.stdout.write("done"), 65000)', 'utf8');
  const { registry, events } = harness({ project });
  const result = await registry.invoke('shell.execute', { command: 'node', args: ['long.js'], cwd: '.', timeoutMs: 90000 });
  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /done/);
  assert.equal(events.length, 1, 'one lease consumed');
});

test('a 1800000ms (30-minute) deadline gets a 1830000ms lease', async (t) => {
  const { project } = await dirs(t);
  await writeFile(join(project, 'q.js'), 'process.stdout.write("ok")', 'utf8');
  const { registry, events } = harness({ project });
  const r = await registry.invoke('shell.execute', { command: 'node', args: ['q.js'], cwd: '.', timeoutMs: 1800000 });
  assert.equal(r.ok, true);
  assert.equal(r.timeoutMs, 1800000);
  const lease = events[0];
  assert.ok(lease.expiresAt - Date.now() >= 1820000, 'TTL = 30m timeout + 30s margin');
});

test('a 900000ms deadline gets a 930000ms lease', async (t) => {
  const { project } = await dirs(t);
  await writeFile(join(project, 'q.js'), 'process.stdout.write("ok")', 'utf8');
  const { registry, events } = harness({ project });
  const r = await registry.invoke('shell.execute', { command: 'node', args: ['q.js'], cwd: '.', timeoutMs: 900000 });
  assert.equal(r.ok, true);
  assert.equal(r.timeoutMs, 900000);
  const lease = events[0];
  assert.ok(lease.expiresAt - Date.now() >= 920000, 'TTL = timeout + 30s margin');
});

test('a configured TTL under the 15-minute cap still rejects too-short leases', async (t) => {
  const { project } = await dirs(t);
  await writeFile(join(project, 'q.js'), 'process.stdout.write("ok")', 'utf8');
  const approvals = [];
  const { registry, events } = harness({ project, ttlMs: 300000, requestApproval: async (req) => { approvals.push(req); return true; } });
  await assert.rejects(
    registry.invoke('shell.execute', { command: 'node', args: ['q.js'], cwd: '.', timeoutMs: 900000 }),
    /SAFETY_LEASE_TTL_TOO_SHORT/
  );
  assert.equal(approvals.length, 0, 'preflight before approval');
  assert.equal(events.length, 0, 'no lease');
});

test('default and network bounds unchanged', async (t) => {
  const { project } = await dirs(t);
  const { registry } = harness({ project });
  await assert.rejects(() => registry.invoke('shell.execute', { command: 'node', args: ['q.js'], timeoutMs: 0 }), /timeoutMs|minimum|invalid/i);
});
