import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

export const ALLOWED_IMAGE_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);
const ALLOWED_MEDIA_SET = new Set(ALLOWED_IMAGE_MEDIA_TYPES);

export const MAX_INPUT_IMAGES = 4;
export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_IMAGE_ONLY_PROMPT = '请结合所附图片分析并处理。';

const DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;

const canonicalMediaType = (raw) => {
  const normalized = String(raw ?? '').trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return ALLOWED_MEDIA_SET.has(normalized) ? normalized : undefined;
};

const mediaTypeFromFilename = (fileName) => {
  const ext = extname(String(fileName ?? '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return undefined;
};

const sanitizeImageName = (value, index, mediaType) => {
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType.split('/')[1] || 'png';
  const fallback = `image-${index + 1}.${ext}`;
  if (typeof value !== 'string') return fallback;
  const cleaned = basename(value.trim()).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/gu, '_').slice(0, 120);
  return cleaned || fallback;
};

const fail = (code, detail = '') => {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  throw error;
};

/**
 * Validate and normalize an array of `{ name?, mediaType?, dataUrl }` image inputs.
 */
export function normalizeImageInputs(rawImages) {
  if (rawImages === undefined || rawImages === null) return [];
  if (!Array.isArray(rawImages)) fail('TASK_IMAGE_INPUT_INVALID', 'images must be an array');
  if (rawImages.length > MAX_INPUT_IMAGES) {
    fail('TASK_IMAGE_COUNT_EXCEEDED', `${rawImages.length}:${MAX_INPUT_IMAGES}`);
  }
  let totalBytes = 0;
  const normalized = [];
  for (let index = 0; index < rawImages.length; index += 1) {
    const entry = rawImages[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('TASK_IMAGE_INPUT_INVALID', `index=${index}`);
    }
    const rawDataUrl = typeof entry.dataUrl === 'string' ? entry.dataUrl.trim() : '';
    const match = DATA_URL_PATTERN.exec(rawDataUrl);
    if (!match) {
      fail('TASK_IMAGE_FORMAT_UNSUPPORTED', `index=${index}`);
    }
    const urlMedia = canonicalMediaType(match[1]);
    const declaredMedia = entry.mediaType !== undefined ? canonicalMediaType(entry.mediaType) : urlMedia;
    if (!urlMedia || !declaredMedia || urlMedia !== declaredMedia) {
      fail('TASK_IMAGE_FORMAT_UNSUPPORTED', `index=${index}`);
    }
    const cleanBase64 = match[2].replace(/\s+/g, '');
    if (!cleanBase64 || cleanBase64.length % 4 === 1) {
      fail('TASK_IMAGE_DATA_INVALID', `index=${index}`);
    }
    const bytes = Buffer.from(cleanBase64, 'base64');
    if (bytes.byteLength === 0) {
      fail('TASK_IMAGE_DATA_INVALID', `index=${index}`);
    }
    if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
      fail('TASK_IMAGE_TOO_LARGE', `${bytes.byteLength}:${MAX_INPUT_IMAGE_BYTES}`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_INPUT_IMAGE_BYTES) {
      fail('TASK_IMAGE_TOTAL_TOO_LARGE', `${totalBytes}:${MAX_TOTAL_INPUT_IMAGE_BYTES}`);
    }
    const canonicalBase64 = bytes.toString('base64');
    normalized.push(Object.freeze({
      name: sanitizeImageName(entry.name, index, urlMedia),
      mediaType: urlMedia,
      dataUrl: `data:${urlMedia};base64,${canonicalBase64}`,
      byteLength: bytes.byteLength
    }));
  }
  return Object.freeze(normalized);
}

/**
 * Load a JSON file containing `{ images: [...] }` or `[...]` produced by the desktop host.
 */
export async function loadImageInputsFile(filePath) {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : '';
  if (!trimmed) return [];
  let raw;
  try {
    raw = await readFile(trimmed, 'utf8');
  } catch (error) {
    fail('TASK_IMAGE_FILE_UNREADABLE', error?.code ?? 'READ_FAILED');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('TASK_IMAGE_INPUT_INVALID', 'invalid JSON');
  }
  const items = Array.isArray(parsed) ? parsed : parsed?.images;
  return normalizeImageInputs(items);
}

/**
 * Load one raw image file path (`--image path/to/file.png`) into an image input entry.
 */
export async function loadImageFileAttachment(filePath) {
  const trimmed = typeof filePath === 'string' ? filePath.trim() : '';
  if (!trimmed) fail('TASK_IMAGE_INPUT_INVALID', 'empty path');
  const mediaType = mediaTypeFromFilename(trimmed);
  if (!mediaType) fail('TASK_IMAGE_FORMAT_UNSUPPORTED', basename(trimmed));
  let bytes;
  try {
    bytes = await readFile(trimmed);
  } catch (error) {
    fail('TASK_IMAGE_FILE_UNREADABLE', error?.code ?? 'READ_FAILED');
  }
  if (bytes.byteLength === 0) fail('TASK_IMAGE_DATA_INVALID', basename(trimmed));
  if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) {
    fail('TASK_IMAGE_TOO_LARGE', `${bytes.byteLength}:${MAX_INPUT_IMAGE_BYTES}`);
  }
  return {
    name: basename(trimmed),
    mediaType,
    dataUrl: `data:${mediaType};base64,${bytes.toString('base64')}`
  };
}

/**
 * Convert validated image inputs into provider-neutral user message content blocks.
 */
export function toImageContentBlocks(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  return images
    .filter((img) => img && typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:image/'))
    .map((img) => ({
      type: 'input-image',
      mediaType: img.mediaType,
      dataUrl: img.dataUrl,
      ...(typeof img.name === 'string' && img.name ? { name: img.name } : {})
    }));
}
