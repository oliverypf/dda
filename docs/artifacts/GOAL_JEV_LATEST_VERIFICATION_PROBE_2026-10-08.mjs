import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const path = 'docs/artifacts/goal-actual-checkpoint-upgrade-retest-20261008/resume-with-bound-pro-jev-requests.json';
const records = JSON.parse(await readFile(path, 'utf8'));
const body = records.findLast(record => record.body?.questions?.verification)?.body;
if (!body || !process.env.JEV_API_KEY?.trim()) throw Error('ACTUAL_VERIFICATION_AND_CREDENTIAL_REQUIRED');
const started = Date.now();
let observation;
try {
  const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${process.env.JEV_API_KEY}`
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { }
  observation = { status: response.status, wallMs: Date.now() - started, answers: response.ok ? data?.answers ?? null : null,
    usage: data?.usage ?? null, model: data?.model ?? null, errorBodyChars: response.ok ? null : raw.length,
    errorBodySha256: response.ok ? null : createHash('sha256').update(raw).digest('hex'), actualCost: null };
} catch (error) { observation = { error: error.name, wallMs: Date.now() - started, actualCost: null }; }
const report = { checkedAt: new Date().toISOString(), source: path, method: 'One unchanged archived actual verification state. Actual prior failure and actual Pro success remain included. No model/executor is retried and no provider answer is replaced.',
  limitation: 'Availability/semantic replay only, not a new successful runtime task or invoice.', observation };
await writeFile('docs/artifacts/GOAL_JEV_LATEST_VERIFICATION_PROBE_2026-10-08.json', JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
