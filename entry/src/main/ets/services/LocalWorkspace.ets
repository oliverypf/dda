import { common } from '@kit.AbilityKit';
import { fileIo as fs, fileUri, picker } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { WorkspaceEntry } from '../models/CodexTypes';
import { publishText, readBoundedFile, writeUtf8 } from './LocalFileIO';

const MAX_FILE_BYTES: number = 256 * 1024;

export function workspaceParts(path: string): string[] {
  if (path === '/') { return []; }
  if (!path.startsWith('/') || path.length > 4096 || /[\\\u0000-\u001F\u007F]/.test(path)) {
    throw new Error('请输入项目内的绝对路径');
  }
  const parts = path.slice(1).split('/');
  if (parts.some((part: string) => !part || part === '.' || part === '..' || part.startsWith('.pending-'))) {
    throw new Error('项目路径包含无效名称');
  }
  return parts;
}

function validateText(text: string): void {
  if (/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/.test(text)) {
    throw new Error('仅支持 UTF-8 文本文件');
  }
  if (util.TextEncoder.create().encodeInto(text).length > MAX_FILE_BYTES) {
    throw new Error('单个项目文件不能超过 256 KiB');
  }
}

async function readDocument(fd: number): Promise<string> {
  const bytes = await readBoundedFile(fd, MAX_FILE_BYTES);
  const text = util.TextDecoder.create('utf-8', { fatal: true, ignoreBOM: true }).decodeToString(bytes);
  validateText(text);
  return text;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await fs.open(path, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW);
  try {
    await fs.fsync(directory.fd);
  } finally {
    await fs.close(directory);
  }
}

async function ensureDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await fs.mkdir(path);
      await syncDirectory(path.substring(0, path.lastIndexOf('/')));
    } catch (err) {
      if ((err as BusinessError).code !== 13900015) { throw err as Error; }
    }
  }
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('无效的项目目录'); }
}

export class LocalWorkspace {
  private readonly context: common.UIAbilityContext;
  readonly projectId: string;
  private readonly root: string;
  // All project writes pass through this queue, including writes from another
  // view of the same project. Model text is compared again while holding it.
  private static writes: Promise<void> = Promise.resolve();

  constructor(context: common.UIAbilityContext, projectId: string = 'default') {
    if (projectId !== 'default' && !/^p-\d+$/.test(projectId)) { throw new Error('无效的项目标识'); }
    this.context = context;
    this.projectId = projectId;
    this.root = context.filesDir + (projectId === 'default' ? '/workspace' : '/projects/' + projectId);
  }

  async initialize(): Promise<void> {
    if (this.projectId !== 'default') { await ensureDirectory(this.context.filesDir + '/projects', true); }
    await ensureDirectory(this.root, true);
  }

  // Journal files are siblings of the project roots, outside every virtual
  // path passed to the file tools. Callers cannot choose a physical path.
  private checkpointFile(threadId: string): string {
    if (!/^[A-Za-z0-9_-]{1,144}$/.test(threadId)) { throw new Error('断点的会话标识无效'); }
    return this.context.filesDir + '/checkpoint.' + this.projectId + '.' + threadId + '.json';
  }

  async readCheckpoint(threadId: string): Promise<string | undefined> {
    const path = this.checkpointFile(threadId);
    try {
      const stat = await fs.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
        throw new Error('断点文件无效或过大');
      }
      const file = await fs.open(path, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW | fs.OpenMode.NONBLOCK);
      try {
        const data = await readBoundedFile(file.fd, 2 * 1024 * 1024);
        return util.TextDecoder.create('utf-8', { fatal: true }).decodeToString(data);
      } finally {
        await fs.close(file);
      }
    } catch (err) {
      if ((err as BusinessError).code === 13900002) { return undefined; }
      throw err as Error;
    }
  }

  async writeCheckpoint(threadId: string, text: string): Promise<void> {
    if (util.TextEncoder.create().encodeInto(text).length > 2 * 1024 * 1024) {
      throw new Error('任务断点超过大小上限');
    }
    await publishText(this.context.filesDir, this.checkpointFile(threadId), text, true);
    // Persist the rename before an approved project write can begin.
    await syncDirectory(this.context.filesDir);
  }

  private async directory(parts: string[], create: boolean = false): Promise<string> {
    let path = this.root;
    await ensureDirectory(path, false);
    for (const name of parts) {
      path += '/' + name;
      await ensureDirectory(path, create);
    }
    return path;
  }

  async list(path: string): Promise<WorkspaceEntry[]> {
    const directory = await this.directory(workspaceParts(path));
    const result: WorkspaceEntry[] = [];
    const names = await fs.listFile(directory);
    for (const name of names) {
      if (name.startsWith('.pending-')) { continue; }
      const stat = await fs.lstat(directory + '/' + name);
      if (stat.isFile() || stat.isDirectory()) {
        result.push({
          path: (path === '/' ? '/' : path + '/') + name, fileName: name,
          isDirectory: stat.isDirectory(), isFile: stat.isFile()
        });
      }
    }
    return result.sort((a: WorkspaceEntry, b: WorkspaceEntry) =>
      a.isDirectory === b.isDirectory ? a.fileName.localeCompare(b.fileName) : a.isDirectory ? -1 : 1);
  }

  private async filePath(path: string, createParents: boolean = false): Promise<string> {
    const parts = workspaceParts(path);
    const name = parts.pop();
    if (!name) { throw new Error('请指定文件名'); }
    return await this.directory(parts, createParents) + '/' + name;
  }

  async read(path: string, confirmPublication: boolean = false): Promise<string> {
    const target = await this.filePath(path);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error('项目文件类型无效'); }
    const file = await fs.open(target, fs.OpenMode.READ_ONLY | fs.OpenMode.NOFOLLOW | fs.OpenMode.NONBLOCK);
    try {
      const value = await readDocument(file.fd);
      // Recovery can catch a rename before the original writer syncs its directory.
      if (confirmPublication) { await syncDirectory(target.substring(0, target.lastIndexOf('/'))); }
      return value;
    } finally {
      await fs.close(file);
    }
  }

  private write(action: () => Promise<void>): Promise<void> {
    const pending = LocalWorkspace.writes.then(action);
    LocalWorkspace.writes = pending.catch(() => {});
    return pending;
  }

  createFile(path: string, content: string): Promise<void> {
    return this.write(async () => {
      validateText(content);
      const target = await this.filePath(path, true);
      const directory = target.slice(0, target.lastIndexOf('/'));
      await publishText(directory, target, content, false);
      await syncDirectory(directory);
    });
  }

  replaceFile(path: string, expected: string, replacement: string): Promise<void> {
    return this.write(async () => {
      validateText(replacement);
      if (await this.read(path) !== expected) { throw new Error('文件已变化，请重新读取并核对修改'); }
      const target = await this.filePath(path);
      const directory = target.slice(0, target.lastIndexOf('/'));
      await publishText(directory, target, replacement, true);
      await syncDirectory(directory);
    });
  }

  async importFiles(): Promise<number> {
    const view = new picker.DocumentViewPicker(this.context);
    const options = new picker.DocumentSelectOptions();
    options.maxSelectNumber = 64;
    const uris = await view.select(options);
    let count = 0;
    for (const uri of uris) {
      const name = new fileUri.FileUri(uri).name;
      if (workspaceParts('/' + name).length !== 1) { throw new Error('无效的文档名称'); }
      try {
        const file = await fs.open(uri, fs.OpenMode.READ_ONLY);
        let text: string;
        try {
          text = await readDocument(file.fd);
        } finally {
          await fs.close(file);
        }
        await this.createFile('/' + name, text);
        count++;
      } catch (err) {
        if ((err as BusinessError).code === 13900015) { continue; }
        throw new Error('已导入 ' + count + ' 个文档，读取 ' + name + ' 失败：' + (err as Error).message);
      }
    }
    return count;
  }

  async exportFile(path: string): Promise<boolean> {
    const content = await this.read(path);
    return this.exportText(path.substring(path.lastIndexOf('/') + 1), content);
  }

  async exportText(name: string, content: string): Promise<boolean> {
    if (workspaceParts('/' + name).length !== 1) { throw new Error('无效的导出名称'); }
    const view = new picker.DocumentViewPicker(this.context);
    const options = new picker.DocumentSaveOptions();
    options.newFileNames = [name];
    const destinations = await view.save(options);
    if (!destinations.length) { return false; }
    const file = await fs.open(destinations[0], fs.OpenMode.WRITE_ONLY);
    try {
      if ((await fs.stat(file.fd)).size > 0) { throw new Error('目标文件已有内容，请使用新文件名'); }
      await writeUtf8(file.fd, content);
    } finally {
      await fs.close(file);
    }
    return true;
  }
}
