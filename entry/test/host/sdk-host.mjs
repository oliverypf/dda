// Loads the shipped ArkTS services in Node. The adapter surface below consists
// solely of SDK calls used by this host-side integration test.
import fs from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';

const require = createRequire(import.meta.url);
const ide = process.env.DEVECO_STUDIO_HOME ?? 'C:/Program Files/Huawei/DevEco Studio';
const ts = require(join(ide, 'tools/hvigor/hvigor-ohos-plugin/node_modules/typescript'));
const sourceRoot = fileURLToPath(new URL('../../src/main/ets/', import.meta.url));
const modules = new Map();
const handles = new Map();

// A literal component on Harmony must not resolve to a Win32 device, named
// stream, or a different component after trailing dot/space normalization.
function hostPath(path) {
  if (process.platform === 'win32') {
    const parts = path.slice(parse(path).root.length).split(/[\\/]/);
    if (parts.some(part => /[. ]$|:/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) {
      throw new Error('The Windows host cannot represent that literal project path');
    }
  }
  return path;
}

function withSdkErrors(action) {
  return async (...args) => {
    try {
      return await action(...args);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EEXIST') {
        throw Object.assign(new Error(err.message), { code: err.code === 'ENOENT' ? 13900002 : 13900015 });
      }
      throw err;
    }
  };
}

const fileIo = {
  OpenMode: { CREATE: constants.O_CREAT, READ_ONLY: constants.O_RDONLY, WRITE_ONLY: constants.O_WRONLY,
    NOFOLLOW: constants.O_NOFOLLOW ?? 0, NONBLOCK: constants.O_NONBLOCK ?? 0 },
  readText: withSdkErrors(path => fs.readFile(hostPath(path), 'utf8')),
  mkdir: withSdkErrors(path => fs.mkdir(hostPath(path))),
  lstat: withSdkErrors(path => fs.lstat(hostPath(path))),
  listFile: path => fs.readdir(hostPath(path)),
  rename: (from, to) => fs.rename(hostPath(from), hostPath(to)),
  unlink: path => fs.unlink(hostPath(path)),
  async open(path, flags) {
    const handle = await fs.open(hostPath(path), flags);
    handles.set(handle.fd, handle);
    return handle;
  },
  stat: fd => handles.get(fd).stat(),
  async read(fd, bytes) { return (await handles.get(fd).read(new Uint8Array(bytes))).bytesRead; },
  async write(fd, bytes) { return (await handles.get(fd).write(new Uint8Array(bytes))).bytesWritten; },
  async fsync(fd) {
    const handle = handles.get(fd);
    try { await handle.sync(); }
    catch (err) {
      // Windows rejects FlushFileBuffers on read-only directory handles.
      // The host tests simulate process loss. Harmony performs the actual
      // directory fsync, which is also necessary for power-loss durability.
      if (process.platform !== 'win32' || err.code !== 'EPERM' || !(await handle.stat()).isDirectory()) { throw err; }
    }
  },
  async close(handle) { handles.delete(handle.fd); await handle.close(); },
  moveFile: withSdkErrors(async (from, to, mode) => {
    if (mode !== 1) { throw new Error('Only exclusive publication is supported in the fixture'); }
    await fs.link(hostPath(from), hostPath(to));
    await fs.unlink(hostPath(from));
  })
};

class HttpRequest extends EventEmitter {
  controller = new AbortController();
  async requestInStream(endpoint, options) {
    if (new URL(endpoint).hostname !== '127.0.0.1') { throw new Error('Fixture only permits loopback HTTP'); }
    const response = await fetch(endpoint, { method: options.method, headers: options.header, body: options.extraData,
      redirect: 'error', signal: this.controller.signal });
    for await (const chunk of response.body) {
      this.emit('dataReceive', chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    }
    this.emit('dataEnd');
    return response.status;
  }
  destroy() { this.controller.abort(); }
}

const assets = new Map();
const asset = {
  Tag: { ALIAS: 'alias', SECRET: 'secret', RETURN_TYPE: 'returnType', ACCESSIBILITY: 'accessibility',
    CONFLICT_RESOLUTION: 'conflictResolution' },
  ReturnType: { ALL: 'all' }, Accessibility: { DEVICE_UNLOCKED: 'unlocked' },
  ConflictResolution: { OVERWRITE: 'overwrite' }, ErrorCode: { NOT_FOUND: 24000002 },
  async add(attrs) { assets.set(Buffer.from(attrs.get('alias')).toString('hex'), new Map(attrs)); },
  async query(attrs) {
    const found = assets.get(Buffer.from(attrs.get('alias')).toString('hex'));
    if (!found) { throw Object.assign(new Error('Missing asset'), { code: asset.ErrorCode.NOT_FOUND }); }
    return [found];
  },
  async remove(attrs) { assets.delete(Buffer.from(attrs.get('alias')).toString('hex')); }
};

const kits = {
  '@kit.NetworkKit': { http: { RequestMethod: { POST: 'POST' }, createHttp: () => new HttpRequest() } },
  '@kit.CoreFileKit': { fileIo },
  '@kit.ArkTS': {
    url: { URL: { parseURL: input => new URL(input) } },
    util: {
      Base64Helper: class { async encodeToString(bytes) { return Buffer.from(bytes).toString('base64'); } },
      generateRandomUUID: randomUUID,
      TextEncoder: { create: () => ({ encodeInto: text => new TextEncoder().encode(text) }) },
      TextDecoder: { create: (...args) => {
        const decoder = new TextDecoder(...args);
        return { decodeToString: (bytes, options) => decoder.decode(bytes, options) };
      } }
    }
  },
  '@kit.MediaLibraryKit': {}, '@kit.AssetStoreKit': { asset },
  '@kit.CryptoArchitectureKit': { cryptoFramework: { createMd(algorithm) {
    const hash = createHash(algorithm);
    return { async update(blob) { hash.update(blob.data); }, async digest() { return { data: hash.digest() }; } };
  } } }
};

export function loadArkTS(name) {
  return load(resolve(sourceRoot, name + '.ets'));
}
function load(filename) {
  if (modules.has(filename)) { return modules.get(filename); }
  const source = readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } });
  const exports = {};
  const importModule = specifier => {
    if (Object.hasOwn(kits, specifier)) { return kits[specifier]; }
    if (specifier.startsWith('../vendor/') && specifier.endsWith('.js')) { return require(resolve(dirname(filename), specifier)); }
    if (specifier.startsWith('.')) { return load(resolve(dirname(filename), specifier + '.ets')); }
    throw new Error('Missing SDK adapter: ' + specifier);
  };
  compileFunction(outputText, ['exports', 'require'], { filename })(exports, importModule);
  modules.set(filename, exports);
  return exports;
}
