import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { fromBufferPromise } from 'yauzl';

export const MAX_PPTX_BYTES = 16 * 1024 * 1024;
const maxEntries = 4096;
const maxPartBytes = 512 * 1024;
const maxXmlBytes = 4 * 1024 * 1024;
const presentationNS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const drawingNS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const officeRelNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageNS = 'http://schemas.openxmlformats.org/package/2006';

function requirePart(condition) {
  if (!condition) throw new Error('PPTX_METADATA_UNAVAILABLE');
}

// Read only the OPC parts that establish slide membership. Never resolve a
// relationship outside the package, expand a DTD, or unpack media to disk.
export async function readPptxMetadata(bytes, { includeSlideText = false } = {}) {
  requirePart(bytes.length <= MAX_PPTX_BYTES);
  const zip = await fromBufferPromise(bytes, { strictFileNames: true });
  try {
    requirePart(zip.entryCount <= maxEntries);
    const entries = new Map();
    for await (const entry of zip.eachEntry()) {
      requirePart(!entries.has(entry.fileName) && entries.size < maxEntries);
      entries.set(entry.fileName, entry);
    }
    requirePart(entries.size === zip.entryCount);
    let xmlBytes = 0;
    async function visitPart(path, namespace, rootName, visit, onText) {
      const entry = entries.get(path);
      requirePart(entry && entry.uncompressedSize <= maxPartBytes);
      xmlBytes += entry.uncompressedSize;
      requirePart(xmlBytes <= maxXmlBytes);
      const parts = [];
      let size = 0;
      for await (const chunk of await zip.openReadStreamPromise(entry)) {
        size += chunk.length;
        requirePart(size <= entry.uncompressedSize);
        parts.push(chunk);
      }
      const data = Buffer.concat(parts, size);
      requirePart(size === entry.uncompressedSize && crc32(data) === entry.crc32);
      const parser = new SaxesParser({ xmlns: true });
      const stack = [];
      parser.on('doctype', () => requirePart(false));
      parser.on('opentag', tag => {
        requirePart(stack.length < 128);
        if (!stack.length) requirePart(tag.uri === namespace && tag.local === rootName);
        visit?.(tag, stack);
        stack.push(tag);
      });
      parser.on('closetag', () => stack.pop());
      if (onText) {
        parser.on('text', text => onText(text, stack.at(-1)));
        parser.on('cdata', text => onText(text, stack.at(-1)));
      }
      parser.write(new TextDecoder('utf-8', { fatal: true }).decode(data)).close();
    }
    let mainDocumentCount = 0;
    await visitPart('_rels/.rels', packageNS + '/relationships', 'Relationships', (tag, stack) => {
      if (stack.length !== 1 || tag.uri !== stack[0].uri || tag.local !== 'Relationship'
        || tag.attributes.Type?.value !== officeRelNS + '/officeDocument') return;
      requirePart(!tag.attributes.TargetMode || tag.attributes.TargetMode.value === 'Internal');
      requirePart(['ppt/presentation.xml', '/ppt/presentation.xml'].includes(tag.attributes.Target?.value));
      mainDocumentCount++;
    });
    requirePart(mainDocumentCount === 1);
    let mainContentType = false;
    await visitPart('[Content_Types].xml', packageNS + '/content-types', 'Types', (tag, stack) => {
      if (stack.length === 1 && tag.uri === stack[0].uri && tag.local === 'Override'
        && tag.attributes.PartName?.value === '/ppt/presentation.xml'
        && tag.attributes.ContentType?.value === 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml') mainContentType = true;
    });
    requirePart(mainContentType);
    const targets = new Map();
    await visitPart('ppt/_rels/presentation.xml.rels', packageNS + '/relationships', 'Relationships', (tag, stack) => {
      if (stack.length !== 1 || tag.uri !== stack[0].uri || tag.local !== 'Relationship') return;
      const { Id, Type, Target, TargetMode } = tag.attributes;
      requirePart(Id?.value && !targets.has(Id.value));
      let part;
      if (Type?.value === officeRelNS + '/slide' && (!TargetMode || TargetMode.value === 'Internal')) {
        const target = Target?.value ?? '';
        part = target.startsWith('/') ? target.slice(1) : 'ppt/' + target;
      }
      targets.set(Id.value, part);
    });
    const slides = new Set();
    await visitPart('ppt/presentation.xml', presentationNS, 'presentation', (tag, stack) => {
      if (stack.length !== 2 || stack[1].uri !== presentationNS || stack[1].local !== 'sldIdLst'
        || tag.uri !== presentationNS || tag.local !== 'sldId') return;
      const id = Object.values(tag.attributes).find(attr => attr.uri === officeRelNS && attr.local === 'id');
      const part = targets.get(id?.value);
      requirePart(part && entries.has(part) && !slides.has(part));
      slides.add(part);
    });
    const excerpts = [];
    for (const slide of slides) {
      let excerpt = '';
      await visitPart(slide, presentationNS, 'sld', undefined, includeSlideText ? (text, tag) => {
        if (tag?.uri !== drawingNS || tag.local !== 't' || excerpt.length >= 512) return;
        const run = text.trim().replace(/\s+/gu, ' ');
        if (run) excerpt += ((excerpt ? ' ' : '') + run).slice(0, 512 - excerpt.length);
      } : undefined);
      if (includeSlideText) excerpts.push(excerpt);
    }
    return { slideCount: slides.size, entryCount: entries.size, ...(includeSlideText ? { excerpts } : {}) };
  } finally {
    zip.close();
  }
}

export async function hashBuildArtifact(file, path, size, expectedDigest) {
  const hash = createHash('sha256');
  const bytes = /\.pptx$/iu.test(path) && size <= MAX_PPTX_BYTES ? Buffer.alloc(size) : undefined;
  let offset = 0;
  for await (const chunk of file.createReadStream({ autoClose: false })) {
    hash.update(chunk);
    if (bytes && offset + chunk.length <= size) chunk.copy(bytes, offset);
    offset += chunk.length;
  }
  const sha256 = 'sha256:' + hash.digest('hex');
  if (bytes && size === offset && sha256 === expectedDigest) {
    try { return { sha256, pptx: await readPptxMetadata(bytes) }; }
    catch { /* Unsupported or malformed packages still have an observed digest. */ }
  }
  return { sha256 };
}
