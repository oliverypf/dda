import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';

// Enforce the bound even when a picker-supplied file changes after stat.
export async function readBoundedFile(fd: number, limit: number): Promise<Uint8Array> {
  const stat = await fs.stat(fd);
  if (!stat.isFile() || stat.size > limit) { throw new Error('请选择不超过 ' + (limit / 1024) + ' KiB 的文件'); }
  const blocks: Uint8Array[] = [];
  let size = 0;
  while (size <= limit) {
    const block = new ArrayBuffer(Math.min(64 * 1024, limit + 1 - size));
    const length = await fs.read(fd, block);
    if (length === 0) { break; }
    blocks.push(new Uint8Array(block, 0, length));
    size += length;
  }
  if (size > limit) { throw new Error('文件超过 ' + (limit / 1024) + ' KiB'); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const block of blocks) {
    bytes.set(block, offset);
    offset += block.length;
  }
  return bytes;
}

async function writeBytes(fd: number, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const chunk = bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + bytes.byteLength);
    const written = await fs.write(fd, chunk);
    if (written <= 0) {
      throw new Error('文件写入未完成');
    }
    offset += written;
  }
  await fs.fsync(fd);
}

export async function writeUtf8(fd: number, text: string): Promise<void> {
  await writeBytes(fd, util.TextEncoder.create().encodeInto(text));
}

// The caller chooses create-only publication or replacement. The temporary
// file and destination are in the same application-private filesystem.
export async function publishText(stagingDir: string, destination: string, text: string,
  replace: boolean): Promise<void> {
  await publishBytes(stagingDir, destination, util.TextEncoder.create().encodeInto(text), replace);
}

export async function publishBytes(stagingDir: string, destination: string, bytes: Uint8Array,
  replace: boolean): Promise<void> {
  const stage = stagingDir + '/.pending-' + util.generateRandomUUID();
  const file = await fs.open(stage, fs.OpenMode.WRITE_ONLY | fs.OpenMode.CREATE | fs.OpenMode.NOFOLLOW);
  let published = false;
  try {
    try {
      await writeBytes(file.fd, bytes);
    } finally {
      await fs.close(file);
    }
    if (replace) {
      await fs.rename(stage, destination);
    } else {
      await fs.moveFile(stage, destination, 1);
    }
    published = true;
  } finally {
    if (!published) {
      await fs.unlink(stage);
    }
  }
}
