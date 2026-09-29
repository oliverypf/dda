import { once } from 'node:events';

// The Fetch standard blocks a fixed set of ports. Windows can be configured
// with a TCP dynamic port range that starts at 1024 (see
// `netsh int ipv4 show dynamicport tcp`), so an ephemeral `listen(0)` bind can
// legitimately receive one of those ports. undici then refuses the request with
// `TypeError: fetch failed` / `cause: bad port`, which makes every test that
// points a model provider at `server.address().port` fail for a purely
// environmental reason. Rebinding until the assigned port is usable keeps the
// test deterministic without weakening what it asserts.
// https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080
]);

export const isFetchBlockedPort = (port) => FETCH_BLOCKED_PORTS.has(Number(port));

/**
 * Bind `server` to a fetch-usable 127.0.0.1 port.
 *
 * The caller keeps using `server.address().port` afterwards; this only replaces
 * the `server.listen(0, '127.0.0.1'); await once(server, 'listening');` pair.
 */
export const listenOnFetchablePort = async (server, { attempts = 40 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : undefined;
    if (!isFetchBlockedPort(port)) return port;
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error('unable to bind a fetch-usable loopback port');
};
