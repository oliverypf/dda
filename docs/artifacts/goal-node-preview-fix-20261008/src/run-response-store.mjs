import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { persistJsonFile } from './persistent-json-store.mjs';

const digest = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const responsePath = (storagePath, runId) => storagePath
  ? join(`${storagePath}.responses`, `${createHash('sha256').update(runId).digest('hex')}.json`)
  : undefined;

// Local conversation content is separate from the digest-only audit/export
// stream. Read only the responses anchored by the current history page.
export async function saveRunResponse(storagePath, runId, text) {
  const path = responsePath(storagePath, runId);
  if (!path) return;
  await persistJsonFile(path, { schemaVersion: '1.0', runId, text, outputDigest: digest(text) });
}

export async function readRunResponse(storagePath, runId, outputDigest) {
  const path = responsePath(storagePath, runId);
  if (!path || typeof outputDigest !== 'string') return undefined;
  try {
    const response = JSON.parse(await readFile(path, 'utf8'));
    if (response?.schemaVersion === '1.0' && response.runId === runId
      && typeof response.text === 'string' && response.outputDigest === outputDigest
      && digest(response.text) === outputDigest) return response.text;
  } catch { /* Missing or damaged local content must not hide the audit history. */ }
  return undefined;
}

export async function deleteRunResponse(storagePath, runId) {
  const path = responsePath(storagePath, runId);
  if (!path) return;
  try { await unlink(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
