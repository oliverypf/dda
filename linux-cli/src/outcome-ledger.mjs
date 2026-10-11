import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// When the CLI gives up on a run (timeout) or interrupts it (SIGINT/SIGTERM)
// without observing a terminal state from the runtime, the run can be left in
// an uncertain or cancelled state the runtime never got to record. This ledger
// writes a small, durable marker into the data directory so a later `recovery`
// run surfaces it. The contract requires that a CLI timeout is reported as
// UNKNOWN (not implicitly cancelled) and that an interrupted run still exposes
// a cancelled terminal state for reconciliation.

export const OUTCOME_LEDGER_FILE = 'cli-unknown-outcomes.json';
const SCHEMA_VERSION = '1.0';
const MAX_RECORDS = 256;
const VALID_STATES = new Set(['UNKNOWN', 'CANCELLED']);

const clamp = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : undefined);

export function ledgerPath(dataDir) {
  return typeof dataDir === 'string' && dataDir ? join(dataDir, OUTCOME_LEDGER_FILE) : undefined;
}

export async function readOutcomeLedger(storePath) {
  if (!storePath) return [];
  let text;
  try {
    text = await readFile(storePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.records)) return [];
  return parsed.records.filter((record) => record && typeof record === 'object' && VALID_STATES.has(record.state));
}

// Append one outcome marker. Failures to persist must never mask the original
// timeout/cancellation the caller is already reporting, so the caller should
// swallow errors; this function keeps its own write atomic via tmp + rename.
export async function recordUnknownOutcome(storePath, outcome = {}) {
  if (!storePath) return undefined;
  const state = VALID_STATES.has(outcome.state) ? outcome.state : 'UNKNOWN';
  const record = {
    state,
    reason: clamp(outcome.reason, 120) ?? 'CLI_UNKNOWN',
    ...(clamp(outcome.runId, 160) ? { runId: clamp(outcome.runId, 160) } : {}),
    ...(clamp(outcome.command, 80) ? { command: clamp(outcome.command, 80) } : {}),
    ...(Number.isInteger(outcome.timeoutMs) ? { timeoutMs: outcome.timeoutMs } : {}),
    recordedAtMs: Date.now()
  };
  const existing = await readOutcomeLedger(storePath).catch(() => []);
  const records = [...existing, record].slice(-MAX_RECORDS);
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 }).catch(() => undefined);
  const tmp = `${storePath}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, records })}\n`, { mode: 0o600 });
  await rename(tmp, storePath);
  return record;
}
