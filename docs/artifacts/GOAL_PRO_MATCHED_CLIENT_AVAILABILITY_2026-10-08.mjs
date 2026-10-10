import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { goalRequestCorrelation } from '../../desktop/scripts/goal-request-correlation.mjs';
const config = JSON.parse(await readFile('C:/Users/User/AppData/Local/hmCodex/model-config.json', 'utf8'));
const key = process.env[config.apiKeyEnv]?.trim();
if (!key) throw Error('EXISTING_PROVIDER_KEY_UNAVAILABLE');
const headers = { ...config.headers, 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': 'hmCodex-goal-comparison/3.0' };
headers[config.sessionHeader ?? 'x-opencode-session'] = randomUUID();
const started = Date.now();
let row;
try {
  const response = await fetch(config.endpoint ?? `${config.baseURL.replace(/\/$/u, '')}/chat/completions`, { method: 'POST', headers,
    body: JSON.stringify({ model: 'mimo-v2.6-pro', messages: [{ role: 'user', content: 'For a bounded coding-agent connection check, reply only OK.' }], max_tokens: 128, stream: false }), signal: AbortSignal.timeout(30000) });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { }
  row = { status: response.status, wallMs: Date.now() - started, upstreamModel: data?.model ?? null, ...goalRequestCorrelation(response, data), usage: data?.usage ?? null,
    responseMessagePresent: Boolean(data?.choices?.[0]?.message), errorBodyChars: response.ok ? null : raw.length,
    errorBodySha256: response.ok ? null : createHash('sha256').update(raw).digest('hex'), actualCost: null };
} catch (error) { row = { error: error.name, transportCode: error.cause?.code ?? null, wallMs: Date.now() - started, actualCost: null }; }
const report = { checkedAt: new Date().toISOString(), model: 'mimo-v2.6-pro', userAgent: headers['user-agent'], stableSessionHeaderUsed: true,
  limitation: 'Independent availability request during the Flash batch; not a real model upgrade or comparative task result. Private response text and credentials excluded.', row };
await writeFile('docs/artifacts/GOAL_PRO_MATCHED_CLIENT_AVAILABILITY_2026-10-08.json', JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
