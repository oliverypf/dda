import http from 'node:http';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

const DEFAULT_HOST = 'us-east.gw.rayobyte.com';
const DEFAULT_PORT = 8000;
const TARGET_URL = 'https://ipinfo.io/json';
const TIMEOUT_MS = 60_000;
const ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([504, 552, 554, 557]);
const TERMINAL_STATUS = new Set([400, 407, 451, 551, 556]);

/**
 * Targeting options are appended to the password. The username is left unchanged
 * because a modifier on the username is treated as an unknown account.
 */
export const appendTargeting = (password, { country, session } = {}) => {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password is required');
  }
  const parts = [];
  if (country) {
    if (!/^[A-Za-z]{2}$/u.test(country)) throw new Error('country must be a 2-letter ISO code');
    parts.push(`country-${country.toUpperCase()}`);
  }
  if (session) {
    if (!/^[A-Za-z0-9]{1,16}$/u.test(session)) {
      throw new Error('session must be 1-16 letters or digits');
    }
    parts.push(`session-${session}`);
  }
  return parts.length === 0 ? password : `${password}-${parts.join('-')}`;
};

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const proxyError = (status, statusMessage) => {
  const error = new Error(`proxy CONNECT ${status}${statusMessage ? ` ${statusMessage}` : ''}`);
  error.status = status;
  error.terminal = TERMINAL_STATUS.has(status);
  error.retryable = RETRYABLE_STATUS.has(status);
  return error;
};

const resetError = (error) => {
  const code = error?.code;
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
};

const decodeChunked = (body) => {
  const out = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString('ascii').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    out.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(out);
};

const readHttpBody = (raw) => {
  const split = raw.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('incomplete HTTP response');
  const headerText = raw.subarray(0, split).toString('latin1');
  let body = raw.subarray(split + 4);
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const status = Number(/^HTTP\/\d+(?:\.\d+)?\s+(\d+)/u.exec(statusLine)?.[1] ?? 0);
  const headers = new Map();
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const encoding = headers.get('transfer-encoding') ?? '';
  if (encoding.toLowerCase().includes('chunked')) body = decodeChunked(body);
  else if (headers.has('content-length')) {
    const length = Number(headers.get('content-length'));
    if (Number.isFinite(length)) body = body.subarray(0, length);
  }
  return { status, body: body.toString('utf8') };
};

const requestOnce = ({ proxyHost, proxyPort, username, password }) => {
  const target = new URL(TARGET_URL);
  const targetPort = target.port || '443';
  const authorization = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };

    const req = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: {
        Host: `${target.hostname}:${targetPort}`,
        'Proxy-Authorization': `Basic ${authorization}`
      },
      timeout: TIMEOUT_MS
    });

    req.once('timeout', () => {
      req.destroy();
      const error = new Error('proxy timeout');
      error.code = 'ETIMEDOUT';
      error.retryable = true;
      finish(reject, error);
    });
    req.once('error', (error) => {
      error.retryable = error.retryable || resetError(error);
      finish(reject, error);
    });
    req.once('connect', (response, socket, head) => {
      const status = response.statusCode ?? 0;
      if (status !== 200) {
        socket.destroy();
        finish(reject, proxyError(status, response.statusMessage));
        return;
      }
      if (head?.length) socket.unshift(head);
      const secure = tls.connect({
        socket,
        servername: target.hostname,
        ALPNProtocols: ['http/1.1'],
        timeout: TIMEOUT_MS
      });
      const chunks = [];
      secure.once('secureConnect', () => {
        secure.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.hostname}\r\n` +
          'Accept: application/json\r\n' +
          'Connection: close\r\n\r\n'
        );
      });
      secure.on('data', (chunk) => chunks.push(chunk));
      secure.once('timeout', () => {
        secure.destroy();
        const error = new Error('tunnel timeout');
        error.code = 'ETIMEDOUT';
        error.retryable = true;
        finish(reject, error);
      });
      secure.once('error', (error) => {
        error.retryable = error.retryable || resetError(error);
        finish(reject, error);
      });
      secure.once('end', () => {
        try {
          const parsed = readHttpBody(Buffer.concat(chunks));
          if (parsed.status !== 200) {
            const error = new Error(`ipinfo HTTP ${parsed.status}`);
            error.status = parsed.status;
            finish(reject, error);
            return;
          }
          finish(resolve, parsed.body);
        } catch (error) {
          finish(reject, error);
        }
      });
    });
    req.end();
  });
};

export const fetchExitIdentity = async ({
  host = process.env.RAYOBYTE_HOST || DEFAULT_HOST,
  port = Number(process.env.RAYOBYTE_PORT || DEFAULT_PORT),
  username = process.env.RAYOBYTE_USER,
  password = process.env.RAYOBYTE_PASS,
  country = process.env.RAYOBYTE_COUNTRY,
  session = process.env.RAYOBYTE_SESSION
} = {}) => {
  if (!username || !password) {
    throw new Error('Set RAYOBYTE_USER and RAYOBYTE_PASS');
  }
  const proxyPassword = appendTargeting(password, { country, session });
  let lastError;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      const body = await requestOnce({
        proxyHost: host,
        proxyPort: port,
        username,
        password: proxyPassword
      });
      const data = JSON.parse(body);
      if (typeof data.ip !== 'string' || typeof data.country !== 'string') {
        throw new Error('ipinfo response did not include ip and country');
      }
      return { ip: data.ip, country: data.country };
    } catch (error) {
      lastError = error;
      if (error.terminal || attempt === ATTEMPTS - 1 || !error.retryable) throw error;
      await sleep(1000 * (2 ** attempt));
    }
  }
  throw lastError;
};

const readArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--country') options.country = argv[index += 1];
    else if (arg === '--session') options.session = argv[index += 1];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const args = readArgs(process.argv.slice(2));
  fetchExitIdentity(args).then(({ ip, country }) => {
    process.stdout.write(`ip: ${ip}\ncountry: ${country}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
