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
  for (const path of [responsePath(storagePath, runId), runContentPath(storagePath, runId, 'goals')]) {
    if (path) try { await unlink(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

export async function deleteRunThinking(storagePath, runId) {
  const path = runContentPath(storagePath, runId, 'thinking');
  if (!path) return;
  try { await unlink(path); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
}

const runContentPath = (storagePath, runId, suffix) => storagePath
  ? join(`${storagePath}.${suffix}`, `${createHash('sha256').update(runId).digest('hex')}.json`)
  : undefined;

const imagePath = (storagePath, runId) => storagePath
  ? join(`${storagePath}.images`, `${createHash('sha256').update(runId).digest('hex')}.json`)
  : undefined;

const saveRunText = async (storagePath, runId, text, suffix, field, digestField) => {
  const path = runContentPath(storagePath, runId, suffix);
  if (!path || typeof text !== 'string' || !text) return undefined;
  const contentDigest = digest(text);
  await persistJsonFile(path, { schemaVersion: '1.0', runId, [field]: text, [digestField]: contentDigest });
  return contentDigest;
};

const readRunText = async (storagePath, runId, contentDigest, suffix, field, digestField) => {
  const path = runContentPath(storagePath, runId, suffix);
  if (!path || typeof contentDigest !== 'string') return undefined;
  try {
    const content = JSON.parse(await readFile(path, 'utf8'));
    const text = content?.[field];
    if (content?.schemaVersion === '1.0' && content.runId === runId
      && typeof text === 'string' && content[digestField] === contentDigest
      && digest(text) === contentDigest) return text;
  } catch { /* Missing or damaged local content must not hide audit history. */ }
  return undefined;
};

export const saveRunGoal = (storagePath, runId, goal) =>
  saveRunText(storagePath, runId, goal, 'goals', 'text', 'goalDigest');
export const readRunGoal = (storagePath, runId, goalDigest) =>
  readRunText(storagePath, runId, goalDigest, 'goals', 'text', 'goalDigest');

// Reasoning is conversation content, separate from the digest-only audit
// stream. Keep it beside responses so history can restore the expandable
// thinking row without making a large or sensitive event payload.
export async function saveRunThinking(storagePath, runId, text) {
  return saveRunText(storagePath, runId, text, 'thinking', 'text', 'thinkingDigest');
}

export async function readRunThinking(storagePath, runId, thinkingDigest) {
  return readRunText(storagePath, runId, thinkingDigest, 'thinking', 'text', 'thinkingDigest');
}

// Image bytes are local conversation content, so keep them beside the audit
// stream and store only stable references in TaskRunCreated.
export async function saveRunImages(storagePath, runId, images) {
  const path = imagePath(storagePath, runId);
  if (!path || !Array.isArray(images) || images.length === 0) return [];
  const records = images.map((image, index) => ({
    index,
    name: typeof image?.name === 'string' ? image.name : `image-${index + 1}`,
    mediaType: typeof image?.mediaType === 'string' ? image.mediaType : 'image/png',
    dataUrl: typeof image?.dataUrl === 'string' ? image.dataUrl : '',
    dataDigest: digest(typeof image?.dataUrl === 'string' ? image.dataUrl : '')
  }));
  await persistJsonFile(path, { schemaVersion: '1.0', runId, images: records });
  return records.map(({ index, name, mediaType, dataDigest }) => ({ index, name, mediaType, dataDigest }));
}

export async function readRunImages(storagePath, runId, refs) {
  const path = imagePath(storagePath, runId);
  if (!path || !Array.isArray(refs) || refs.length === 0) return [];
  try {
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record?.schemaVersion !== '1.0' || record.runId !== runId || !Array.isArray(record.images)) return [];
    return refs.flatMap((ref) => {
      const image = record.images.find((candidate) => candidate?.index === ref?.index);
      if (!image || typeof image.dataUrl !== 'string' || image.dataDigest !== ref.dataDigest
        || digest(image.dataUrl) !== ref.dataDigest) return [];
      return [{ name: image.name, mediaType: image.mediaType, dataUrl: image.dataUrl }];
    });
  } catch { return []; }
}
