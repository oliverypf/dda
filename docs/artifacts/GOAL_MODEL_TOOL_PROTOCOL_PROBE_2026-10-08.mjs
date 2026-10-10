import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { goalRequestCorrelation } from '../../desktop/scripts/goal-request-correlation.mjs';
const config = JSON.parse(await readFile('C:/Users/User/AppData/Local/hmCodex/model-config.json', 'utf8'));
const endpoint = config.endpoint ?? `${config.baseURL.replace(/\/$/u, '')}/chat/completions`;
const key = process.env[config.apiKeyEnv]?.trim();
if (!key) throw Error('EXISTING_PROVIDER_KEY_UNAVAILABLE');
const headers = { ...config.headers, 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': 'hmCodex-goal-comparison/3.0' };
headers[config.sessionHeader ?? 'x-opencode-session'] = randomUUID();
const model = 'mimo-v2.6-flash';
const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read the bounded task workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }];
const messages = [{ role: 'system', content: 'Use the provided workspace tool to inspect README.md, then report only its evidence marker. Do not invent file content.' }, { role: 'user', content: 'Read README.md and report the marker.' }];
const rows = [];
async function call(label, history, toolChoice) {
  const started = Date.now();
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ model, messages: history, tools, tool_choice: toolChoice, max_tokens: 1024, stream: false }), signal: AbortSignal.timeout(30000) });
    const raw = await response.text();
    let data; try { data = JSON.parse(raw); } catch { }
    const message = data?.choices?.[0]?.message;
    const reasoning = message?.reasoning_content;
    rows.push({ label, httpStatus: response.status, wallMs: Date.now() - started, upstreamModel: data?.model ?? null, ...goalRequestCorrelation(response, data), usage: data?.usage ?? null,
      toolCallCount: message?.tool_calls?.length ?? 0, reasoningPresent: typeof reasoning === 'string', reasoningChars: typeof reasoning === 'string' ? reasoning.length : null,
      reasoningSha256: typeof reasoning === 'string' ? createHash('sha256').update(reasoning).digest('hex') : null,
      markerObserved: String(message?.content ?? '').includes('GOAL_PROTOCOL_ACTUAL_READ'),
      errorBodyChars: response.ok ? null : raw.length, errorBodySha256: response.ok ? null : createHash('sha256').update(raw).digest('hex'), actualCost: null });
    console.log(JSON.stringify(rows.at(-1)));
    return response.ok ? message : null;
  } catch (error) {
    rows.push({ label, wallMs: Date.now() - started, error: error.name, actualCost: null });
    console.log(JSON.stringify(rows.at(-1)));
    return null;
  }
}
const first = await call('initial_tool_request', messages, { type: 'function', function: { name: 'read_file' } });
if (first?.tool_calls?.length === 1 && first.tool_calls[0].function?.name === 'read_file') {
  const args = JSON.parse(first.tool_calls[0].function.arguments);
  if (args.path !== 'README.md') throw Error('PROBE_REQUESTED_UNAUTHORIZED_FILE');
  const file = 'C:/Users/User/hmCodex-local/docs/artifacts/GOAL_PROTOCOL_README_2026-10-08.txt';
  await writeFile(file, 'GOAL_PROTOCOL_ACTUAL_READ\n', { flag: 'wx' });
  const result = { role: 'tool', tool_call_id: first.tool_calls[0].id, content: await readFile(file, 'utf8') };
  const stripped = { role: 'assistant', content: first.content ?? null, tool_calls: first.tool_calls };
  await call('tool_followup_omitting_reasoning', [...messages, stripped, result], 'none');
  await call('tool_followup_preserving_actual_reasoning', [...messages, first, result], 'none');
}
await writeFile('docs/artifacts/GOAL_MODEL_TOOL_PROTOCOL_PROBE_2026-10-08.json', JSON.stringify({ checkedAt: new Date().toISOString(), model,
  method: 'Same live provider, stable session and benchmark User-Agent. Subsequent histories differ only in preservation of the actual upstream assistant fields. Local file is genuinely read; no reasoning text or private headers persisted.',
  source: 'https://mimo.mi.com/docs/en-US/quick-start/usage-guide/other/deep-thinking',
  limitation: 'Three bounded protocol requests are diagnostic evidence, not comparative task results, model-upgrade proof or invoices.', rows }, null, 2), { flag: 'wx' });
