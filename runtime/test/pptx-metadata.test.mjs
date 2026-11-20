import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { hashBuildArtifact } from '../src/decision/pptx-metadata.mjs';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { createReadonlyToolRegistry } from '../src/tool-registry.mjs';

// A fixture ZIP writer allows independently varying XML, lengths, and checksums.
function zip(parts) {
  const records = [];
  const directory = [];
  let offset = 0;
  for (const [path, text] of Object.entries(parts)) {
    const name = Buffer.from(path);
    const data = Buffer.from(text);
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    header.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    records.push(header, name, compressed);
    directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(records.length / 3, 8);
  end.writeUInt16LE(records.length / 3, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, central, end]);
}

const base = 'http://schemas.openxmlformats.org';
const rel = base + '/officeDocument/2006/relationships';
const rels = base + '/package/2006/relationships';
const main = base + '/presentationml/2006/main';
const root = '<Relationships xmlns="' + rels + '">';
const parts = {
  '_rels/.rels': root + '<Relationship Id="main" Type="' + rel + '/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  '[Content_Types].xml': '<Types xmlns="' + base + '/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  'ppt/presentation.xml': '<p:presentation xmlns:p="' + main + '" xmlns:r="' + rel + '"><p:sldIdLst><p:sldId id="256" r:id="first"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels': root + '<Relationship Id="first" Target="slides/slide3.xml" Type="' + rel + '/slide"/></Relationships>',
  'ppt/slides/slide3.xml': '<sld xmlns="' + main + '"/>',
  'ppt/slides/slide4.xml': '<sld xmlns="' + main + '"/>'
};

async function observe(data, options = {}) {
  const sha256 = 'sha256:' + createHash('sha256').update(data).digest('hex');
  const file = { createReadStream: () => Readable.from([data.subarray(0, 8), data.subarray(8)]) };
  return hashBuildArtifact(file, options.name ?? 'fixture.PPTX', data.length, options.expected ?? sha256);
}

test('reports the presentation slide list and all ZIP entries from digest-matched bytes', async () => {
  const data = zip(parts);
  assert.deepEqual((await observe(data)).pptx, { slideCount: 1, entryCount: 6 });
  assert.equal((await observe(data, { expected: 'incorrect' })).pptx, undefined);
  assert.equal((await observe(data, { name: 'file.exe' })).pptx, undefined);
});

test('workspace.read pages and searches existing presentation excerpts under normal read policy', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'dda-pptx-read-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const xml = '<sld xmlns="' + main + '" xmlns:a="' + base + '/drawingml/2006/main"><a:t>Project &amp; overview</a:t><a:t>本地运行时</a:t></sld>';
  const data = zip({ ...parts, 'ppt/slides/slide3.xml': xml });
  const path = 'existing.PPTX';
  await writeFile(join(rootDir, path), data);
  await writeFile(join(rootDir, 'secret.pptx'), data);
  await writeFile(join(rootDir, 'broken.pptx'), 'not an OOXML package');
  const workspace = new ReadonlyWorkspace(rootDir);
  const registry = createReadonlyToolRegistry(workspace);
  const read = request => registry.invoke('workspace.read', request);
  const inspected = await read({ path });
  assert.deepEqual(inspected.pptx, { slideCount: 1, entryCount: 6 });
  assert.equal(inspected.format, 'PPTX');
  assert.equal(inspected.path, path);
  assert.equal(inspected.sizeBytes, data.length);
  assert.equal(inspected.digest, 'sha256:' + createHash('sha256').update(data).digest('hex'));
  assert.match(inspected.content, /Slide 1: Project & overview 本地运行时/u);
  assert.doesNotMatch(inspected.content, /<a:t>|slide4\.xml/u);
  const page = await read({ path, maxChars: 12 });
  assert.equal(page.truncated, true);
  assert.equal(page.content + (await read({ path, offsetChars: 12 })).content, inspected.content);
  assert.equal((await read({ path, findText: '本地运行时' })).found, true);
  assert.equal((await read({ path, findText: 'absent' })).found, false);
  await assert.rejects(read({ path: 'secret.pptx' }), /WORKSPACE_SENSITIVE_PATH/u);
  await assert.rejects(read({ path: 'broken.pptx' }), /WORKSPACE_PPTX_INVALID_OR_UNSUPPORTED/u);
  await assert.rejects(workspace.read(path), /WORKSPACE_BINARY_FILE/u);
});

test('omits optional metadata for broken, external, and oversized presentation parts', async () => {
  const relsPath = 'ppt/_rels/presentation.xml.rels';
  const presentation = 'ppt/presentation.xml';
  for (const data of [
    Buffer.from('not a zip'),
    zip({ ...parts, [relsPath]: parts[relsPath].replace('slide3.xml', 'absent.xml') }),
    zip({ ...parts, [relsPath]: parts[relsPath].replace('Target=', 'TargetMode="External" Target=') }),
    zip({ ...parts, [presentation]: '<!DOCTYPE doc [<!ENTITY item "example">]>' + parts[presentation] }),
    zip({ ...parts, [presentation]: parts[presentation].slice(0, -1) }),
    zip({ ...parts, [presentation]: ' '.repeat(512 * 1024) + parts[presentation] })
  ]) {
    const result = await observe(data);
    assert.deepEqual(result, { sha256: 'sha256:' + createHash('sha256').update(data).digest('hex') });
  }
});
