import { describe, expect, it } from 'vitest';
import {
  appendValidatedImages,
  extractClipboardFiles,
  formatAttachmentSize,
  MAX_COMPOSER_IMAGE_BYTES,
  MAX_COMPOSER_IMAGES,
  resolveImageMediaType
} from './image-attachments';

const fakeFile = (name: string, type: string, size: number): File => {
  const bytes = new Uint8Array(Math.min(size, 16));
  bytes.fill(0x89);
  const file = new File([bytes], name, { type });
  if (size !== bytes.byteLength) {
    Object.defineProperty(file, 'size', { value: size });
  }
  return file;
};

describe('image-attachments', () => {
  it('resolves supported image MIME types and falls back to filename extension', () => {
    expect(resolveImageMediaType('image/png', '')).toBe('image/png');
    expect(resolveImageMediaType('image/jpg', '')).toBe('image/jpeg');
    expect(resolveImageMediaType('', 'screen.WEBP')).toBe('image/webp');
    expect(resolveImageMediaType('', 'anim.gif')).toBe('image/gif');
    expect(resolveImageMediaType('application/pdf', 'doc.pdf')).toBeUndefined();
  });

  it('prefers clipboardData.items over clipboardData.files so pasted screenshots do not duplicate', () => {
    const file = fakeFile('image.png', 'image/png', 8);
    const extracted = extractClipboardFiles({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      files: [file]
    });
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toBe(file);

    const fallback = extractClipboardFiles({
      items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
      files: [file]
    });
    expect(fallback).toHaveLength(1);
  });

  it('appends valid images as base64 data URLs and enforces count and size bounds', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = fakeFile('image.png', 'image/png', 4);
    const first = await appendValidatedImages([], [file], async () => pngBytes);
    expect(first.error).toBeUndefined();
    expect(first.attachments).toHaveLength(1);
    expect(first.attachments[0].name).toBe('粘贴图片-1.png');
    expect(first.attachments[0].dataUrl).toBe('data:image/png;base64,iVBORw==');

    const unsupported = await appendValidatedImages(first.attachments, [fakeFile('notes.txt', 'text/plain', 4)], async () => pngBytes);
    expect(unsupported.error).toMatch(/PNG、JPG、WebP、GIF/);
    expect(unsupported.attachments).toHaveLength(1);

    const oversized = await appendValidatedImages([], [fakeFile('huge.png', 'image/png', MAX_COMPOSER_IMAGE_BYTES + 1)], async () => pngBytes);
    expect(oversized.error).toMatch(/10 MB/);
    expect(oversized.attachments).toHaveLength(0);

    let list = first.attachments;
    for (let i = 1; i < MAX_COMPOSER_IMAGES; i += 1) {
      const res = await appendValidatedImages(list, [fakeFile(`s-${i}.jpg`, 'image/jpeg', 4)], async () => pngBytes);
      list = res.attachments;
    }
    expect(list).toHaveLength(MAX_COMPOSER_IMAGES);
    const extra = await appendValidatedImages(list, [fakeFile('overflow.png', 'image/png', 4)], async () => pngBytes);
    expect(extra.error).toMatch(/最多添加/);
    expect(extra.attachments).toHaveLength(MAX_COMPOSER_IMAGES);
  });

  it('formats byte sizes cleanly', () => {
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(2048)).toBe('2.0 KB');
    expect(formatAttachmentSize(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
