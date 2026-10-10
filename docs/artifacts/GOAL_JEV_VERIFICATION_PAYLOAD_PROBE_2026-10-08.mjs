import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const path = 'docs/artifacts/agent-goal-runs/20261007T162508744Z-b72917fe/2-inspect-readme-001-hmcodex-runtime/jev-requests.json';
const records = JSON.parse(await readFile(path, 'utf8'));
const original = records.filter(record => record.body?.questions?.verification);
if (original.length !== 2 || !process.env.JEV_API_KEY?.trim()) throw Error('ACTUAL_TWO_VERIFICATION_STATES_AND_CREDENTIAL_REQUIRED');
const rows = [];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
for (const [index, record] of original.entries()) {
  const baseline = structuredClone(record.body), compact = structuredClone(record.body);
  if (hash(baseline.state.evidence) !== hash(baseline.questions.verification.instructions.context.evidence)) throw Error('ARCHIVED_EVIDENCE_NOT_EXACT_DUPLICATE');
  delete compact.questions.verification.instructions.context.evidence;
  if (hash(compact.state) !== hash(baseline.state)) throw Error('HOST_FACTS_CHANGED');
  for (const [condition, body] of index === 0 ? [['BASELINE_DUPLICATED', baseline], ['SINGLE_COPY', compact]] : [['SINGLE_COPY', compact], ['BASELINE_DUPLICATED', baseline]]) {
    const started = Date.now();
    let row;
    try {
      const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${process.env.JEV_API_KEY}`
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      row = { stateIndex: index + 1, archivedSequence: record.sequence, condition, requestChars: JSON.stringify(body).length,
        stateSha256: hash(body.state), status: response.status, wallMs: Date.now() - started, response: data, actualCost: null };
    } catch (error) { row = { stateIndex: index + 1, archivedSequence: record.sequence, condition, requestChars: JSON.stringify(body).length,
      stateSha256: hash(body.state), error: error.name, wallMs: Date.now() - started, actualCost: null }; }
    rows.push(row);
    console.log(JSON.stringify({ ...row, response: undefined, choice: row.response?.answers?.verification?.choice, usage: row.response?.usage }));
  }
}
await writeFile('docs/artifacts/GOAL_JEV_VERIFICATION_PAYLOAD_PROBE_2026-10-08.json', JSON.stringify({ checkedAt: new Date().toISOString(), source: path,
  method: 'Four actual Jev requests using two archived actual execution states, alternating condition order. Compact request omits only the byte-identical evidence copy in question context. Full host state, requirements, finite choices and criteria remain identical. Raw answers preserved.',
  limitation: 'Diagnostic decision requests during an independent live batch. They do not prove task recovery, economic advantage or reliable latency under all loads.', rows }, null, 2), { flag: 'wx' });
