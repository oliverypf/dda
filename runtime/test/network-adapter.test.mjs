import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITIES,
  EXECUTION_MODES,
  RuntimeSafetyMonitor,
  RestrictedWindowsExecutor,
  SafetyError
} from '../src/safety-executor.mjs';
import { RestrictedNetworkAdapter } from '../src/restricted-network-adapter.mjs';
import { createExplicitLeaseProvider, registerExecutorTools } from '../src/controlled-tools.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';

const createMonitor = ({ networkTargets, workspaceRoot }) => new RuntimeSafetyMonitor({
  mode: EXECUTION_MODES.CONTROLLED,
  workspaceRoot,
  commandAllowlist: [],
  networkTargets
});

const temporaryWorkspace = (label) => mkdtemp(join(tmpdir(), `hmcodex-network-${label}-`));

const jsonResponse = (body, { status = 200 } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => JSON.stringify(body)
});

const fakeFetch = (handler) => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fetch.calls = calls;
  return fetch;
};

const networkTarget = { host: 'api.example.com', port: 443, scheme: 'https', methods: ['GET', 'POST'] };

test('network capability is denied without a one-shot lease', async () => {
  const workspaceRoot = await temporaryWorkspace('nolease');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch: fakeFetch(() => jsonResponse({ ok: true })), lookup: async () => [] });
  await assert.rejects(adapter.request({ host: 'api.example.com', method: 'GET' }), /SAFETY_LEASE_REQUIRED/);
});

test('an approved lease authorizes exactly one request to an allowed target', async () => {
  const workspaceRoot = await temporaryWorkspace('allowed');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const fetch = fakeFetch(() => jsonResponse({ status: 'healthy' }));
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [{ address: '93.184.216.34' }] });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  const result = await adapter.request({ host: 'api.example.com', method: 'GET', path: '/v1/health' }, { lease });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"status":"healthy"}');
  assert.equal(result.lease, lease.id);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://api.example.com:443/v1/health');
  assert.equal(fetch.calls[0].init.redirect, 'manual');
  assert.equal(lease.consumed, true);
  await assert.rejects(
    adapter.request({ host: 'api.example.com', method: 'GET' }, { lease: await (async () => {
      const expired = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget], ttlMs: 1 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return expired;
    })() }),
    (error) => error instanceof SafetyError && error.code === 'SAFETY_LEASE_EXPIRED'
  );
});

test('targets outside the lease and monitor scope are rejected before any request', async () => {
  const workspaceRoot = await temporaryWorkspace('scope');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const fetch = fakeFetch(() => jsonResponse({ ok: true }));
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [] });
  const unscopedLease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [{ host: 'other.example.com', methods: ['GET'] }] });
  await assert.rejects(adapter.request({ host: 'api.example.com', method: 'GET' }, { lease: unscopedLease }), /SAFETY_NETWORK_NOT_ALLOWED/);
  const scopedLease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  await assert.rejects(adapter.request({ host: 'api.example.com', method: 'GET', scheme: 'http' }, { lease: scopedLease }), /SAFETY_NETWORK_NOT_ALLOWED/);
  await assert.rejects(adapter.request({ host: 'api.example.com', method: 'DELETE' }, { lease: scopedLease }), /SAFETY_NETWORK_NOT_ALLOWED/);
  await assert.rejects(adapter.request({ host: 'api.example.com', method: 'BREW' }, { lease: scopedLease }), /SAFETY_NETWORK_INVALID/);
  await assert.rejects(adapter.request({ host: '127.0.0.1' }, { lease: scopedLease }), /SAFETY_NETWORK_TARGET_FORBIDDEN/);
  assert.equal(fetch.calls.length, 0);
});

test('credential-bearing headers are rejected before any request is sent', async () => {
  const workspaceRoot = await temporaryWorkspace('cred');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const fetch = fakeFetch(() => jsonResponse({ ok: true }));
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [] });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  await assert.rejects(
    adapter.request({ host: 'api.example.com', method: 'POST', headers: { Authorization: 'Bearer secret-token' } }, { lease }),
    /SAFETY_NETWORK_INVALID/
  );
  await assert.rejects(
    adapter.request({ host: 'api.example.com', method: 'POST', headers: { Cookie: 'session=secret' } }, { lease: monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] }) }),
    /SAFETY_NETWORK_INVALID/
  );
  assert.equal(fetch.calls.length, 0);
});

test('DNS resolution that maps to a private or metadata address fails closed', async () => {
  const workspaceRoot = await temporaryWorkspace('dns');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const fetch = fakeFetch(() => jsonResponse({ ok: true }));
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [{ address: '169.254.169.254' }] });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  await assert.rejects(adapter.request({ host: 'api.example.com', method: 'GET' }, { lease }), /SAFETY_NETWORK_RESOLVED_FORBIDDEN/);
  assert.equal(fetch.calls.length, 0);
  const failingAdapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [] });
  const secondLease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  await assert.rejects(failingAdapter.request({ host: 'api.example.com', method: 'GET' }, { lease: secondLease }), /SAFETY_NETWORK_RESOLVED_FORBIDDEN/);
});

test('redirect responses are blocked because a consumed lease cannot authorize the next hop', async () => {
  const workspaceRoot = await temporaryWorkspace('redirect');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const fetch = fakeFetch(() => ({ status: 302, ok: false, text: async () => '' }));
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [{ address: '93.184.216.34' }] });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  await assert.rejects(adapter.request({ host: 'api.example.com', method: 'GET' }, { lease }), /SAFETY_NETWORK_REDIRECT_FORBIDDEN/);
  assert.equal(fetch.calls.length, 1);
});

test('CRLF and control characters in header values are rejected as header injection', async () => {
  const workspaceRoot = await temporaryWorkspace('crlf');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const fetch = fakeFetch(() => jsonResponse({ ok: true }));
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [{ address: '93.184.216.34' }] });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  await assert.rejects(
    adapter.request({
      host: 'api.example.com',
      method: 'GET',
      headers: { 'X-Injected': 'ok\r\nHost: evil.example.com' }
    }, { lease }),
    /SAFETY_NETWORK_INVALID/
  );
  assert.equal(fetch.calls.length, 0);
});

test('a host that rebinds to a private address after the response fails closed', async () => {
  const workspaceRoot = await temporaryWorkspace('rebind');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const fetch = fakeFetch(() => jsonResponse({ secret: 'payload' }));
  const resolutions = [['93.184.216.34'], ['169.254.169.254']];
  const adapter = new RestrictedNetworkAdapter({
    monitor,
    fetch,
    lookup: async () => (resolutions.shift() ?? ['169.254.169.254'])
  });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  await assert.rejects(
    adapter.request({ host: 'api.example.com', method: 'GET' }, { lease }),
    /SAFETY_NETWORK_RESOLVED_FORBIDDEN/
  );
  assert.equal(fetch.calls.length, 1);
  assert.equal(lease.consumed, true);
});

test('oversized response bodies are truncated at the configured byte limit', async () => {
  const workspaceRoot = await temporaryWorkspace('cap');
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot,
    commandAllowlist: [],
    networkTargets: [networkTarget],
    maxOutputBytes: 16,
    maxOutputChars: 64
  });
  const payload = JSON.stringify({ data: 'x'.repeat(256) });
  const streamResponse = {
    status: 200,
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      }
    })
  };
  const fetch = fakeFetch(() => streamResponse);
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [{ address: '93.184.216.34' }] });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  const result = await adapter.request({ host: 'api.example.com', method: 'GET' }, { lease });
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.body, 'utf8') <= 16);
});

test('request timeouts abort the fetch and report a bounded failed outcome', async () => {
  const workspaceRoot = await temporaryWorkspace('timeout');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const fetch = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  }));
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [{ address: '93.184.216.34' }] });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.NETWORK], networkTargets: [networkTarget] });
  const result = await adapter.request({ host: 'api.example.com', method: 'GET', timeoutMs: 20 }, { lease });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.status, null);
});

test('concurrent requests are bounded and excess requests do not consume leases', async () => {
  const workspaceRoot = await temporaryWorkspace('concurrency');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const resolvers = [];
  const fetch = fakeFetch(() => new Promise((resolve) => resolvers.push(resolve)));
  const adapter = new RestrictedNetworkAdapter({
    monitor,
    fetch,
    lookup: async () => [{ address: '93.184.216.34' }],
    maxConcurrentRequests: 2
  });
  const leases = [1, 2, 3].map(() => monitor.issueLease({
    capabilities: [CAPABILITIES.NETWORK],
    networkTargets: [networkTarget]
  }));
  const active = [
    adapter.request({ host: 'api.example.com', method: 'GET' }, { lease: leases[0] }),
    adapter.request({ host: 'api.example.com', method: 'GET' }, { lease: leases[1] })
  ];
  while (fetch.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    adapter.request({ host: 'api.example.com', method: 'GET' }, { lease: leases[2] }),
    (error) => error instanceof SafetyError && error.code === 'SAFETY_NETWORK_CONCURRENCY_LIMIT'
  );
  assert.equal(leases[2].consumed, false);
  resolvers.forEach((resolve) => resolve(jsonResponse({ ok: true })));
  const results = await Promise.all(active);
  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.ok), true);
});

test('network tool registration stays behind the explicit lease provider', async () => {
  const workspaceRoot = await temporaryWorkspace('tool');
  const monitor = createMonitor({ workspaceRoot, networkTargets: [networkTarget] });
  const fetch = fakeFetch(() => jsonResponse({ ok: true }));
  const adapter = new RestrictedNetworkAdapter({ monitor, fetch, lookup: async () => [{ address: '93.184.216.34' }] });
  const registry = new ToolRegistry({ allowSideEffects: true });
  let approved = true;
  registerExecutorTools(registry, new RestrictedWindowsExecutor({ monitor }), {
    networkAdapter: adapter,
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.NETWORK],
      networkTargets: [networkTarget],
      requestApproval: async () => approved
    })
  });
  assert.deepEqual(registry.list().filter((tool) => tool.name === 'network.request').map((tool) => tool.readOnly), [false]);
  const result = await registry.invoke('network.request', { host: 'api.example.com', method: 'GET' });
  assert.equal(result.ok, true);
  approved = false;
  await assert.rejects(registry.invoke('network.request', { host: 'api.example.com', method: 'GET' }), /SAFETY_LEASE_REQUIRED/);
});
