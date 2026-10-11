import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNodeVersion, parseNodeMajor, MINIMUM_NODE_MAJOR } from '../src/node-check.mjs';
import { main } from '../src/main.mjs';

const capture = () => ({ text: '', write(chunk) { this.text += chunk; return true; } });

test('parseNodeMajor reads the major from a version string', () => {
  assert.equal(parseNodeMajor('v24.21.0'), 24);
  assert.equal(parseNodeMajor('22.14.0'), 22);
  assert.equal(parseNodeMajor('v18.20.8'), 18);
  assert.equal(parseNodeMajor('garbage'), undefined);
});

test('checkNodeVersion accepts Node 24 and rejects older runtimes', () => {
  assert.deepEqual(checkNodeVersion(`v${MINIMUM_NODE_MAJOR}.0.0`), { ok: true, major: MINIMUM_NODE_MAJOR });
  assert.equal(checkNodeVersion('v25.1.0').ok, true);
  const old = checkNodeVersion('v22.14.0');
  assert.equal(old.ok, false);
  assert.equal(old.code, 'DEPENDENCY_ERROR');
  assert.equal(old.detected, 'v22.14.0');
  assert.equal(old.required, '>=24.0.0');
});

test('main fails with DEPENDENCY_ERROR before touching the runtime on old Node', async () => {
  const stdout = capture();
  const stderr = capture();
  // A command that would otherwise spawn the sqlite-backed runtime child.
  const code = await main(['health', '--format', 'jsonl'], {
    stdout, stderr, env: {}, isTTY: false, disableSignals: true, nodeVersion: 'v22.14.0'
  });
  assert.equal(code, 10);
  const payload = JSON.parse(stdout.text);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'DEPENDENCY_ERROR');
  assert.equal(payload.detected, 'v22.14.0');
  assert.equal(payload.required, '>=24.0.0');
});

test('the DEPENDENCY_ERROR is human-readable without --format', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await main(['health'], {
    stdout, stderr, env: {}, isTTY: true, disableSignals: true, nodeVersion: 'v20.0.0'
  });
  assert.equal(code, 10);
  assert.match(stderr.text, /DEPENDENCY_ERROR/u);
  assert.match(stderr.text, /Node\.js 24/u);
  assert.equal(stdout.text, '');
});
