import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import { sanitizeOutput } from './runtime-safety-monitor.mjs';
import { crc32 } from 'node:zlib';
import { SaxesParser } from 'saxes';
import { fromBufferPromise } from 'yauzl';
import { MAX_PPTX_BYTES, readPptxMetadata } from './decision/pptx-metadata.mjs';
import { RECOVERY_LINEAGE_RUN_LIMIT } from './side-effect-step-reconcile.mjs';

const makeOutput = /\b(?:create|generate|produce|export|save|write|deliver|convert)\b|转换为|转换成|转成|转为|生成|创建|新建|制作|编写(?=(?:一个|一份|个)?\s*(?:生成|导出)脚本)|写入|写出|导出|保存为|另存为|交付|(?:做|写)一?(?:份|个)/giu;
const inputCue = /(?:\b(?:from|based on|using|by reading|read|inspect|about|explaining|summarizing|without changing)\b|基于|根据|参照|读取|使用(?!的)|不要修改|不改动|(?:已有|现有|既有)(?:的)?\s*(?:生成|导出|构建)?脚本|(?:运行|执行|调用)\s*(?:生成|导出|构建)脚本)/iu;
const destinationCue = /(?:\b(?:as|into|named|called|save to|output to)\b|另存为|保存到|保存为|输出到|命名为|文件名为)/giu;
const names = /[`“"']([^`”"'<>|\r\n]+?\.[a-z][a-z0-9]{0,11})[`”"']|((?:[a-z]:[\\/]|[\\/]{1,2})?(?:[\p{L}\p{N}_.@+-]+[\\/])*[\p{L}\p{N}_.@+-]+\.[a-z][a-z0-9]{0,11})(?![\p{Script=Latin}\d_])/giu;
const documentationRequest = /(?:\b(?:how (?:do|to|can)|explain|instructions? (?:on|for)|do not|don't|without|never)\b|如何|怎样|怎么|请勿|不要|不用|无需|不必|示例命令|命令示例)/iu;
const presentationKind = /(?:\b(?:pptx?|slide decks?|slides|powerpoint|presentations?)\b|演示文稿|幻灯片|PPTX?)/iu;
const numberToken = '(\\d+|[一二两三四五六七八九十百]+)';

function quantity(token) {
  if (/^\d+$/u.test(token)) return Number(token);
  const values = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0, digit = 0;
  for (const c of token) {
    if (c === '十' || c === '百') {
      total += (digit || 1) * (c === '十' ? 10 : 100);
      digit = 0;
    } else digit = values[c];
  }
  return total + digit;
}

function outputPaths(clause) {
  const cues = [...clause.matchAll(destinationCue)];
  const tail = cues.length ? clause.slice(cues.at(-1).index + cues.at(-1)[0].length) : clause;
  const outputs = tail.split(inputCue, 1)[0];
  const paths = [];
  let previousEnd;
  for (const match of outputs.matchAll(names)) {
    const gap = previousEnd === undefined ? '' : outputs.slice(previousEnd, match.index).replace(/（[^（）]*）|\([^()]*\)/gu, '');
    if (previousEnd !== undefined && !/^[\s,，、]*(?:(?:and|also|和|与|以及|及)\s*)*[\s,，、]*$/iu.test(gap)) break;
    paths.push((match[1] ?? match[2]).replaceAll('\\', '/').replace(/^\.\//u, ''));
    previousEnd = match.index + match[0].length;
  }
  return paths;
}

function slideRequirements(prompt) {
  const range = new RegExp(numberToken + '\\s*(?:[-–—~至到]|to)\\s*' + numberToken + '\\s*(?:页|张(?:幻灯片)?|slides?\\b)', 'iu').exec(prompt);
  const count = new RegExp('(?:(至少|不少于|至多|不超过|at least|at most)\\s*)?' + numberToken + '\\s*[- ]?\\s*(?:页|张(?:幻灯片)?|slides?\\b)', 'iu').exec(prompt);
  let min, max;
  if (range) { min = quantity(range[1]); max = quantity(range[2]); }
  else if (count && !/第\s*$/u.test(prompt.slice(0, count.index))) {
    const n = quantity(count[2]);
    if (!/至多|不超过|at most/iu.test(count[1] ?? '')) min = n;
    if (!/至少|不少于|at least/iu.test(count[1] ?? '')) max = n;
  }
  const source = '(?:来源|参考(?:资料|文献)|数据出处|sources?|references?|bibliography|citations?)';
  const last = new RegExp('(?:最后一?页|末页|尾页|(?:final|last|closing) slide|end with)[^。；;\\n]{0,70}' + source + '|' + source + '[^。；;\\n]{0,40}(?:on the (?:last|final) slide|放在末页)', 'iu').test(prompt);
  const lastClause = /(?:最后一?页|末页|尾页|(?:final|last|closing) slide)[^。；;\n]{0,180}/iu.exec(prompt)?.[0] ?? '';
  const requirePath = /(?:仓库|源码|原始|文件)[^。；;\n]{0,12}路径|(?:repository|repo|source file) paths?/iu.test(lastClause);
  const requireUrl = /(?:URL|网址|链接|https? links?)/iu.test(lastClause);
  const sourcePage = last || new RegExp(source + '\\s*(?:页|slide)|(?:slide|页).{0,12}' + source, 'iu').test(prompt);
  return { min, max, sourcePage: last || requirePath || requireUrl ? 'last' : sourcePage ? 'any' : undefined, requirePath, requireUrl };
}

// A file mentioned for reading is input. Only an explicit creation/output clause
// supplies mandatory targets. Executor text can locate a file but cannot prove it.
export function requestedDeliverables(prompt) {
  const paths = new Set();
  const formats = new Map();
  const deckRequirements = new Map();
  let activeDecks = [];
  const appendRules = text => {
    // Strip input descriptions and file names before interpreting slide counts
    // or source-slide requirements. Keep separate output clauses in order.
    const rules = text.split(/[,，]/u).map(part => part.split(inputCue, 1)[0])
      .join(' ').replace(names, ' ');
    for (const key of activeDecks) deckRequirements.set(key, (deckRequirements.get(key) ?? '') + ' ' + rules);
  };
  for (const clause of String(prompt ?? '').replace(/```[\s\S]*?```/gu, '').split(/[。；;！？\n]|(?<=\w)\.\s+/u)) {
    // In 已有生成脚本 and 新建生成脚本, 生成 describes the script. Keep
    // the outer creation verb (if any) and the name in its object.
    const commands = [...clause.matchAll(makeOutput)].filter(match => {
      if (!['生成', '导出'].includes(match[0]) || !/^\s*脚本/u.test(clause.slice(match.index + match[0].length))) return true;
      return !/(?:已有|现有|既有|运行|执行|调用|使用|新建|创建|生成|制作|编写|写一个|写个)(?:的|一个|一份|个)?\s*$/u.test(clause.slice(0, match.index));
    });
    if (!commands.length && !/^\s*(?:the (?:input|source)|输入|原始材料|原文)/iu.test(clause)) appendRules(clause);
    for (const [i, match] of commands.entries()) {
      const prefix = clause.slice(0, match.index);
      if (documentationRequest.test(prefix)
        || /\b(?:script|function|tool|example|instructions?)\s+(?:that|to|which)\s*$|(?:脚本|函数|程序|工具).{0,16}(?:用于|用来|能够|可以)\s*$/iu.test(prefix)) continue;
      let tail = clause.slice(match.index + match[0].length, commands[i + 1]?.index);
      if (/^convert$/iu.test(match[0])) {
        const target = /\b(?:to|into)\b\s+(.+)$/iu.exec(tail);
        if (!target) continue;
        tail = target[1];
      }
      if (/^\s*(?:a |an |the )?(?:script|function|tool|example|instructions?)\s+(?:that|to|which)\b|^(?:一个|一段|个)?(?:脚本|函数|程序|工具)[，,\s]*(?:用于|用来|能够|可以)/iu.test(tail)) continue;
      const named = outputPaths(tail);
      for (const path of named) paths.add(path);
      activeDecks = named.filter(path => extname(path).toLowerCase() === '.pptx');
      const object = tail.split(inputCue, 1)[0].replace(names, ' ');
      const formatNames = new Set();
      if (presentationKind.test(object) || (/\bdeck\b/iu.test(object) && /\bslides?\b/iu.test(tail))) formatNames.add('pptx');
      for (const token of object.matchAll(/\b(json|csv|tsv|txt|md|pdf|docx|xlsx|excel|word)\b/giu)) {
        const term = token[1].toLowerCase();
        const after = object.slice(token.index + term.length);
        const before = object.slice(0, token.index);
        const fileNoun = /^\s*(?:files?\b|documents?\b|reports?\b|workbooks?\b|spreadsheets?\b|文件|文档|报告|工作簿|表格)/iu.test(after);
        const listEnd = /^\s*(?:$|[,.，。]|各一[份个]|and\b|和|与)/iu.test(after);
        if (!fileNoun && (!listEnd || /(?:介绍|解释|关于|\b(?:about|for))\s*$/iu.test(before))) continue;
        if (term === 'word' && !fileNoun) continue;
        formatNames.add(term === 'excel' ? 'xlsx' : term === 'word' ? 'docx' : term);
      }
      for (const format of formatNames) {
        const noun = format === 'pptx' ? '(?:pptx?|presentations?|(?:slide\\s+)?decks?|演示文稿|幻灯片)' : format === 'xlsx' ? '(?:xlsx|excel)' : format;
        const count = new RegExp(numberToken + '\\s*(?:个|份)?\\s*' + noun, 'iu').exec(object);
        formats.set(format, Math.max(formats.get(format) ?? 1, count ? quantity(count[1]) : 1));
        if (format === 'pptx' && !activeDecks.length) activeDecks.push('.pptx');
      }
      appendRules(tail);
    }
  }
  const specs = [...paths].map(path => ({ path, ...(extname(path).toLowerCase() === '.pptx'
    ? { presentation: slideRequirements(deckRequirements.get(path) ?? '') } : {}) }));
  for (const [format, count] of formats) {
    const extension = '.' + format;
    const named = specs.filter(spec => spec.path?.toLowerCase().endsWith(extension)).length;
    if (count > named) specs.push({ extension, count, ...(format === 'pptx' ? { presentation: slideRequirements(deckRequirements.get(extension) ?? '') } : {}) });
  }
  return specs;
}

const key = value => String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
const samePath = (a, b) => process.platform === 'win32' ? key(a).toLowerCase() === key(b).toLowerCase() : key(a) === key(b);
const sameFile = (a, b) => b?.isFile() && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]);
const checked = (id, status, message, evidence = []) => ({ id, status, message, evidence });

async function validateOfficeMainPart(bytes, extension) {
  const isWord = extension === '.docx';
  const part = isWord ? 'word/document.xml' : 'xl/workbook.xml';
  const rootName = isWord ? 'document' : 'workbook';
  const xmlKind = isWord ? 'wordprocessingml' : 'spreadsheetml';
  const zip = await fromBufferPromise(bytes, { strictFileNames: true });
  try {
    if (zip.entryCount > 4096) throw new Error('Office package size limit');
    const names = new Set();
    let mainPart;
    for await (const entry of zip.eachEntry()) {
      if (names.has(entry.fileName)) throw new Error('Duplicate package part');
      names.add(entry.fileName);
      if (entry.fileName === part) mainPart = entry;
    }
    if (!names.has('[Content_Types].xml') || !names.has('_rels/.rels') || !mainPart
      || mainPart.uncompressedSize > 4 * 1024 * 1024) throw new Error('Unsupported Office package');
    const chunks = [];
    let length = 0;
    for await (const chunk of await zip.openReadStreamPromise(mainPart)) {
      length += chunk.length;
      if (length > mainPart.uncompressedSize) throw new Error('Invalid part length');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (crc32(data) !== mainPart.crc32) throw new Error('Invalid part checksum');
    let root;
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => { throw new Error('Unexpected doctype'); });
    parser.on('opentag', tag => { root ??= tag; });
    parser.write(new TextDecoder('utf-8', { fatal: true }).decode(data)).close();
    if (root?.local !== rootName || ![ 'http://schemas.openxmlformats.org/' + xmlKind + '/2006/main',
      'http://purl.oclc.org/ooxml/' + xmlKind + '/main' ].includes(root.uri)) throw new Error('Invalid Office document root');
  } finally { zip.close(); }
}

// resolveFile applies the host's active workspace and protected-path policy both
// before and after reading. No host path or file text goes in the check report.
async function inspect(path, resolveFile, inspectFormat) {
  const target = await resolveFile(path);
  if (!target) return undefined;
  const file = await open(target.absolutePath, 'r');
  try {
    const before = await file.stat();
    if (!sameFile(before, target.metadata)) return undefined;
    const extension = extname(path).toLowerCase();
    const parse = inspectFormat && ['.json', '.pptx', '.docx', '.xlsx', '.pdf'].includes(extension);
    const chunks = [];
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
      if (parse && before.size <= MAX_PPTX_BYTES && size <= before.size) chunks.push(chunk);
    }
    if (size !== before.size || !sameFile(before, await file.stat())
      || !sameFile(before, (await resolveFile(path))?.metadata)) return undefined;
    const identity = process.platform === 'win32' ? target.absolutePath.toLowerCase() : target.absolutePath;
    const result = { path, identity, size, digest: 'sha256:' + hash.digest('hex'), created: before.birthtimeMs, modified: before.mtimeMs };
    if (parse) {
      if (size > MAX_PPTX_BYTES) return { ...result, unverifiable: true };
      try {
        const bytes = Buffer.concat(chunks);
        if (extension === '.pptx') result.deck = await readPptxMetadata(bytes, { includeSlideText: true, includeSourceLinks: true });
        else if (extension === '.json') JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        else if (extension === '.pdf') {
          const trailer = /startxref\s+(\d+)\s+%%EOF\s*$/u.exec(bytes.subarray(-4096).toString('latin1'));
          if (!/^%PDF-\d\.\d/u.test(bytes.subarray(0, 16).toString('latin1')) || !trailer || Number(trailer[1]) >= size) throw new Error('Invalid PDF envelope');
        } else await validateOfficeMainPart(bytes, extension);
      } catch { result.invalid = true; }
    }
    return result;
  } finally { await file.close(); }
}

async function sourceSlide(text, requirements, resolveFile) {
  if (requirements.requireUrl || requirements.requirePath) {
    const urls = /https?:\/\/[^\s<>“”「」【】。，；、）)]+/giu;
    if (requirements.requireUrl && ![...text.matchAll(urls)].some(([value]) => {
      try {
        const url = new URL(value);
        return !url.username && !url.password && /\.[a-z]{2,}$/iu.test(url.hostname)
          && !/(?:^|\.)(?:example\.(?:com|net|org)|test|invalid|localhost)$/iu.test(url.hostname);
      } catch { return false; }
    })) return false;
    if (requirements.requirePath) {
      const matches = text.replace(urls, ' ').matchAll(/(?:^|[\s`「【（(:：])((?:[\w@.+-]+[\\/])*[\w@+-]+\.[a-z][\w-]*)(?=$|[\s`」】）),.，。；;:：])/giu);
      let exists = false;
      for (const [, path] of matches) {
        if (path.split(/[\\/]/u).includes('..')) continue;
        try { if ((await resolveFile(path))?.metadata?.isFile()) { exists = true; break; } } catch { /* Unavailable reference. */ }
      }
      if (!exists) return false;
    }
    return true;
  }
  const heading = /(?:sources?|references?|bibliography|citations?|参考(?:资料|文献)|(?:数据|资料)?来源|数据出处)/iu.exec(text);
  if (!heading) return false;
  const entry = text.slice(heading.index + heading[0].length).replace(/^[\p{P}\s]+/u, '');
  return /[\p{L}\p{N}]{2}/u.test(entry) && !/^(?:TBD|TODO|N\/A|none|待补充|待填写|暂无|无)(?:[.。\s]|$)/iu.test(entry);
}

// Only receipts attached to the exact resumed goal and checkpoint chain can
// stand in for this run's invocation. Every returned digest is re-read below.
export function checkpointDeliverables({ events = [], sourceRunId, checkpointDigest, threadId, goalDigest, onGeneratedFile }) {
  const facts = new Map();
  const visited = new Set();
  const payload = event => event.payload?.payload ?? event.payload ?? {};
  const validDigest = digest => /^sha256:[a-f0-9]{64}$/u.test(digest ?? '');
  const add = (path, digest) => {
    if (typeof path === 'string' && path.length && path.length <= 1024 && validDigest(digest)
      && !facts.has(key(path))) facts.set(key(path), { path, digest });
  };
  while (sourceRunId && validDigest(checkpointDigest) && !visited.has(sourceRunId) && visited.size < RECOVERY_LINEAGE_RUN_LIMIT) {
    visited.add(sourceRunId);
    const run = events.filter(event => event.runId === sourceRunId);
    const creations = run.filter(event => event.kind === 'TaskRunCreated');
    const creation = creations.length === 1 && payload(creations[0]);
    if (!creation || creation.promptDigest !== goalDigest || creation.requestedMode !== 'CONTROLLED') break;
    const checkpointIndex = run.findIndex(event => event.kind === 'ThreadCheckpointCommitted' && payload(event).threadId === threadId
      && payload(event).checkpointDigest === checkpointDigest && payload(event).checkpoint?.runId === sourceRunId);
    if (checkpointIndex <= run.indexOf(creations[0])) break;
    for (const event of run.slice(run.indexOf(creations[0]) + 1, checkpointIndex).reverse()) {
      const data = payload(event);
      if (event.kind === 'TaskFileWritten' && ['file.write', 'file.patch'].includes(data.name) && validDigest(data.outputDigest)) add(data.path, data.contentDigest);
      if (event.kind === 'DeliverableFileVerified' && data.goalDigest === goalDigest) add(data.path, data.contentDigest);
      if (event.kind === 'BuildTestProcessObserved' && data.receipt?.exitCode === 0 && !data.receipt.aborted && !data.receipt.timedOut) {
        for (const file of data.receipt.artifacts ?? []) if (file.disposition === 'GENERATED') {
          add(file.path, file.sha256);
          if (typeof file.path === 'string' && validDigest(file.sha256)) onGeneratedFile?.(file.path, file.sha256);
        }
      }
    }
    sourceRunId = creation.sourceRunId;
    checkpointDigest = creation.sourceCheckpointDigest;
  }
  return [...facts.values()];
}

export async function prepareDeliverableVerification({ prompt, declaredSpecs, resolveFile, startedAtMs, recoveredFiles = [], recordFile }) {
  const specs = Array.isArray(declaredSpecs) ? declaredSpecs : requestedDeliverables(prompt);
  const baseline = new Map();
  for (const { path } of specs) {
    if (path) baseline.set(key(path), await inspect(path, resolveFile, false).catch(() => undefined));
  }
  return async ({ actions = [], receipts = [], answer = '', onProcessArtifact, onVerifiedFile, onVerifiedPresentation } = {}) => {
    if (!specs.length) return [];
    const writes = actions.filter(a => a.state === 'SUCCEEDED' && a.invocationAttempted !== false);
    const fileWrites = writes.filter(a => ['file.write', 'file.patch'].includes(a.name) && a.contentDigest && a.path);
    const recorded = receipts.filter(r => r.exitCode === 0 && !r.aborted && !r.timedOut).flatMap(r => r.artifacts ?? []);
    const windows = writes.filter(a => ['shell.execute', 'test.execute'].includes(a.name) && a.processWindow)
      .map(a => a.processWindow);
    const reported = [...String(answer).matchAll(names)].map(match => key(match[1] ?? match[2]));
    const candidates = [...new Set([...fileWrites, ...recorded, ...recoveredFiles].map(a => key(a.path)).concat(reported))];
    const checks = [];
    for (const spec of specs) {
      const options = spec.path ? [spec.path] : candidates.filter(path => path.toLowerCase().endsWith(spec.extension));
      let outcome;
      const verified = new Set();
      for (const path of options) {
        const file = await inspect(path, resolveFile, true).catch(() => undefined);
        if (!file) continue;
        const original = baseline.get(key(path));
        const receipt = fileWrites.some(a => samePath(a.path, path) && a.contentDigest === file.digest)
          || recorded.some(a => samePath(a.path, path) && a.sha256 === file.digest && a.disposition === 'GENERATED');
        const changed = baseline.has(key(path)) ? original?.digest !== file.digest : file.created >= startedAtMs;
        const processWrite = changed && windows.some(w => Number.isFinite(w.startedAtMs) && Number.isFinite(w.endedAtMs)
          && w.startedAtMs >= startedAtMs && file.modified >= w.startedAtMs - 1 && file.modified < w.endedAtMs + 1);
        const fresh = receipt || processWrite;
        const recovered = recoveredFiles.some(a => samePath(a.path, path) && a.digest === file.digest);
        const evidence = [file.digest];
        let problem;
        if (!fresh && !recovered) problem = '没有此任务写入当前文件版本的证据';
        else if (file.unverifiable) problem = '文件超过当前结构检查的读取上限';
        else if (file.invalid) problem = '文件格式损坏或不受支持';
        else if (spec.presentation) {
          const { min, max, sourcePage } = spec.presentation;
          const { slideCount, excerpts } = file.deck ?? {};
          if (!slideCount || slideCount < (min ?? 1) || slideCount > (max ?? Infinity)) problem = '实际页数 ' + (slideCount ?? 0) + ' 与要求不符';
          else if (sourcePage) {
            const pages = sourcePage === 'last' ? excerpts.slice(-1) : excerpts;
            if (!(await Promise.all(pages.map(text => sourceSlide(text, spec.presentation, resolveFile)))).some(Boolean)) {
              problem = '指定的来源页缺少所需的来源条目、仓库文件路径或 URL';
            }
          }
        }
        outcome = checked('deliverable-' + checks.length, problem ? 'FAIL' : 'PASS', path + ' — ' + (problem ?? '已核对本次交付文件'), evidence);
        if (!problem) {
          onVerifiedFile?.(path, file.digest);
          if (onVerifiedPresentation && file.deck) {
            const { slideCount, excerpts } = file.deck;
            // Preserve slide order and the last slide even when a long deck needs sampling.
            const pages = excerpts.flatMap((text, index) => index < 11 || index === slideCount - 1
              ? [{ page: index + 1, excerpt: sanitizeOutput(text).slice(0, 420), truncated: text.length > 420 }] : []);
            onVerifiedPresentation({ path, digest: file.digest, slideCount, pages });
          }
          if (onProcessArtifact && processWrite && file.deck) {
            onProcessArtifact({ path, absolutePath: file.identity, sizeBytes: file.size, modifiedAtMs: file.modified, sha256: file.digest,
              disposition: 'GENERATED', pptx: { slideCount: file.deck.slideCount, entryCount: file.deck.entryCount } });
          }
          if (fresh && recordFile) await recordFile(path, file.digest);
          verified.add(file.identity);
          if (verified.size >= (spec.count ?? 1)) break;
        }
      }
      if (spec.count > 1 && verified.size < spec.count) {
        outcome = checked('deliverable-' + checks.length, 'FAIL', spec.extension + ' — 已核对 ' + verified.size + ' 个，要求 ' + spec.count + ' 个');
      }
      checks.push(outcome ?? checked('deliverable-' + checks.length, 'FAIL', (spec.path ?? spec.extension) + ' — 没有可核对的交付文件'));
    }
    return checks;
  };
}
