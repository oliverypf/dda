import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { goalRequestCorrelation } from '../../desktop/scripts/goal-request-correlation.mjs';
const config = JSON.parse(await readFile('C:/Users/User/AppData/Local/hmCodex/model-config.json', 'utf8'));
const endpoint = config.endpoint ?? `${config.baseURL.replace(/\/$/u, '')}/chat/completions`;
const key = process.env[config.apiKeyEnv]?.trim();
if (!key) throw Error('EXISTING_PROVIDER_KEY_UNAVAILABLE');
const rows = [];
for (const model of ['mimo-v2.6-pro', 'mimo-v2.6-flash']) {
  const started = Date.now();
  try {
    const headers = { ...config.headers, 'content-type': 'application/json', authorization: `Bearer ${key}` };
    if (config.sessionHeader) headers[config.sessionHeader] = randomUUID();
    const response = await fetch(endpoint, { method: 'POST', headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 64, stream: false }), signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { /* no private error text is emitted */ }
    const code = data?.error?.code;
    rows.push({ model, status: response.status, wallMs: Date.now() - started, upstreamModel: data?.model ?? null,
      ...goalRequestCorrelation(response, data), usage: data?.usage ?? null,
      responseMessagePresent: Boolean(data?.choices?.[0]?.message),
      errorCode: typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(code) ? code : null,
      errorResponseChars: response.ok ? null : text.length, errorResponseSha256: response.ok ? null : createHash('sha256').update(text).digest('hex'), actualCost: null });
  } catch (error) { rows.push({ model, error: error.name, transportCode: error.cause?.code ?? null, wallMs: Date.now() - started, actualCost: null }); }
  console.log(JSON.stringify(rows.at(-1)));
}
await writeFile('docs/artifacts/GOAL_MODEL_AVAILABILITY_2026-10-08.json', JSON.stringify({ checkedAt: new Date().toISOString(),
  method: 'Minimal same-account configured provider requests. Private headers and error bodies are excluded.',
  limitation: 'Availability probes are not task recovery, model upgrading, economic comparisons or invoices.', rows }, null, 2), { flag: 'wx' });
