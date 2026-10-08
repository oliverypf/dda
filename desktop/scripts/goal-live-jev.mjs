// Record actual decision-provider usage without giving its credential to the
// agent process or its tools. Answers are forwarded unchanged, never selected.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { listenOnFetchablePort } from '../../runtime/test/helpers/listen-loopback.mjs';
import { validateGoalPricing } from './goal-measurements.mjs';
import { goalRequestCorrelation } from './goal-request-correlation.mjs';

export const startGoalLiveJev = async ({ apiKeyEnv = 'JEV_API_KEY', endpoint = 'https://api.typesafe.ai/v1/systemone', fetchImpl = globalThis.fetch } = {}) => {
  const apiKey = process.env[apiKeyEnv]?.trim();
  if (!apiKey) throw Error('LIVE_JEV_KEY_MISSING');
  const pricing = validateGoalPricing(JSON.parse(await readFile(new URL('./goal-pricing-jev.json', import.meta.url), 'utf8')));
  let active;
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    let record;
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    controllers.add(controller);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.headers.authorization !== 'Bearer goal-jev-local-key') throw Error('LOCAL_JEV_UNAUTHORIZED');
      const context = active;
      if (!context || context.requests.length >= 40) throw Error('JEV_CALL_BUDGET_REACHED');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      record = { sequence: context.requests.length + 1, body, startedAt: new Date().toISOString(), actualCost: null };
      context.requests.push(record);
      const upstream = await fetchImpl(endpoint, { method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${apiKey}`
      }, body: JSON.stringify(body), signal: controller.signal });
      record.status = upstream.status;
      Object.assign(record, goalRequestCorrelation(upstream, null));
      const raw = await upstream.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { /* invalid data remains invalid */ }
      Object.assign(record, goalRequestCorrelation(upstream, payload));
      Object.assign(record, { response: payload ?? null, upstreamModel: payload?.model ?? null,
        rawUsage: payload?.usage ?? null,
        estimatedCost: Number.isInteger(payload?.usage?.input_tokens) && payload.usage.input_tokens >= 0
          ? payload.usage.input_tokens * pricing.inputPerMillion / 1e6 : null,
        pricing, completedAt: new Date().toISOString() });
      if (!res.destroyed) { res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(raw); }
    } catch (error) {
      if (record) Object.assign(record, { error: error.code ?? error.name, completedAt: new Date().toISOString() });
      if (!res.destroyed) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'LIVE_JEV_PROXY_FAILED' })); }
    } finally {
      if (record) record.wallMs = performance.now() - startedAt;
      clearTimeout(timeout); controllers.delete(controller);
    }
  });
  const port = await listenOnFetchablePort(server);
  return { endpoint: `http://127.0.0.1:${port}/jev`, upstreamEndpoint: endpoint, privateEnvKeys: [apiKeyEnv],
    begin() { active = { requests: [] }; return active; },
    async close() {
      for (const controller of controllers) controller.abort();
      const closed = new Promise(done => server.close(done));
      server.closeAllConnections();
      await closed;
    }
  };
};
