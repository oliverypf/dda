import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { ToolRegistry, registerReadonlyWorkspaceTools } from '../src/tool-registry.mjs';

const mkPe = ({ machine, magic, subsystem, characteristics, peOffset = 0x80, sections = 2, optSize }) => {
  const opt = magic === 0x10b ? 96 : 112;
  const buf = Buffer.alloc(peOffset + 24 + opt + sections * 40);
  buf[0] = 0x4d; buf[1] = 0x5a;
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write('PE\0\0', peOffset, 'ascii');
  buf.writeUInt16LE(machine, peOffset + 4);
  buf.writeUInt16LE(sections, peOffset + 6);
  buf.writeUInt16LE(opt, peOffset + 20);
  buf.writeUInt16LE(characteristics, peOffset + 22);
  buf.writeUInt16LE(magic, peOffset + 24);
  buf.writeUInt16LE(subsystem, peOffset + 24 + 68);
  return buf;
};

const withWs = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), 'ws-bin-'));
  const ws = new ReadonlyWorkspace(root, { getAccessMode: async () => 'REQUIRE_APPROVAL' });
  try { await fn(root, ws); } finally { await rm(root, { recursive: true, force: true }); }
};

const withMode = async (mode, fn) => {
  const root = await mkdtemp(join(tmpdir(), 'ws-bin-'));
  const modeRef = { value: mode };
  const ws = new ReadonlyWorkspace(root, { getAccessMode: async () => modeRef.value });
  try { await fn(root, ws, modeRef); } finally { await rm(root, { recursive: true, force: true }); }
};

test('PE32 GUI X86 parsed', () => withWs(async (root, ws) => {
  await writeFile(join(root, 'app32.exe'), mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102 }));
  const r = await ws.inspectBinary('app32.exe');
  assert.equal(r.format, 'PE'); assert.equal(r.bits, 32); assert.equal(r.architecture, 'X86');
  assert.equal(r.dll, false); assert.equal(r.subsystem, 'WINDOWS_GUI'); assert.equal(r.machineHex, '0x014c');
  assert.equal(r.sectionCount, 2); assert.equal(r.optionalHeaderMagic, 0x10b);
}));

test('PE32+ console X64', () => withWs(async (root, ws) => {
  await writeFile(join(root, 'app64.exe'), mkPe({ machine: 0x8664, magic: 0x20b, subsystem: 3, characteristics: 0x0022 }));
  const r = await ws.inspectBinary('app64.exe');
  assert.equal(r.bits, 64); assert.equal(r.architecture, 'X64'); assert.equal(r.subsystem, 'WINDOWS_CUI');
}));

test('ARM64 DLL flagged', () => withWs(async (root, ws) => {
  await writeFile(join(root, 'arm.dll'), mkPe({ machine: 0xaa64, magic: 0x20b, subsystem: 3, characteristics: 0x2022 }));
  const r = await ws.inspectBinary('arm.dll');
  assert.equal(r.architecture, 'ARM64'); assert.equal(r.dll, true);
}));

test('rejections: bad MZ, missing PE, far offset, bad magic, unknown machine, non-file', () => withWs(async (root, ws) => {
  await writeFile(join(root, 'bad.bin'), Buffer.from('NO'));
  await assert.rejects(() => ws.inspectBinary('bad.bin'), /WORKSPACE_BINARY_/);
  const noPe = mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102 }); noPe[0x80] = 0;
  await writeFile(join(root, 'nope.exe'), noPe);
  await assert.rejects(() => ws.inspectBinary('nope.exe'), /WORKSPACE_BINARY_/);
  const far = mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102 }); far.writeUInt32LE(0x200000, 0x3c);
  await writeFile(join(root, 'far.exe'), far);
  await assert.rejects(() => ws.inspectBinary('far.exe'), /WORKSPACE_BINARY_HEADER_LIMIT/);
  const badMagic = mkPe({ machine: 0x14c, magic: 0x999, subsystem: 2, characteristics: 0x0102 });
  await writeFile(join(root, 'badmagic.exe'), badMagic);
  await assert.rejects(() => ws.inspectBinary('badmagic.exe'), /WORKSPACE_BINARY_/);
  const unknown = mkPe({ machine: 0xdead, magic: 0x20b, subsystem: 3, characteristics: 0x0022 });
  await writeFile(join(root, 'unk.exe'), unknown);
  const r = await ws.inspectBinary('unk.exe');
  assert.equal(r.architecture, 'UNKNOWN');
  await mkdir(join(root, 'adir'));
  await assert.rejects(() => ws.inspectBinary('adir'), /WORKSPACE_BINARY_NOT_FILE|WORKSPACE_BINARY_INVALID_HEADER/);
}));

test('input schema rejects extra keys; bounded reads never touch the whole file', () => withWs(async (root, ws) => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerReadonlyWorkspaceTools(registry, ws);
  const large = Buffer.concat([mkPe({ machine: 0x8664, magic: 0x20b, subsystem: 3, characteristics: 0x0022 }), Buffer.alloc(512 * 1024, 0xaa)]);
  await writeFile(join(root, 'big.exe'), large);
  const ok = await registry.invoke('workspace.inspect_binary', { path: 'big.exe' });
  assert.equal(ok.architecture, 'X64', '512KB file parsed from header reads only');
  await assert.rejects(() => registry.invoke('workspace.inspect_binary', { path: 'big.exe', extra: true }));
}));

test('credential directories denied even when the file exists', () => withWs(async (root, ws) => {
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'id_rsa'), mkPe({ machine: 0x8664, magic: 0x20b, subsystem: 3, characteristics: 0x0022 }));
  await assert.rejects(() => ws.inspectBinary('.ssh/id_rsa'), /WORKSPACE_/);
}));

test('sparse 32MB file parses from header reads alone', () => withWs(async (root, ws) => {
  const fh = await open(join(root, 'sparse.exe'), 'w');
  await fh.write(mkPe({ machine: 0x8664, magic: 0x20b, subsystem: 3, characteristics: 0x0022 }));
  await fh.truncate(32 * 1024 * 1024); // sparse tail — never read
  await fh.close();
  const r = await ws.inspectBinary('sparse.exe');
  assert.equal(r.sizeBytes, 32 * 1024 * 1024);
  assert.equal(r.architecture, 'X64');
}));

test('outside path denied without FULL_ACCESS', () => withWs(async (root, ws) => {
  const outside = await mkdtemp(join(tmpdir(), 'ws-out-'));
  const exe = join(outside, 'outside-pe.exe');
  await writeFile(exe, mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102 }));
  try { await assert.rejects(() => ws.inspectBinary(exe), /SAFETY_|WORKSPACE_/); }
  finally { await rm(outside, { recursive: true, force: true }); }
}));

test('explicit protectedPaths deny inspectBinary and list', async () => {
  const own = await mkdtemp(join(tmpdir(), 'ws-prot-'));
  const inner = join(own, 'target.exe');
  await writeFile(inner, mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102 }));
  const ws = new ReadonlyWorkspace(own, { getAccessMode: async () => 'FULL_ACCESS', protectedPaths: [own] });
  await assert.rejects(() => ws.inspectBinary(inner), /SAFETY_PROTECTED_PATH|WORKSPACE_/);
  await assert.rejects(() => ws.list(own), /SAFETY_PROTECTED_PATH|WORKSPACE_/);
  await rm(own, { recursive: true, force: true });
});

test('executable and characteristicsCode are in the output', () => withWs(async (root, ws) => {
  await writeFile(join(root, 'app.exe'), mkPe({ machine: 0x8664, magic: 0x20b, subsystem: 3, characteristics: 0x0022 }));
  const r = await ws.inspectBinary('app.exe');
  assert.equal(r.executable, true);
  assert.equal(r.characteristicsCode, 0x0022);
}));

test('aggregate positioned reads stay under the 200-byte budget', () => withWs(async (root, ws) => {
  const probe = join(root, 'probe.tmp');
  await writeFile(probe, 'x');
  const fh = await open(probe);
  const FH = fh.constructor; await fh.close();
  const reads = [];
  const orig = FH.prototype.read;
  FH.prototype.read = function (buffer, offset, length, position) { reads.push({ position, length }); return orig.call(this, buffer, offset, length, position); };
  try {
    await writeFile(join(root, 'inst.exe'), mkPe({ machine: 0x8664, magic: 0x20b, subsystem: 3, characteristics: 0x0022 }));
    const r = await ws.inspectBinary('inst.exe');
    assert.equal(r.architecture, 'X64');
    assert.ok(reads.reduce((a, b) => a + b.length, 0) <= 200, `<=200 bytes read, got ${JSON.stringify(reads)}`);
    assert.ok(reads.length <= 3, 'three positioned reads max');
  } finally { FH.prototype.read = orig; }
}));

test('short optSize 0/1 and truncated section table reject INVALID_HEADER', () => withWs(async (root, ws) => {
  const short = mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102 });
  short.writeUInt16LE(0, 0x80 + 20); // optSize=0
  await writeFile(join(root, 's0.exe'), short);
  await assert.rejects(() => ws.inspectBinary('s0.exe'), /WORKSPACE_BINARY_INVALID_HEADER/);
  const truncated = mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102, sections: 40 });
  await writeFile(join(root, 'trunc.exe'), truncated.subarray(0, 0x80 + 24 + 96 + 10));
  await assert.rejects(() => ws.inspectBinary('trunc.exe'), /WORKSPACE_BINARY_INVALID_HEADER/);
}));

test('machine/bitness mismatch rejects', () => withWs(async (root, ws) => {
  await writeFile(join(root, 'mm.exe'), mkPe({ machine: 0x8664, magic: 0x10b, subsystem: 2, characteristics: 0x0102 }));
  await assert.rejects(() => ws.inspectBinary('mm.exe'), /WORKSPACE_BINARY_INVALID_HEADER/);
}));

test('external path allowed under FULL then revoked', () => withMode('FULL_ACCESS', async (root, ws, modeRef) => {
  const outside = await mkdtemp(join(tmpdir(), 'ws-out-'));
  const exe = join(outside, 'ext.exe');
  await writeFile(exe, mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102 }));
  const r = await ws.inspectBinary(exe);
  assert.equal(r.format, 'PE');
  modeRef.value = 'REQUIRE_APPROVAL';
  await assert.rejects(() => ws.inspectBinary(exe), /SAFETY_|WORKSPACE_/);
  await rm(outside, { recursive: true, force: true });
}));

test('FULL access still denies protected runtime state', () => withMode('FULL_ACCESS', async (root, ws) => {
  const { join: j } = await import('node:path');
  const protectedDir = j(process.env.LOCALAPPDATA ?? '', 'hmCodex');
  await mkdir(protectedDir, { recursive: true }).catch(() => {});
  const file = j(protectedDir, 'computer-access.json');
  const existed = await import('node:fs/promises').then((fs) => fs.access(file).then(() => true).catch(() => false));
  if (!existed) return; // can't fabricate the user's policy
  await assert.rejects(() => ws.inspectBinary(file), /SAFETY_PROTECTED_PATH|WORKSPACE_/);
}));

test('excluded path and .env denied', () => withWs(async (root, ws) => {
  await writeFile(join(root, '.env'), mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102 }));
  await assert.rejects(() => ws.inspectBinary('.env'), /WORKSPACE_/);
}));

test('legacy list and read still work normally and under FULL outside', () => withMode('FULL_ACCESS', async (root, ws, modeRef) => {
  await writeFile(join(root, 'a.txt'), 'hello');
  const list = await ws.list('');
  assert.ok(list.entries.some((e) => e.path === 'a.txt'), 'inside list works');
  const read = await ws.read('a.txt');
  assert.ok(String(read.content).includes('hello'));
  const outside = await mkdtemp(join(tmpdir(), 'ws-out-'));
  await writeFile(join(outside, 'b.txt'), 'outside');
  const outList = await ws.list(outside);
  assert.ok(outList.entries.some((e) => e.path.endsWith('b.txt')), 'FULL outside list works');
  modeRef.value = 'REQUIRE_APPROVAL';
  await assert.rejects(() => ws.list(outside), /SAFETY_|WORKSPACE_/);
  await rm(outside, { recursive: true, force: true });
}));

test('tool registration does not lease/approve or run the file', () => withWs(async (root, ws) => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerReadonlyWorkspaceTools(registry, ws);
  await writeFile(join(root, 'exe.exe'), mkPe({ machine: 0x14c, magic: 0x10b, subsystem: 2, characteristics: 0x0102 }));
  const r = await registry.invoke('workspace.inspect_binary', { path: 'exe.exe' });
  assert.equal(r.format, 'PE');
  assert.equal('lease' in r, false);
  assert.equal('commandDigest' in r, false);
}));
