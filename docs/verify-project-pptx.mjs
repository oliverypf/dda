#!/usr/bin/env node
/**
 * docs/verify-project-pptx.mjs —— 独立核验 docs/build-project-pptx.mjs 的产物。
 *
 * 用法（仓库根目录执行）：
 *   node docs/verify-project-pptx.mjs docs/dda-project-intro.pptx
 *   （省略参数时默认核验 docs/dda-project-intro.pptx）
 *
 * 核验不依赖任何第三方库：
 * 1. ZIP 结构：PK 魔数、End of Central Directory、中央目录条目与预期部件清单完全一致；
 * 2. 条目完整性：每个条目 deflate 解压、大小与 CRC-32 全部复核；
 * 3. XML 良构：自研栈式解析器检查全部 XML 部件（处理指令 / 标签配对 / 自闭合）；
 * 4. OOXML 链接：presentation → slideMaster/theme、slide → slideLayout、r:id 全部可解析；
 * 5. 内容契约：12 页标题与 TitlesOfParts 一致，Thread/Turn/Item/Jev/READ_ONLY/PolicyLease
 *    等关键事实必须出现在幻灯片文本中；
 * 6. 元数据与版式：Slides 计数、dc:title、dcterms:created、16:9 尺寸与每页背景。
 *
 * 全部通过时退出码为 0，任何一项失败退出码为 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DOCS = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(DOCS, 'dda-project-intro.pptx');

const EXPECTED_SLIDES = 12;
const DECK_TITLE = 'dda 项目介绍';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const EXPECTED_TITLES = [
  'dda',
  '项目定位',
  '核心概念：Thread / Turn / Item',
  '多平台架构',
  'Windows 桌面客户端',
  'Cordis Runtime',
  '安全模型：默认只读 + 一次性 Lease',
  'Jev Decision Plane',
  '跨平台契约 contracts/v1',
  '测试与验证',
  '路线图与后续工作',
  '谢谢',
];

const REQUIRED_TERMS = [
  'dda', 'Thread', 'Turn', 'Item', 'Tauri', 'HarmonyOS', 'Linux', 'Cordis', 'Jev',
  'READ_ONLY', 'PolicyLease', 'fail closed', 'contracts', 'fixture', '审批',
  'HarnessReadModel', 'hmCodex-local', 'OpenAI Responses', 'JSONL',
];

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- ZIP 解析 ----------
function parseZip(buf, label) {
  if (buf.length < 22) throw new Error(`${label}: 文件太小，不是合法 ZIP`);
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error(`${label}: 缺少 ZIP 本地头魔数（PK\\x03\\x04）`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${label}: 缺少 End of Central Directory 记录`);
  const declared = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < declared; i += 1) {
    if (p + 46 > buf.length) throw new Error(`${label}: 中央目录越界`);
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`${label}: 中央目录签名错误（offset ${p}）`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (entries.has(name)) throw new Error(`${label}: 中央目录存在重复条目 ${name}`);
    entries.set(name, { method, crc, compSize, uncompSize, lho });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.size !== declared) throw new Error(`${label}: EOCD 声明 ${declared} 条，实际解析 ${entries.size} 条`);
  return entries;
}

function readEntryBuf(buf, entry, name) {
  const { lho } = entry;
  if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`${name}: 本地文件头损坏`);
  const nameLen = buf.readUInt16LE(lho + 26);
  const extraLen = buf.readUInt16LE(lho + 28);
  const dataStart = lho + 30 + nameLen + extraLen;
  if (dataStart + entry.compSize > buf.length) throw new Error(`${name}: 数据区越界`);
  const comp = buf.subarray(dataStart, dataStart + entry.compSize);
  let raw;
  if (entry.method === 0) raw = Buffer.from(comp);
  else if (entry.method === 8) {
    try {
      raw = zlib.inflateRawSync(comp);
    } catch {
      throw new Error(`${name}: deflate 解压失败`);
    }
  } else throw new Error(`${name}: 不支持的压缩方法 ${entry.method}`);
  if (raw.length !== entry.uncompSize) throw new Error(`${name}: 解压后大小 ${raw.length} ≠ 声明 ${entry.uncompSize}`);
  if (crc32(raw) !== entry.crc) throw new Error(`${name}: CRC-32 校验失败`);
  return raw;
}

// ---------- XML 工具 ----------
function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function slideTexts(xml) {
  const out = [];
  const re = /<a:t>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml))) out.push(xmlUnescape(m[1]));
  return out;
}

function attrOf(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function parseRelationships(xml) {
  const map = new Map();
  const re = /<Relationship\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    map.set(attrOf(tag, 'Id'), { type: attrOf(tag, 'Type'), target: attrOf(tag, 'Target') });
  }
  return map;
}

function resolveTarget(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(path.posix.join(baseDir, target));
}

function assertWellFormed(xml, label) {
  const stack = [];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new Error(`${label}: 未闭合的处理指令（offset ${lt}）`);
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new Error(`${label}: 未闭合的注释（offset ${lt}）`);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error(`${label}: 未闭合的 CDATA（offset ${lt}）`);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('</', lt)) {
      const gt = xml.indexOf('>', lt);
      if (gt === -1) throw new Error(`${label}: 结束标签未闭合（offset ${lt}）`);
      const name = xml.slice(lt + 2, gt).trim();
      const top = stack.pop();
      if (top !== name) throw new Error(`${label}: 结束标签 </${name}> 与 <${top ?? '??'} 不匹配（offset ${lt}）`);
      i = gt + 1;
      continue;
    }
    let gt = -1;
    let q = null;
    for (let j = lt + 1; j < n; j += 1) {
      const ch = xml[j];
      if (q) {
        if (ch === q) q = null;
      } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '>') {
        gt = j;
        break;
      }
    }
    if (gt === -1) throw new Error(`${label}: 开始标签未闭合（offset ${lt}）`);
    const inner = xml.slice(lt + 1, gt);
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.slice(0, -1) : inner;
    const nameMatch = body.match(/^([A-Za-z_][\w.:-]*)/);
    if (!nameMatch) throw new Error(`${label}: 标签名非法（offset ${lt}）`);
    if (!selfClose) stack.push(nameMatch[1]);
    i = gt + 1;
  }
  if (stack.length) throw new Error(`${label}: 未闭合的元素栈：${stack.join(', ')}`);
}

// ---------- 预期部件清单 ----------
function expectedParts(n) {
  const base = [
    '[Content_Types].xml',
    '_rels/.rels',
    'docProps/core.xml',
    'docProps/app.xml',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slideMasters/slideMaster1.xml',
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    'ppt/slideLayouts/slideLayout1.xml',
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    'ppt/theme/theme1.xml',
  ];
  for (let i = 1; i <= n; i += 1) {
    base.push(`ppt/slides/slide${i}.xml`, `ppt/slides/_rels/slide${i}.xml.rels`);
  }
  return base;
}

// ---------- 主流程 ----------
function main() {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT;
  const rel = path.relative(process.cwd(), target).replace(/\\/g, '/');

  if (!fs.existsSync(target)) {
    process.stderr.write(`找不到待核验的 pptx：${target}\n`);
    process.exitCode = 1;
    return;
  }
  const buf = fs.readFileSync(target);

  let entries;
  try {
    entries = parseZip(buf, rel);
  } catch (error) {
    process.stderr.write(`ZIP 结构解析失败：${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const raw = new Map();
  const results = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, ok: true, detail });
    } catch (error) {
      results.push({ name, ok: false, detail: String(error.message || error) });
    }
  };
  const part = (name) => {
    const data = raw.get(name);
    if (!data) throw new Error(`缺少部件：${name}`);
    return data.toString('utf8');
  };

  check('zip-结构与部件清单', () => {
    const expected = expectedParts(EXPECTED_SLIDES);
    const missing = expected.filter((n) => !entries.has(n));
    if (missing.length) throw new Error(`缺少 ${missing.length} 个部件：${missing.slice(0, 5).join('、')}`);
    const extra = [...entries.keys()].filter((n) => !expected.includes(n));
    if (extra.length) throw new Error(`存在 ${extra.length} 个意外部件：${extra.slice(0, 5).join('、')}`);
    return `${expected.length} 个条目与预期清单完全一致`;
  });

  check('zip-条目完整性', () => {
    for (const [name, entry] of entries) raw.set(name, readEntryBuf(buf, entry, name));
    return `${entries.size} 个条目全部通过解压、大小与 CRC-32 校验`;
  });

  check('xml-良构', () => {
    let count = 0;
    for (const [name, data] of raw) {
      if (!name.endsWith('.xml')) continue;
      assertWellFormed(data.toString('utf8'), name);
      count += 1;
    }
    if (count === 0) throw new Error('没有任何 XML 部件');
    return `${count} 个 XML 部件全部良构`;
  });

  check('content-types-覆盖', () => {
    const ct = part('[Content_Types].xml');
    if (!ct.includes('<Default Extension="rels"')) throw new Error('缺少 Default rels');
    if (!ct.includes('<Default Extension="xml"')) throw new Error('缺少 Default xml');
    const overrides = [...ct.matchAll(/<Override PartName="([^"]+)" ContentType="([^"]+)"\/>/g)];
    const required = [
      '/ppt/presentation.xml',
      '/ppt/slideMasters/slideMaster1.xml',
      '/ppt/slideLayouts/slideLayout1.xml',
      '/ppt/theme/theme1.xml',
      '/docProps/core.xml',
      '/docProps/app.xml',
      ...Array.from({ length: EXPECTED_SLIDES }, (_, i) => `/ppt/slides/slide${i + 1}.xml`),
    ];
    const got = new Set(overrides.map((m) => m[1]));
    const missing = required.filter((p) => !got.has(p));
    if (missing.length) throw new Error(`缺少 Override：${missing.slice(0, 5).join('、')}`);
    for (const m of overrides) {
      const partName = m[1].slice(1);
      if (!raw.has(partName)) throw new Error(`Override 指向不存在的部件：${partName}`);
    }
    return `Default rels/xml 与 ${required.length} 个 Override 全部覆盖实际部件`;
  });

  check('presentation-幻灯片清单', () => {
    const pres = part('ppt/presentation.xml');
    const presRels = parseRelationships(part('ppt/_rels/presentation.xml.rels'));
    const ids = [...pres.matchAll(/<p:sldId id="(\d+)" r:id="(rId\d+)"\/>/g)];
    if (ids.length !== EXPECTED_SLIDES) throw new Error(`sldIdLst 应有 ${EXPECTED_SLIDES} 项，实际 ${ids.length}`);
    ids.forEach((m, i) => {
      const idNum = Number(m[1]);
      if (idNum !== 256 + i) throw new Error(`第 ${i + 1} 张 sldId 应为 ${256 + i}，实际 ${idNum}`);
      const rel = presRels.get(m[2]);
      if (!rel) throw new Error(`sldId r:id ${m[2]} 无法解析`);
      const target = resolveTarget('ppt', rel.target);
      if (target !== `ppt/slides/slide${i + 1}.xml` || !raw.has(target)) {
        throw new Error(`第 ${i + 1} 张幻灯片目标异常：${target}`);
      }
    });
    return `${EXPECTED_SLIDES} 张幻灯片按 sldId 256..${255 + EXPECTED_SLIDES} 顺序引用且目标存在`;
  });

  check('母版-布局-主题链接', () => {
    const presRels = parseRelationships(part('ppt/_rels/presentation.xml.rels'));
    const masterRel = [...presRels.values()].find((r) => r.type === `${REL_BASE}/slideMaster`);
    if (!masterRel) throw new Error('presentation 缺少 slideMaster 关系');
    const masterTarget = resolveTarget('ppt', masterRel.target);
    if (!raw.has(masterTarget)) throw new Error(`slideMaster 目标不存在：${masterTarget}`);
    const layoutRels = parseRelationships(part('ppt/slideLayouts/_rels/slideLayout1.xml.rels'));
    const toMaster = [...layoutRels.values()].find((r) => r.type === `${REL_BASE}/slideMaster`);
    if (!toMaster) throw new Error('slideLayout 缺少指回 slideMaster 的关系');
    if (resolveTarget('ppt/slideLayouts', toMaster.target) !== 'ppt/slideMasters/slideMaster1.xml') {
      throw new Error(`slideLayout 指向异常：${toMaster.target}`);
    }
    const masterRels = parseRelationships(part('ppt/slideMasters/_rels/slideMaster1.xml.rels'));
    const toTheme = [...masterRels.values()].find((r) => r.type === `${REL_BASE}/theme`);
    if (!toTheme) throw new Error('slideMaster 缺少 theme 关系');
    if (resolveTarget('ppt/slideMasters', toTheme.target) !== 'ppt/theme/theme1.xml') {
      throw new Error(`slideMaster 的 theme 目标异常：${toTheme.target}`);
    }
    const toLayout = [...masterRels.values()].find((r) => r.type === `${REL_BASE}/slideLayout`);
    if (!toLayout || resolveTarget('ppt/slideMasters', toLayout.target) !== 'ppt/slideLayouts/slideLayout1.xml') {
      throw new Error('slideMaster 缺少或指向异常的 slideLayout 关系');
    }
    return 'presentation → slideMaster、layout → master、master → theme/layout 全部可解析';
  });

  check('幻灯片布局引用', () => {
    for (let i = 1; i <= EXPECTED_SLIDES; i += 1) {
      const rels = parseRelationships(part(`ppt/slides/_rels/slide${i}.xml.rels`));
      if (rels.size !== 1) throw new Error(`slide${i} 的关系数量应为 1，实际 ${rels.size}`);
      const rel = rels.get('rId1');
      if (!rel || rel.type !== `${REL_BASE}/slideLayout`) throw new Error(`slide${i} 缺少 slideLayout 关系`);
      if (resolveTarget('ppt/slides', rel.target) !== 'ppt/slideLayouts/slideLayout1.xml') {
        throw new Error(`slide${i} 布局目标异常：${rel.target}`);
      }
    }
    return `${EXPECTED_SLIDES} 张幻灯片均唯一引用 slideLayout1`;
  });

  check('幻灯片标题与正文', () => {
    const app = part('docProps/app.xml');
    const lpstr = [...app.matchAll(/<vt:lpstr>([\s\S]*?)<\/vt:lpstr>/g)].map((m) => xmlUnescape(m[1]));
    if (lpstr.length !== EXPECTED_SLIDES + 1) {
      throw new Error(`TitlesOfParts 应为 ${EXPECTED_SLIDES + 1} 项，实际 ${lpstr.length}`);
    }
    if (lpstr[0] !== DECK_TITLE) throw new Error(`TitlesOfParts 首项应为「${DECK_TITLE}」，实际「${lpstr[0]}」`);
    lpstr.slice(1).forEach((t, i) => {
      if (t !== EXPECTED_TITLES[i]) throw new Error(`TitlesOfParts 第 ${i + 2} 项应为「${EXPECTED_TITLES[i]}」，实际「${t}」`);
    });
    for (let i = 1; i <= EXPECTED_SLIDES; i += 1) {
      const xml = part(`ppt/slides/slide${i}.xml`);
      const texts = slideTexts(xml);
      const joined = texts.join(' ');
      const title = EXPECTED_TITLES[i - 1];
      if (!joined.includes(title)) throw new Error(`slide${i} 未包含声明标题「${title}」`);
      const hero = title === 'dda' || title === '谢谢';
      if (texts.length < (hero ? 3 : 5)) throw new Error(`slide${i} 文本 run 数量过少：${texts.length}`);
      if (texts.some((t) => t.trim() === '')) throw new Error(`slide${i} 存在空文本 run`);
    }
    return `${EXPECTED_SLIDES} 页标题与 TitlesOfParts 一致，正文非空`;
  });

  check('app-core-元数据', () => {
    const app = part('docProps/app.xml');
    const slidesProp = app.match(/<Slides>(\d+)<\/Slides>/);
    if (!slidesProp || Number(slidesProp[1]) !== EXPECTED_SLIDES) throw new Error('app.xml Slides 计数异常');
    const core = part('docProps/core.xml');
    if (!core.includes(`<dc:title>${DECK_TITLE}</dc:title>`)) throw new Error('core.xml 缺少 dc:title');
    const created = core.match(/<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/);
    if (!created || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(created[1])) {
      throw new Error('core.xml 缺少合法的 dcterms:created');
    }
    return `Slides=${EXPECTED_SLIDES}，dc:title=${DECK_TITLE}，created=${created[1]}`;
  });

  check('关键事实覆盖', () => {
    const all = Array.from({ length: EXPECTED_SLIDES }, (_, i) =>
      slideTexts(part(`ppt/slides/slide${i + 1}.xml`)).join(' ')
    ).join('\n');
    const missing = REQUIRED_TERMS.filter((t) => !all.includes(t));
    if (missing.length) throw new Error(`缺失关键事实：${missing.join('、')}`);
    return `${REQUIRED_TERMS.length} 个关键事实全部覆盖`;
  });

  check('幻灯片尺寸与背景', () => {
    const pres = part('ppt/presentation.xml');
    if (!pres.includes('<p:sldSz cx="12192000" cy="6858000"/>')) {
      throw new Error('presentation.xml 幻灯片尺寸不是 16:9（12192000x6858000）');
    }
    for (let i = 1; i <= EXPECTED_SLIDES; i += 1) {
      if (!part(`ppt/slides/slide${i}.xml`).includes('<p:bg>')) throw new Error(`slide${i} 缺少背景定义`);
    }
    return `16:9 尺寸正确，${EXPECTED_SLIDES} 页均含深色背景`;
  });

  for (const r of results) {
    process.stdout.write(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.name} — ${r.detail}\n`);
  }

  const failed = results.filter((r) => !r.ok);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const summary = {
    status: failed.length ? 'FAIL' : 'PASS',
    file: rel,
    bytes: buf.length,
    slides: EXPECTED_SLIDES,
    checks: results.length,
    failures: failed.length,
    sha256,
  };
  process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  const testResult = {
    version: 1,
    tests: results.length,
    pass: results.length - failed.length,
    fail: failed.length,
    suites: ['PPTX structure and project content'],
  };
  process.stdout.write(`DDA_TEST_RESULT ${JSON.stringify(testResult)}\n`);
  if (failed.length) {
    process.stderr.write(`核验失败：${failed.length} 项检查未通过（${rel}）\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`核验通过：${results.length} 项检查全部通过（${rel}）\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`核验异常：${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
