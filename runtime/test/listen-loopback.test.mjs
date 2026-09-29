import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isFetchBlockedPort, listenOnFetchablePort } from './helpers/listen-loopback.mjs';

test('the fetch-blocked port set matches what undici actually refuses', async () => {
  assert.equal(isFetchBlockedPort(6000), true);
  assert.equal(isFetchBlockedPort(6666), true);
  assert.equal(isFetchBlockedPort(10080), true);
  assert.equal(isFetchBlockedPort(49152), false);
  assert.equal(isFetchBlockedPort(0), true);

  // Real evidence, not a restatement of the table: fetch fails with
  // `cause: bad port` for a listed port and with a connection error for a port
  // that is merely closed.
  await assert.rejects(
    () => fetch('http://127.0.0.1:6000/', { signal: AbortSignal.timeout(2_000) }),
    (error) => error?.cause?.message === 'bad port'
  );
  await assert.rejects(
    () => fetch('http://127.0.0.1:49999/', { signal: AbortSignal.timeout(2_000) }),
    (error) => error?.cause?.message !== 'bad port'
  );
});

test('listenOnFetchablePort never hands a fetch-blocked port to a provider', async (t) => {
  const server = createServer((_request, response) => response.end('ok'));
  t.after(() => server.close());
  const seen = [];
  for (let i = 0; i < 25; i += 1) {
    // A fresh server per iteration mirrors how the model tests are written.
    const current = createServer((_request, response) => response.end('ok'));
    const port = await listenOnFetchablePort(current);
    seen.push(port);
    assert.equal(isFetchBlockedPort(port), false, `port ${port} is blocked by fetch`);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), 'ok');
    await new Promise((resolve) => current.close(resolve));
  }
  assert.equal(seen.length, 25);
});
