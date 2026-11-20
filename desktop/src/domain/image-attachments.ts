export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface ComposerImageAttachment {
  id: string;
  name: string;
  mediaType: SupportedImageMediaType;
  dataUrl: string;
  sizeBytes: number;
}

export const ALLOWED_COMPOSER_IMAGE_TYPES: readonly SupportedImageMediaType[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

export const MAX_COMPOSER_IMAGES = 4;
export const MAX_COMPOSER_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_COMPOSER_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_IMAGE_ONLY_PROMPT = '请结合所附图片分析并处理。';

let attachmentSeq = 0;
export const nextImageAttachmentId = (now = Date.now()): string =>
  `img-${now.toString(36)}-${(++attachmentSeq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export const resolveImageMediaType = (mimeType?: string | null, fileName?: string | null): SupportedImageMediaType | undefined => {
  const cleanMime = String(mimeType ?? '').trim().toLowerCase();
  if (cleanMime === 'image/png') return 'image/png';
  if (cleanMime === 'image/jpeg' || cleanMime === 'image/jpg') return 'image/jpeg';
  if (cleanMime === 'image/webp') return 'image/webp';
  if (cleanMime === 'image/gif') return 'image/gif';
  const cleanName = String(fileName ?? '').trim().toLowerCase();
  if (cleanName.endsWith('.png')) return 'image/png';
  if (cleanName.endsWith('.jpg') || cleanName.endsWith('.jpeg')) return 'image/jpeg';
  if (cleanName.endsWith('.webp')) return 'image/webp';
  if (cleanName.endsWith('.gif')) return 'image/gif';
  return undefined;
};

export interface ClipboardLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null;
  files?: ArrayLike<File> | null;
  getData?: (format: string) => string;
}

/**
 * Extract candidate files from clipboard data. Chromium/WebView2 populates both
 * `items` and `files` for a single screenshot paste; prefer `items` when it
 * yields file entries so a single paste never duplicates the image.
 */
export const extractClipboardFiles = (clipboardData: ClipboardLike | null | undefined): File[] => {
  if (!clipboardData) return [];
  const fromItems: File[] = [];
  if (clipboardData.items) {
    for (let index = 0; index < clipboardData.items.length; index += 1) {
      const item = clipboardData.items[index];
      if (item?.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) fromItems.push(file);
    }
  }
  if (fromItems.length > 0) return fromItems;
  if (clipboardData.files) {
    return Array.from(clipboardData.files).filter(Boolean);
  }
  return [];
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(''));
};

const defaultImageName = (mediaType: SupportedImageMediaType, index: number): string => {
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType.split('/')[1] || 'png';
  return `粘贴图片-${index}.${ext}`;
};

export const formatAttachmentSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const appendValidatedImages = async (
  existing: readonly ComposerImageAttachment[],
  files: readonly File[],
  readBytes: (file: File) => Promise<Uint8Array> = async (file) => new Uint8Array(await file.arrayBuffer())
): Promise<{ attachments: ComposerImageAttachment[]; added: ComposerImageAttachment[]; error?: string }> => {
  const next = existing.slice();
  const added: ComposerImageAttachment[] = [];
  let totalBytes = next.reduce((sum, item) => sum + item.sizeBytes, 0);

  for (const file of files) {
    const mediaType = resolveImageMediaType(file.type, file.name);
    if (!mediaType) {
      return { attachments: next, added, error: '仅支持 PNG、JPG、WebP、GIF 格式的图片。' };
    }
    if (next.length >= MAX_COMPOSER_IMAGES) {
      return { attachments: next, added, error: `单次最多添加 ${MAX_COMPOSER_IMAGES} 张图片。` };
    }
    if (file.size > MAX_COMPOSER_IMAGE_BYTES) {
      return { attachments: next, added, error: `图片“${file.name || '粘贴图片'}”超过 10 MB 上限。` };
    }
    const bytes = await readBytes(file);
    if (bytes.byteLength === 0) {
      return { attachments: next, added, error: '图片内容为空，无法添加。' };
    }
    if (bytes.byteLength > MAX_COMPOSER_IMAGE_BYTES) {
      return { attachments: next, added, error: `图片“${file.name || '粘贴图片'}”超过 10 MB 上限。` };
    }
    if (totalBytes + bytes.byteLength > MAX_COMPOSER_TOTAL_IMAGE_BYTES) {
      return { attachments: next, added, error: '单次发送的图片总大小不能超过 20 MB。' };
    }
    totalBytes += bytes.byteLength;
    const rawName = file.name?.trim();
    const cleanName = rawName && !/^image\.(png|jpe?g|webp|gif)$/i.test(rawName)
      ? rawName.slice(0, 120)
      : defaultImageName(mediaType, next.length + 1);
    const attachment: ComposerImageAttachment = {
      id: nextImageAttachmentId(),
      name: cleanName,
      mediaType,
      dataUrl: `data:${mediaType};base64,${bytesToBase64(bytes)}`,
      sizeBytes: bytes.byteLength
    };
    next.push(attachment);
    added.push(attachment);
  }
  return { attachments: next, added };
};
