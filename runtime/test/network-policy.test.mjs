import test from 'node:test';
import assert from 'node:assert/strict';
import { networkUrlForReview, resolveApprovedNetworkTargets } from '../src/network-policy.mjs';

const parseTargets = (value) => {
  if (value === undefined || String(value).trim() === '') return [];
  return JSON.parse(value);
};

test('omitted targets with network.request open public internet', () => {
  assert.deepEqual(resolveApprovedNetworkTargets({
    explicitValue: undefined,
    capabilities: ['shell.execute', 'network.request'],
    parseTargets
  }), [{ host: '*' }]);
});

test('an explicit empty list stays closed even when network is requested', () => {
  assert.deepEqual(resolveApprovedNetworkTargets({
    explicitValue: '[]',
    capabilities: ['network.request'],
    parseTargets
  }), []);
});

test('omission without the network capability stays closed', () => {
  assert.deepEqual(resolveApprovedNetworkTargets({
    explicitValue: undefined,
    capabilities: ['shell.execute'],
    parseTargets
  }), []);
});

test('URL review receives the destination and path without credentials, query values or fragments', () => {
  assert.equal(networkUrlForReview('network.request', {
    host: 'EXAMPLE.test', port: 8443, path: '/docs?ticket=secret#heading', body: 'secret body'
  }), 'https://example.test:8443/docs');
  assert.equal(networkUrlForReview('browser.open', {
    url: 'https://user:password@example.test/docs?ticket=secret#heading'
  }), 'https://example.test/docs');
});

test('non-HTTP, malformed and private destinations are left for host validation', () => {
  for (const url of ['file:///password', 'http://127.0.0.1/', 'http://[::1]/', 'http://dev.internal/', 'not-a-url']) {
    assert.equal(networkUrlForReview('browser.open', { url }), undefined, url);
  }
  assert.equal(networkUrlForReview('network.request', { host: 'example.test/path' }), undefined);
  assert.equal(networkUrlForReview('network.request', { host: '169.254.169.254' }), undefined);
  assert.equal(networkUrlForReview('shell.execute', { url: 'https://example.test' }), undefined);
});
