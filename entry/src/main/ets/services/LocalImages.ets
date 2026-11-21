import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { fileIo as fs, fileUri } from '@kit.CoreFileKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ImageAttachment } from '../models/CodexTypes';
import { publishBytes, readBoundedFile } from './LocalFileIO';

const MAX_IMAGE_BYTES: number = 4 * 1024 * 1024;

function imageExtension(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    default: return '';
  }
}

function validImageId(id: string): boolean {
  return typeof id === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|webp)$/.test(id);
}

export function validAttachments(images: ImageAttachment[]): boolean {
  return Array.isArray(images) && images.length <= 4 && images.every((image: ImageAttachment) =>
    !!image && validImageId(image.id) && typeof image.name === 'string' && image.name.length > 0 &&
    image.name.length <= 255 && image.id.endsWith('.' + imageExtension(image.mime)));
}

export function detectImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
    bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10 &&
    bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82) {
    return 'image/png';
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[3] !== 0) {
    return 'image/jpeg';
  }
  if (bytes.length >= 16 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70 &&
    bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80 &&
    bytes[12] === 86 && bytes[13] === 80 && bytes[14] === 56 &&
    (bytes[15] === 32 || bytes[15] === 76 || bytes[15] === 88)) {
    return 'image/webp';
  }
  throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
}

async function imageDirectory(context: common.UIAbilityContext): Promise<string> {
  const dir = context.filesDir + '/chat-images';
  try {
    await fs.mkdir(dir);
  } catch (err) {
    if ((err as BusinessError).code !== 13900015) { throw err as Error; }
  }
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('图片存储目录无效'); }
  return dir;
}

export async function chooseImages(context: common.UIAbilityContext, remaining: number): Promise<ImageAttachment[]> {
  const limit = Math.min(4, Math.floor(remaining));
  if (!Number.isFinite(limit) || limit < 1) { throw new Error('每条消息最多添加 4 张图片'); }
  const options = new photoAccessHelper.PhotoSelectOptions();
  options.MIMEType = photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE;
  options.maxSelectNumber = limit;
  const result = await new photoAccessHelper.PhotoViewPicker().select(options);
  if (!result.photoUris.length) { return []; }
  if (result.photoUris.length > limit) { throw new Error('图片超出本条消息可添加数量'); }
  const dir = await imageDirectory(context);
  const selected: ImageAttachment[] = [];
  try {
    for (const uri of result.photoUris) {
      const file = await fs.open(uri, fs.OpenMode.READ_ONLY);
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedFile(file.fd, MAX_IMAGE_BYTES);
      } finally {
        await fs.close(file);
      }
      const mime = detectImageMime(bytes);
      const ext = imageExtension(mime);
      const id = util.generateRandomUUID().toLowerCase() + '.' + ext;
      const name = new fileUri.FileUri(uri).name.slice(0, 255) || ('图片.' + ext);
      await publishBytes(dir, dir + '/' + id, bytes, false);
      selected.push({ id: id, name: name, mime: mime });
    }
    return selected;
  } catch (err) {
    for (const image of selected) { await fs.unlink(dir + '/' + image.id); }
    throw err as Error;
  }
}

export function imageLocalUri(context: common.UIAbilityContext, id: string): string {
  if (!validImageId(id)) { throw new Error('图片标识无效'); }
  return fileUri.getUriFromPath(context.filesDir + '/chat-images/' + id);
}

export async function readImageData(context: common.UIAbilityContext, id: string): Promise<string> {
  if (!validImageId(id)) { throw new Error('图片标识无效'); }
  const dir = await imageDirectory(context);
  const file = await fs.open(dir + '/' + id, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW | fs.OpenMode.NONBLOCK);
  try {
    const bytes = await readBoundedFile(file.fd, MAX_IMAGE_BYTES);
    const mime = detectImageMime(bytes);
    if (!id.endsWith('.' + imageExtension(mime))) { throw new Error('图片格式与记录不一致'); }
    return 'data:' + mime + ';base64,' + await new util.Base64Helper().encodeToString(bytes);
  } finally {
    await fs.close(file);
  }
}
