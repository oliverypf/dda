import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { hashBuildArtifact } from '../src/decision/pptx-metadata.mjs';
import { checkpointDeliverables, prepareDeliverableVerification, requestedDeliverables } from '../src/deliverable-verifier.mjs';
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

test('named delivery checks real files, generation and presentation structure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resolveFile = async path => {
    const absolutePath = join(directory, path);
    return { absolutePath, metadata: await stat(absolutePath) };
  };
  const prepare = prompt => prepareDeliverableVerification({ prompt, resolveFile, startedAtMs: Date.now() - 1000 });
  const path = 'report.pptx';
  const xml = '<sld xmlns="' + main + '" xmlns:a="' + base + '/drawingml/2006/main"><a:t>Sources</a:t><a:t>OECD Statistics</a:t></sld>';
  const valid = zip({ ...parts, 'ppt/slides/slide3.xml': xml });
  await writeFile(join(directory, path), valid);
  const verify = await prepare('Create report.pptx with 1 slide. End with a sources slide.');
  const actions = [{ name: 'shell.execute', state: 'SUCCEEDED',
    processWindow: { startedAtMs: Date.now() - 100, endedAtMs: Date.now() + 60000 } }];
  assert.equal((await verify({ actions, onVerifiedPresentation: () => assert.fail('unattributed deck supplied to semantic verifier') }))[0].status, 'FAIL', 'an existing deck plus a successful process is insufficient');
  await writeFile(join(directory, path), 'not an archive');
  assert.match((await verify({ actions }))[0].message, /格式/);
  const write = data => ({ actions: [{ name: 'file.write', state: 'SUCCEEDED', path, contentDigest: 'sha256:' + createHash('sha256').update(data).digest('hex') }] });
  await writeFile(join(directory, path), zip(parts));
  assert.match((await verify(write(zip(parts))))[0].message, /来源/);
  const shellDelivery = await prepare('生成 five.pptx，共一页');
  const startedAtMs = Date.now() - 250;
  await writeFile(join(directory, 'five.pptx'), valid);
  const artifactReceipts = [];
  const completed = { name: 'shell.execute', state: 'SUCCEEDED', processWindow: { startedAtMs, endedAtMs: Date.now() + 250 } };
  await shellDelivery({ actions: [completed], onProcessArtifact: file => artifactReceipts.push(file) });
  assert.deepEqual(artifactReceipts.map(({ path, sha256, sizeBytes, disposition, pptx }) => ({ path, sha256, sizeBytes, disposition, pptx })),
    [{ path: 'five.pptx', sha256: write(valid).actions[0].contentDigest, sizeBytes: valid.length, disposition: 'GENERATED', pptx: { slideCount: 1, entryCount: 6 } }]);
  const oldDelivery = await prepare('生成 five.pptx，共一页');
  await oldDelivery({ actions: [completed], onProcessArtifact: () => assert.fail('unchanged input inherited a new build receipt') });
  const verifyReferences = await prepare('生成 report.pptx，末页列实际使用的仓库原始路径及官方 URL。');
  await writeFile(join(directory, 'README.md'), 'repo source');
  for (const [text, expected] of [
    ['README.md https://nodejs.org/api/', 'PASS'], ['README.md', 'FAIL'],
    ['missing.mjs https://nodejs.org/api/', 'FAIL'], ['README.md https://example.org/', 'FAIL']
  ]) {
    const deck = zip({ ...parts, 'ppt/slides/slide3.xml': xml.replace('Sources', '资料索引').replace('OECD Statistics', text) });
    await writeFile(join(directory, path), deck);
    assert.equal((await verifyReferences(write(deck)))[0].status, expected, text);
  }
  const linkedDeck = zip({ ...parts,
    'ppt/slides/slide3.xml': xml.replace('Sources', 'README.md').replace('OECD Statistics', 'Node')
      .replace('</sld>', '<a:hlinkClick xmlns:r="' + rel + '" r:id="url1"/></sld>'),
    'ppt/slides/_rels/slide3.xml.rels': root + '<Relationship Id="url1" TargetMode="External" Type="' + rel + '/hyperlink" Target="https://nodejs.org/"/></Relationships>' });
  await writeFile(join(directory, path), linkedDeck);
  assert.equal((await verifyReferences(write(linkedDeck)))[0].status, 'PASS');
  const wrongCount = await prepare('生成 report.pptx，要求三页，最后一页为来源。');
  await writeFile(join(directory, path), valid);
  assert.match((await wrongCount(write(valid)))[0].message, /页数/);
  assert.equal((await verify(write(valid)))[0].status, 'PASS');
  const json = await prepare('Read input.json and create report.json from it.');
  assert.match((await json({ actions: [] }))[0].message, /没有可核对/);
  await writeFile(join(directory, 'report.json'), '{broken');
  assert.match((await json({ actions: [{ ...write('{broken').actions[0], path: 'report.json' }] }))[0].message, /格式/);
  assert.deepEqual(requestedDeliverables('Read report.pptx and report its slide count'), []);
  assert.deepEqual(requestedDeliverables('如何生成 report.pptx？'), []);
  assert.deepEqual(requestedDeliverables('写一个介绍这个项目的 pptx').map(s => s.extension), ['.pptx']);
  assert.deepEqual(requestedDeliverables('怎么写一个介绍这个项目的 pptx？'), []);
  assert.deepEqual(requestedDeliverables('生成 a.txt、b.json，读取 inputs.csv').map(spec => spec.path), ['a.txt', 'b.json']);

  const goal = 'Create report.pptx with 1 slide. End with a sources slide.';
  const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
  const goalDigest = digest(goal), checkpointDigest = digest('point');
  const oldEvents = [
    { runId: 'original', kind: 'TaskRunCreated', payload: { requestedMode: 'CONTROLLED', promptDigest: goalDigest } },
    { runId: 'original', kind: 'DeliverableFileVerified', payload: { path, contentDigest: digest(valid), goalDigest } },
    { runId: 'original', kind: 'ThreadCheckpointCommitted', payload: { threadId: 'thread', checkpointDigest, checkpoint: { runId: 'original' } } },
    { runId: 'original', kind: 'DeliverableFileVerified', payload: { path, contentDigest: digest('later file version'), goalDigest } },
    { runId: 'original', kind: 'DeliverableFileVerified', payload: { path: 'later.pptx', contentDigest: digest(valid), goalDigest } },
    { runId: 'retry', kind: 'TaskRunCreated', payload: { requestedMode: 'CONTROLLED', promptDigest: goalDigest,
      sourceRunId: 'original', sourceCheckpointDigest: checkpointDigest } },
    { runId: 'retry', kind: 'ThreadCheckpointCommitted', payload: { threadId: 'thread', checkpointDigest, checkpoint: { runId: 'retry' } } }
  ];
  const options = { events: oldEvents, sourceRunId: 'retry', checkpointDigest, threadId: 'thread', goalDigest };
  const recoveredFiles = checkpointDeliverables(options);
  assert.deepEqual(recoveredFiles, [{ path, digest: digest(valid) }]);
  assert.deepEqual(checkpointDeliverables({ ...options, threadId: 'unrelated' }), []);
  assert.deepEqual(checkpointDeliverables({ ...options, goalDigest: digest('different') }), []);
  const resumed = await prepareDeliverableVerification({ prompt: goal, resolveFile, startedAtMs: Date.now(), recoveredFiles });
  assert.equal((await resumed())[0].status, 'PASS');
  await writeFile(join(directory, path), zip(parts));
  assert.equal((await resumed())[0].status, 'FAIL');

  const twoFiles = await prepare('生成两份 CSV 文件');
  await writeFile(join(directory, 'one.csv'), 'a,b');
  const oneCsv = { name: 'file.write', state: 'SUCCEEDED', path: 'one.csv', contentDigest: digest('a,b') };
  assert.equal((await twoFiles({ actions: [oneCsv] }))[0].status, 'FAIL');
  await writeFile(join(directory, 'two.csv'), 'c,d');
  assert.equal((await twoFiles({ actions: [oneCsv, { ...oneCsv, path: 'two.csv', contentDigest: digest('c,d') }] }))[0].status, 'PASS');
});

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

test('deliverable acceptance covers conversions, annotated file lists and output-specific slide requirements', async () => {
  const missing = async () => undefined;
  const examples = [
    ['把 README.md 转成 5 页 PPTX', ['.pptx']],
    ['Convert source.pptx to final.pdf', ['final.pdf']],
    ['分别生成 A.pptx（中文）和 B.pptx（英文）', ['A.pptx', 'B.pptx']],
    ['生成一份 PDF 报告', ['.pdf']], ['请生成一个 Excel 工作簿', ['.xlsx']],
    ['生成 PPTX 和 PDF 各一份', ['.pptx', '.pdf']]
  ];
  for (const [prompt, expected] of examples) {
    assert.deepEqual(requestedDeliverables(prompt).map(item => item.path ?? item.extension), expected, prompt);
    const verify = await prepareDeliverableVerification({ prompt, resolveFile: missing, startedAtMs: 0 });
    assert.deepEqual((await verify({})).map(check => check.status), expected.map(() => 'FAIL'), prompt);
  }
  const [output] = requestedDeliverables('Create report.pptx using the 20 slides in source.pptx. The new deck should contain 5 slides.');
  assert.equal(output.presentation.min, 5);
  assert.equal(output.presentation.max, 5);
  assert.equal(output.presentation.sourcePage, undefined);
  const pair = requestedDeliverables('Create first.pptx with 3 slides. Create second.pptx with 5 slides. End with a sources slide.');
  assert.deepEqual(pair.map(spec => [spec.path, spec.presentation.max, spec.presentation.sourcePage]),
    [['first.pptx', 3, undefined], ['second.pptx', 5, 'last']]);
  for (const prompt of ['Explain how to convert input.txt to a PDF report.', 'Write a JSON response.', '生成 JSON 字符串']) {
    assert.deepEqual(requestedDeliverables(prompt), [], prompt);
  }
});


test('controlled CLI corrects only incidental build-step reporting after generating the presentation', async t => {
  const { createServer } = await import('node:http');
  const { runEvidenceProcess } = await import('../../desktop/scripts/goal-evidence-process.mjs');
  const { emitGoalResponse } = await import('../../desktop/scripts/goal-model-fixture.mjs');
  const { listenOnFetchablePort } = await import('./helpers/listen-loopback.mjs');
  const workspace = await mkdtemp(join(tmpdir(), 'dda-doc-repair-cli-'));
  const output = 'dda-overview.pptx';
  const script = 'build-dda-overview.mjs';
  const deck = zip({ ...parts, 'ppt/slides/slide3.xml': `<sld xmlns="${main}" xmlns:a="${base}/drawingml/2006/main"><a:t>Host slide marker 149</a:t></sld>` });
  await writeFile(join(workspace, 'README.md'), 'Verified project source marker 728');
  await writeFile(join(workspace, script), `import { appendFileSync, writeFileSync } from 'node:fs'; appendFileSync('build-invocations.txt', '1'); writeFileSync('${output}', Buffer.from('${deck.toString('base64')}', 'base64')); console.log('OK: dda-overview.pptx written');`);
  const summary = '`node build-dda-overview.mjs`，cwd 为工作区根目录，exit code 0，耗时按主机计时，stdout 摘要 `OK: dda-overview.pptx written`。';
  const plan = { planId: 'document-plan', steps: [{ stepId: 'read-source', actionKind: 'READ', summary: '读取 README.md' },
    { stepId: 'build-pptx', actionKind: 'EXECUTE', summary: '运行 node build-dda-overview.mjs 生成 dda-overview.pptx', dependencies: ['read-source'] },
    { stepId: 'report', actionKind: 'REPORT', summary: '报告已生成文件', dependencies: ['build-pptx'] }] };
  let approvals = 0, corrections = 0, toolCount, finalDelivery, resuming = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/jev') {
      const answers = {};
      for (const [name, question] of Object.entries(body.questions)) {
        if (name === 'verification' && body.state.action?.stepId === 'report') {
          finalDelivery = question.instructions.context.presentationDelivery;
          if (!resuming) { answers[name] = { choice: 'FAIL', confidence: 0.99 }; continue; }
        }
        const choices = Object.keys(question.criteria);
        const preferred = ['CLARIFY_REPORT', 'full-roles', 'full-executor', 'ALLOW', 'PASS', 'STOP_SUCCESS', 'INSUFFICIENT'];
        const choice = preferred.find(key => choices.includes(key)) ?? choices[0];
        answers[name] = { choice, confidence: 0.99 };
      }
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers }));
    }
    const send = text => emitGoalResponse(res, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    const input = JSON.stringify(body.input);
    if (/Planner role/iu.test(body.instructions)) return send(JSON.stringify(plan));
    if (input.includes('Correct only incidental')) { corrections++; toolCount = (body.tools ?? []).length; return send('["artifact"]'); }
    if (input.includes('Current validated plan step: read-source.')) {
      if (body.input.some(item => item.type === 'function_call_output')) return send('Read project source.');
      return emitGoalResponse(res, { type: 'function_call', id: 'call-read-source', call_id: 'call-read-source', name: 'workspace.read',
        arguments: JSON.stringify({ path: 'README.md' }) });
    }
    if (input.includes('Current validated plan step: build-pptx.')) {
      if (body.input.some(item => item.type === 'function_call_output')) return send(summary);
      return emitGoalResponse(res, { type: 'function_call', id: 'call-build', call_id: 'call-build', name: 'shell.execute',
        arguments: JSON.stringify({ command: 'node', args: [script], cwd: '.' }) });
    }
    return send(resuming ? '交付文件为 dda-overview.pptx。' : '此次没有产生任何文件。');
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = await listenOnFetchablePort(server);
  const config = join(workspace, 'fixture-config.json'), db = join(workspace, 'state.db');
  await writeFile(config, JSON.stringify({ provider: 'openai', protocol: 'responses', model: 'fixture', endpoint: `http://127.0.0.1:${port}/model`, apiKeyEnv: 'DDA_DOC_FIXTURE_KEY',
    decision: { enabled: true, enforce: true, endpoint: `http://127.0.0.1:${port}/jev`, apiKeyEnv: 'DDA_DOC_FIXTURE_KEY' } }));
  const invoke = (extra, prompt) => runEvidenceProcess(process.execPath, ['src/index.mjs', 'task', ...extra, '--workspace', workspace, '--config', config, '--agent-mode', 'multi',
    '--trajectory-store', join(workspace, 'trajectory.jsonl'), '--thread-store', join(workspace, 'threads.json'), '--harness-event-store', db,
    '--execution-mode', 'CONTROLLED', '--events', 'stdout', '--lease-capabilities', 'shell.execute', '--lease-commands', 'node',
    '--prompt', prompt], {
    cwd: new URL('..', import.meta.url), env: { DDA_DOC_FIXTURE_KEY: 'fixture', DDA_DATA_DIR: workspace, DDA_HARNESS_EVENT_STORE: db, DDA_CONTEXT_PROVIDER: 'journal',
      DDA_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', DDA_JEV_ENABLED: '1', DDA_JEV_ENFORCE: '1' }, timeoutMs: 120000,
    onStdoutLine(line, child) {
      const e = JSON.parse(line);
      if (e.runId && typeof e.ok === 'boolean') child.stdin.end();
      if (e.kind !== 'approval.requested') return;
      const a = e.payload, call = JSON.parse(a.commandPreview);
      if (a.capability === 'shell.execute' && call.command === 'node' && JSON.stringify(call.args) === JSON.stringify([script]) && call.cwd === '.') {
        approvals++; child.stdin.write(JSON.stringify({ type: 'approval_response', approved: true, requestId: a.requestId, displayedDigest: a.requestDigest }) + '\n');
      }
    }
  });
  const first = await invoke([], '生成一页介绍项目的中文演示文稿，保存为 dda-overview.pptx。已有生成脚本 build-dda-overview.mjs，请用 node 运行。');
  assert.equal(first.timedOut, false);
  const { threads: [thread] } = JSON.parse(await readFile(join(workspace, 'threads.json'), 'utf8'));
  assert.deepEqual(thread.checkpoint.plan.steps.map(step => step.status), ['SUCCEEDED', 'SUCCEEDED', 'FAILED']);
  assert.ok(finalDelivery?.presentations.length);
  resuming = true;
  finalDelivery = undefined;
  const run = await invoke(['--resume', '--thread-id', thread.id], '继续');
  const terminal = run.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line)).findLast(event => typeof event.ok === 'boolean') ?? {};
  assert.equal(run.timedOut, false, 'The CLI did not return its terminal result');
  assert.equal(terminal.ok, true, JSON.stringify({ error: terminal.error, summary: terminal.verification?.summary, code: run.code }));
  assert.equal(terminal.verification.status, 'PASS');
  assert.ok(approvals <= 1);
  assert.equal(await readFile(join(workspace, 'build-invocations.txt'), 'utf8'), '1');
  assert.deepEqual(finalDelivery?.presentations, [{ path: output, digest: 'sha256:' + createHash('sha256').update(deck).digest('hex'),
    slideCount: 1, pages: [{ page: 1, excerpt: 'Host slide marker 149', truncated: false }] }]);
  assert.match(finalDelivery.prerequisiteReads, /README\.md Verified project source marker 728/u);
  assert.equal(corrections, 1);
  assert.equal(toolCount, 0);
  await rm(workspace, { recursive: true, force: true });
});


test('distinguishes an existing generator from a requested generator script', () => {
  for (const [prompt, expected] of [
    ['生成一页演示文稿，保存为 dda-overview.pptx。已有生成脚本 build-dda-overview.mjs，请用 node 运行。', ['dda-overview.pptx']],
    ['现有的生成脚本 build.mjs，请运行它。', []],
    ['生成一份 PPTX，已有生成脚本 build.mjs 可以运行。', ['.pptx']],
    ['生成一份 PPTX，运行生成脚本 build.mjs 即可。', ['.pptx']],
    ['用现有生成脚本 build.mjs 生成 result.pptx。', ['result.pptx']],
    ['新建生成脚本 build.mjs，再生成 result.pptx。', ['build.mjs', 'result.pptx']],
    ['请生成脚本 build.mjs。', ['build.mjs']],
    ['请编写一个生成脚本 build.mjs。', ['build.mjs']],
    ['已有生成脚本 old.mjs，请新建生成脚本 new.mjs。', ['new.mjs']]
  ]) assert.deepEqual(requestedDeliverables(prompt).map(spec => spec.path ?? spec.extension), expected, prompt);
});

test('declared deliverable specs replace prompt inference', async () => {
  const missing = async () => undefined;
  const empty = await prepareDeliverableVerification({
    prompt: 'Create report.pptx with 1 slide.', declaredSpecs: [], resolveFile: missing, startedAtMs: 0
  });
  assert.deepEqual(await empty({ actions: [] }), []);
  const declared = await prepareDeliverableVerification({
    prompt: '回复：ok', declaredSpecs: [{ path: 'out/report.json' }], resolveFile: missing, startedAtMs: 0
  });
  const checks = await declared({ actions: [] });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'FAIL');
  assert.match(checks[0].message, /没有可核对的交付文件/u);
});
